import { randomUUID } from "node:crypto";

import {
  type CommandEnvelopeV1,
  type CommandPayload,
  type Pose2D,
  isKnownCommandType,
  protocolSchemaVersions,
  safetyClasses,
  validateCommandPayload
} from "@roboops/fleet-protocol";

import type {
  CloudEdgeSimulatorConfig,
  SimulatorEdgeMessage,
  SimulatorPlatformMessage,
  SimulatorState,
  SimulatorStep
} from "./types.js";

type PlatformErrorPayload = Extract<
  SimulatorPlatformMessage,
  { readonly type: "platform.error" }
>["payload"];

type ParsePlatformMessageResult =
  | { readonly ok: true; readonly value: SimulatorPlatformMessage }
  | { readonly ok: false; readonly reason: string };

/** Creates the initial robot model for a new simulator process. */
export function createInitialSimulatorState(
  config: CloudEdgeSimulatorConfig,
  now: string = nowIso()
): SimulatorState {
  return {
    robotId: config.robotId,
    edgeSessionId: createSimulatorId("edge_session"),
    edgeAgentVersion: config.edgeAgentVersion,
    scenario: config.scenario,
    pose: { x: 0, y: 0, theta: 0 },
    batteryPercent: 80,
    lastSeenCommandSequence: 0,
    lastTelemetryObservedAt: now,
    reconnectHandshakeSent: false
  };
}

/** Builds the hello message sent immediately after every WebSocket connection opens. */
export function createHelloMessage(state: SimulatorState): SimulatorEdgeMessage {
  return {
    type: "edge.hello",
    payload: {
      edgeSessionId: state.edgeSessionId,
      edgeAgentVersion: state.edgeAgentVersion,
      lastSeenCommandSequence: state.lastSeenCommandSequence
    }
  };
}

/** Parses a raw platform WebSocket JSON value into the subset supported by the simulator. */
export function parsePlatformMessage(value: unknown): ParsePlatformMessageResult {
  if (!isRecord(value)) {
    return { ok: false, reason: "platform message must be an object" };
  }

  const type = value["type"];
  if (type === "platform.ping") {
    return {
      ok: true,
      value: {
        type: "platform.ping",
        payload: { sentAt: readPlatformPingSentAt(value["payload"]) }
      }
    };
  }
  if (type === "platform.error") {
    return {
      ok: true,
      value: {
        type: "platform.error",
        payload: readPlatformError(value["payload"])
      }
    };
  }
  if (type !== "platform.command") {
    return { ok: false, reason: "unsupported platform message type" };
  }

  const command = parseCommandEnvelope(value["payload"]);
  if (!command.ok) {
    return command;
  }

  return {
    ok: true,
    value: { type: "platform.command", payload: command.value }
  };
}

/** Handles one validated platform message and returns outbound edge messages plus runtime actions. */
export function handlePlatformMessage(
  state: SimulatorState,
  message: SimulatorPlatformMessage,
  now: string = nowIso()
): SimulatorStep {
  if (message.type === "platform.ping") {
    return { state, outbound: [], actions: [] };
  }

  if (message.type === "platform.error") {
    return {
      state,
      outbound: [],
      actions: [
        {
          kind: "log",
          message: `platform error ${message.payload.code}: ${message.payload.message}`
        }
      ]
    };
  }

  return handleCommand(state, message.payload, now);
}

/** Creates one telemetry heartbeat from the current simulator state. */
export function createTelemetryMessage(
  state: SimulatorState,
  now: string = nowIso()
): SimulatorStep {
  const nextPose = state.targetPose
    ? stepPoseTowardTarget(state.pose, state.targetPose)
    : state.pose;
  const nextState: SimulatorState = {
    ...state,
    pose: nextPose,
    lastTelemetryObservedAt: now
  };

  return {
    state: nextState,
    outbound: [
      {
        type: "edge.telemetry",
        payload: {
          schemaVersion: protocolSchemaVersions.robotTelemetry,
          eventId: createSimulatorId("telemetry"),
          robotId: nextState.robotId,
          observedAt: now,
          receivedAt: now,
          pose: nextState.pose,
          batteryPercent: nextState.batteryPercent,
          health: "OK",
          connectionState: "ONLINE",
          ...(nextState.currentMissionId
            ? { currentMissionId: nextState.currentMissionId }
            : {}),
          ...(nextState.lastAcknowledgedCommandId
            ? { lastAcknowledgedCommandId: nextState.lastAcknowledgedCommandId }
            : {}),
          lastSeenCommandSequence: nextState.lastSeenCommandSequence,
          edgeAgentVersion: nextState.edgeAgentVersion
        }
      }
    ],
    actions: []
  };
}

/** Creates a reconnect handshake when the simulator reconnect scenario has a mission to report. */
export function createReconnectHandshakeMessage(
  state: SimulatorState,
  now: string = nowIso()
): SimulatorStep {
  const nextState: SimulatorState = {
    ...state,
    edgeSessionId: createSimulatorId("edge_session"),
    reconnectHandshakeSent: true,
    lastTelemetryObservedAt: now
  };

  if (!nextState.currentMissionId || !nextState.lastAcknowledgedCommandId) {
    return { state: nextState, outbound: [], actions: [] };
  }

  return {
    state: nextState,
    outbound: [
      {
        type: "edge.reconnect_handshake",
        payload: {
          schemaVersion: protocolSchemaVersions.reconnectHandshake,
          robotId: nextState.robotId,
          edgeSessionId: nextState.edgeSessionId,
          connectedAt: now,
          lastSeenCommandSequence: nextState.lastSeenCommandSequence,
          lastAcknowledgedCommandId: nextState.lastAcknowledgedCommandId,
          reportedMissionId: nextState.currentMissionId,
          reportedMissionLifecycleState:
            nextState.reportedMissionLifecycleState ?? "RUNNING",
          lastTelemetryObservedAt: now,
          edgeAgentVersion: nextState.edgeAgentVersion
        }
      }
    ],
    actions: [{ kind: "start_telemetry" }]
  };
}

/** Applies one command and returns the ack plus scenario-specific follow-up actions. */
function handleCommand(
  state: SimulatorState,
  command: CommandEnvelopeV1,
  now: string
): SimulatorStep {
  if (command.robotId !== state.robotId) {
    return {
      state,
      outbound: [
        createCommandAck(
          command,
          now,
          "REJECTED",
          `command robotId ${command.robotId} does not match simulator robotId ${state.robotId}`
        )
      ],
      actions: [
        {
          kind: "log",
          message: `rejecting command for robot ${command.robotId} on simulator robot ${state.robotId}`
        }
      ]
    };
  }

  if (command.type !== "GO_TO_POSE" && command.type !== "CANCEL_MISSION") {
    const nextState = noteSeenCommand(state, command, now);
    return {
      state: nextState,
      outbound: [
        createCommandAck(
          command,
          now,
          "REJECTED",
          `unsupported simulator command type: ${command.type}`
        )
      ],
      actions: [
        {
          kind: "log",
          message: `ignoring unsupported command ${command.type}`
        }
      ]
    };
  }

  const nextState = applyAcceptedCommand(state, command, now);
  const actions =
    command.type === "CANCEL_MISSION"
      ? [{ kind: "start_telemetry" as const }]
      : actionsForGoToPose(nextState);

  return {
    state: nextState,
    outbound: [createCommandAck(command, now, "ACCEPTED")],
    actions
  };
}

/** Records that the edge received a command even when it cannot execute it. */
function noteSeenCommand(
  state: SimulatorState,
  command: CommandEnvelopeV1,
  now: string
): SimulatorState {
  return {
    ...state,
    lastSeenCommandSequence: Math.max(
      state.lastSeenCommandSequence,
      command.sequence
    ),
    lastTelemetryObservedAt: now
  };
}

/** Updates the local robot model after accepting a platform command. */
function applyAcceptedCommand(
  state: SimulatorState,
  command: CommandEnvelopeV1,
  now: string
): SimulatorState {
  if (command.type === "CANCEL_MISSION") {
    const {
      currentMissionId: _currentMissionId,
      targetPose: _targetPose,
      ...idleState
    } = state;

    return {
      ...idleState,
      lastSeenCommandSequence: Math.max(
        state.lastSeenCommandSequence,
        command.sequence
      ),
      lastAcknowledgedCommandId: command.commandId,
      reportedMissionLifecycleState: "CANCELLED",
      lastTelemetryObservedAt: now
    };
  }

  const targetPose = readGoToPoseTarget(command.payload) ?? state.targetPose;
  return {
    ...state,
    ...(targetPose ? { targetPose } : {}),
    currentMissionId: command.missionId,
    reportedMissionLifecycleState: "RUNNING",
    lastSeenCommandSequence: Math.max(
      state.lastSeenCommandSequence,
      command.sequence
    ),
    lastAcknowledgedCommandId: command.commandId,
    lastTelemetryObservedAt: now,
    reconnectHandshakeSent: false
  };
}

/** Maps the configured fault scenario into runtime actions after a motion command ack. */
function actionsForGoToPose(state: SimulatorState): SimulatorStep["actions"] {
  if (state.scenario === "stale-telemetry") {
    return [{ kind: "stop_telemetry" }];
  }
  if (state.scenario === "reconnect" && !state.reconnectHandshakeSent) {
    return [{ kind: "stop_telemetry" }, { kind: "disconnect_for_reconnect" }];
  }
  return [{ kind: "start_telemetry" }];
}

/** Builds a valid edge acknowledgement for the command. */
function createCommandAck(
  command: CommandEnvelopeV1,
  now: string,
  status: "ACCEPTED" | "REJECTED",
  reason?: string
): SimulatorEdgeMessage {
  return {
    type: "edge.command_ack",
    payload: {
      schemaVersion: protocolSchemaVersions.commandAck,
      ackId: createSimulatorId("ack"),
      commandId: command.commandId,
      missionId: command.missionId,
      robotId: command.robotId,
      status,
      receivedAt: now,
      lastSeenCommandSequence: command.sequence,
      ...(reason ? { reason } : {}),
      correlationId: command.correlationId,
      causationId: command.commandId
    }
  };
}

/** Performs conservative runtime validation of command envelopes from the platform. */
function parseCommandEnvelope(value: unknown):
  | { readonly ok: true; readonly value: CommandEnvelopeV1 }
  | { readonly ok: false; readonly reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "command payload must be an object" };
  }

  const type = value["type"];
  if (typeof type !== "string" || !isKnownCommandType(type)) {
    return { ok: false, reason: "command type is not supported by protocol" };
  }

  const payload = value["payload"];
  const payloadValidation = validateCommandPayload(type, payload);
  if (!payloadValidation.valid) {
    return { ok: false, reason: "command payload is invalid" };
  }

  const requiredStrings = [
    "schemaVersion",
    "commandId",
    "missionId",
    "robotId",
    "idempotencyKey",
    "issuedAt",
    "expiresAt",
    "correlationId",
    "causationId"
  ] as const;
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      return { ok: false, reason: `${key} is required` };
    }
  }
  if (value["schemaVersion"] !== protocolSchemaVersions.commandEnvelope) {
    return { ok: false, reason: "command schema version is unsupported" };
  }
  if (!Number.isInteger(value["sequence"]) || Number(value["sequence"]) < 1) {
    return { ok: false, reason: "sequence must be a positive integer" };
  }
  if (typeof value["requiresAck"] !== "boolean") {
    return { ok: false, reason: "requiresAck must be a boolean" };
  }
  if (
    typeof value["safetyClass"] !== "string" ||
    !safetyClasses.includes(value["safetyClass"] as CommandEnvelopeV1["safetyClass"])
  ) {
    return { ok: false, reason: "safetyClass must be a known safety class" };
  }

  return {
    ok: true,
    value: {
      schemaVersion: protocolSchemaVersions.commandEnvelope,
      commandId: value["commandId"] as string,
      missionId: value["missionId"] as string,
      robotId: value["robotId"] as string,
      type,
      idempotencyKey: value["idempotencyKey"] as string,
      sequence: Number(value["sequence"]),
      issuedAt: value["issuedAt"] as string,
      expiresAt: value["expiresAt"] as string,
      requiresAck: value["requiresAck"] as boolean,
      safetyClass: value["safetyClass"] as CommandEnvelopeV1["safetyClass"],
      correlationId: value["correlationId"] as string,
      causationId: value["causationId"] as string,
      payload: payload as CommandPayload
    }
  };
}

/** Reads the platform ping timestamp if it is present and well-shaped. */
function readPlatformPingSentAt(payload: unknown): string {
  if (!isRecord(payload) || typeof payload["sentAt"] !== "string") {
    return "";
  }
  return payload["sentAt"];
}

/** Reads a platform error payload while tolerating malformed server-side details. */
function readPlatformError(payload: unknown): PlatformErrorPayload {
  if (!isRecord(payload)) {
    return {
      code: "PLATFORM_ERROR",
      message: "platform sent an error"
    };
  }

  const code =
    typeof payload["code"] === "string" ? payload["code"] : "PLATFORM_ERROR";
  const message =
    typeof payload["message"] === "string"
      ? payload["message"]
      : "platform sent an error";
  const correlationId =
    typeof payload["correlationId"] === "string"
      ? payload["correlationId"]
      : undefined;

  return {
    code,
    message,
    ...(correlationId ? { correlationId } : {})
  };
}

/** Extracts the GO_TO_POSE target after protocol validation has confirmed its shape. */
function readGoToPoseTarget(payload: CommandPayload): Pose2D | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const target = payload["target"];
  if (!isRecord(target)) {
    return undefined;
  }
  const { x, y, theta } = target;
  if (
    typeof x === "number" &&
    typeof y === "number" &&
    typeof theta === "number"
  ) {
    return { x, y, theta };
  }
  return undefined;
}

/** Moves the reported pose a little on each heartbeat so the demo is visibly alive. */
function stepPoseTowardTarget(current: Pose2D, target: Pose2D): Pose2D {
  return {
    x: stepNumber(current.x, target.x),
    y: stepNumber(current.y, target.y),
    theta: stepNumber(current.theta, target.theta, 0.08)
  };
}

/** Advances one scalar toward a target without overshooting it. */
function stepNumber(current: number, target: number, maxStep = 0.25): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxStep) {
    return target;
  }
  return Number((current + Math.sign(delta) * maxStep).toFixed(4));
}

/** Creates sortable-enough local ids for simulator-generated protocol records. */
function createSimulatorId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

/** Returns the current wall-clock time in protocol timestamp format. */
function nowIso(): string {
  return new Date().toISOString();
}

/** Checks whether a value is a non-array JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
