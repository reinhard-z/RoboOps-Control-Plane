import {
  type CausationId,
  type CommandEnvelopeV1,
  type CommandId,
  type CommandPayload,
  type CommandType,
  type CorrelationId,
  type IdempotencyKey,
  type IsoTimestamp,
  type MissionId,
  type Pose2D,
  type ProtocolValidationIssue,
  type RobotId,
  type SafetyClass,
  protocolSchemaVersions,
  validateCommandPayload
} from "@roboops/fleet-protocol";

import { appendGeneratedRecords, createAuditEvent, createDomainEvent } from "./events.js";
import {
  type DomainConfig,
  defaultDomainConfig,
  isActiveMission,
  isRiskyCommand
} from "./policies.js";
import type {
  DomainState,
  DomainTransition,
  MissionSnapshot,
  RobotSnapshot
} from "./state.js";
import { parseTimestamp } from "./time.js";

export type DispatchRejectionReason =
  | "COMMAND_EXPIRED"
  | "COMMAND_TTL_INVALID"
  | "COMMAND_TYPE_NOT_ALLOWED"
  | "COMMAND_PAYLOAD_INVALID"
  | "DUPLICATE_COMMAND_ID"
  | "IDEMPOTENCY_KEY_REUSE_CONFLICT"
  | "LOW_BATTERY"
  | "RECONCILIATION_IN_PROGRESS"
  | "ROBOT_ALREADY_ASSIGNED"
  | "ROBOT_TELEMETRY_STALE";

export type DispatchMissionResult =
  | {
      readonly status: "ACCEPTED";
      readonly command: CommandEnvelopeV1;
      readonly mission: MissionSnapshot;
    }
  | {
      readonly status: "IDEMPOTENT_REPLAY";
      readonly command: CommandEnvelopeV1;
      readonly mission: MissionSnapshot;
    }
  | {
      readonly status: "REJECTED";
      readonly reason: DispatchRejectionReason;
      readonly mission?: MissionSnapshot;
      readonly issues?: readonly ProtocolValidationIssue[];
    };

/** Operator request fields needed to create and validate one outbound command. */
export interface DispatchMissionCommandInput {
  readonly commandId: CommandId;
  readonly missionId: MissionId;
  readonly robotId: RobotId;
  readonly type: CommandType;
  readonly idempotencyKey: IdempotencyKey;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId;
  readonly payload: CommandPayload;
  readonly now: IsoTimestamp;
  readonly requiresAck?: boolean;
  readonly safetyClass?: SafetyClass;
}

/** Validates and dispatches a mission command, enforcing idempotency, TTL, sequencing, and safety gates. */
export function dispatchMissionCommand(
  state: DomainState,
  input: DispatchMissionCommandInput,
  config: DomainConfig = defaultDomainConfig
): DomainTransition<DispatchMissionResult> {
  const payloadSignature = createPayloadSignature(input);
  const idempotencyRecord = state.idempotencyRecords[input.idempotencyKey];
  if (idempotencyRecord) {
    if (idempotencyRecord.payloadSignature !== payloadSignature) {
      return rejectDispatchWithoutMission(
        state,
        input,
        "IDEMPOTENCY_KEY_REUSE_CONFLICT",
        { existingCommandId: idempotencyRecord.commandId }
      );
    }

    const command = state.commands[idempotencyRecord.commandId];
    const mission = state.missions[idempotencyRecord.missionId];
    if (command && mission) {
      return {
        state,
        result: { status: "IDEMPOTENT_REPLAY", command, mission },
        auditEvents: [],
        domainEvents: []
      };
    }
  }

  if (state.commands[input.commandId]) {
    return rejectDispatch(
      state,
      input,
      "DUPLICATE_COMMAND_ID",
      "REJECTED",
      {}
    );
  }

  if (!config.allowedCommandTypes.includes(input.type)) {
    return rejectDispatch(
      state,
      input,
      "COMMAND_TYPE_NOT_ALLOWED",
      "REJECTED",
      { commandType: input.type }
    );
  }

  const payloadValidation = validateCommandPayload(input.type, input.payload);
  if (!payloadValidation.valid) {
    return rejectDispatch(
      state,
      input,
      "COMMAND_PAYLOAD_INVALID",
      "REJECTED",
      { issues: payloadValidation.issues },
      payloadValidation.issues
    );
  }

  const issuedAtMs = parseTimestamp(input.issuedAt);
  const expiresAtMs = parseTimestamp(input.expiresAt);
  const nowMs = parseTimestamp(input.now);
  if (expiresAtMs <= nowMs) {
    return rejectDispatch(
      state,
      input,
      "COMMAND_EXPIRED",
      "REJECTED",
      { expiresAt: input.expiresAt, now: input.now }
    );
  }

  if (expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > config.maxCommandTtlMs) {
    return rejectDispatch(
      state,
      input,
      "COMMAND_TTL_INVALID",
      "REJECTED",
      { issuedAt: input.issuedAt, expiresAt: input.expiresAt }
    );
  }

  const robot = state.robots[input.robotId];
  const isRisky = isRiskyCommand(input.type, input.safetyClass ?? "NORMAL");
  if (isRisky && (!robot || robot.connectionState !== "ONLINE")) {
    return rejectDispatch(
      state,
      input,
      "ROBOT_TELEMETRY_STALE",
      "SAFETY_BLOCKED",
      { connectionState: robot?.connectionState ?? "UNKNOWN" }
    );
  }

  if (
    isRisky &&
    robot?.batteryPercent !== undefined &&
    robot.batteryPercent < config.lowBatteryPercent
  ) {
    return rejectDispatch(
      state,
      input,
      "LOW_BATTERY",
      "SAFETY_BLOCKED",
      { batteryPercent: robot.batteryPercent, threshold: config.lowBatteryPercent }
    );
  }

  if (robot?.activeMissionId && robot.activeMissionId !== input.missionId) {
    const activeMission = state.missions[robot.activeMissionId];
    if (activeMission && isActiveMission(activeMission.lifecycleState)) {
      return rejectDispatch(
        state,
        input,
        "ROBOT_ALREADY_ASSIGNED",
        "SAFETY_BLOCKED",
        { activeMissionId: robot.activeMissionId }
      );
    }
  }

  if (robot?.connectionState === "RECONNECTING") {
    return rejectDispatch(
      state,
      input,
      "RECONCILIATION_IN_PROGRESS",
      "SAFETY_BLOCKED",
      { connectionState: robot.connectionState }
    );
  }

  const sequence = state.nextSequenceByRobot[input.robotId] ?? 1;
  const command: CommandEnvelopeV1 = {
    schemaVersion: protocolSchemaVersions.commandEnvelope,
    commandId: input.commandId,
    missionId: input.missionId,
    robotId: input.robotId,
    type: input.type,
    idempotencyKey: input.idempotencyKey,
    sequence,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    requiresAck: input.requiresAck ?? true,
    safetyClass: input.safetyClass ?? "NORMAL",
    correlationId: input.correlationId,
    causationId: input.causationId,
    payload: input.payload
  };

  const targetPose = targetPoseForCommand(input.type, input.payload);
  const mission: MissionSnapshot = {
    missionId: input.missionId,
    robotId: input.robotId,
    lifecycleState: "DISPATCHED",
    operationalStatus: "NOMINAL",
    ...(targetPose ? { targetPose } : {}),
    createdAt: input.now,
    updatedAt: input.now,
    currentCommandId: input.commandId,
    lastCommandSequence: sequence,
    idempotencyKey: input.idempotencyKey
  };

  const nextRobot = robot
    ? {
        ...robot,
        activeMissionId: input.missionId,
        updatedAt: input.now
      }
    : {
        robotId: input.robotId,
        connectionState: "ONLINE",
        activeMissionId: input.missionId,
        updatedAt: input.now,
        lastSeenCommandSequence: 0
      } satisfies RobotSnapshot;

  const event = createDomainEvent(state, {
    eventType: "mission.command.dispatched",
    aggregateType: "mission",
    aggregateId: mission.missionId,
    occurredAt: input.now,
    receivedAt: input.now,
    correlationId: input.correlationId,
    causationId: input.causationId,
    payload: {
      commandId: command.commandId,
      robotId: command.robotId,
      sequence: command.sequence
    }
  });
  const audit = createAuditEvent(state, {
    actorType: "operator",
    action: "mission.command.dispatched",
    occurredAt: input.now,
    missionId: input.missionId,
    robotId: input.robotId,
    commandId: input.commandId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    details: {
      commandType: input.type,
      sequence
    }
  });

  const nextState = appendGeneratedRecords(
    {
      ...state,
      missions: {
        ...state.missions,
        [mission.missionId]: mission
      },
      robots: {
        ...state.robots,
        [nextRobot.robotId]: nextRobot
      },
      commands: {
        ...state.commands,
        [command.commandId]: command
      },
      idempotencyRecords: {
        ...state.idempotencyRecords,
        [input.idempotencyKey]: {
          idempotencyKey: input.idempotencyKey,
          payloadSignature,
          commandId: input.commandId,
          missionId: input.missionId
        }
      },
      nextSequenceByRobot: {
        ...state.nextSequenceByRobot,
        [input.robotId]: sequence + 1
      }
    },
    [event],
    [audit]
  );

  return {
    state: nextState,
    result: { status: "ACCEPTED", command, mission },
    auditEvents: [audit],
    domainEvents: [event]
  };
}

/** Rejects a duplicate idempotency conflict without overwriting the original mission record. */
function rejectDispatchWithoutMission(
  state: DomainState,
  input: DispatchMissionCommandInput,
  reason: DispatchRejectionReason,
  details: Record<string, unknown>,
  issues?: readonly ProtocolValidationIssue[]
): DomainTransition<DispatchMissionResult> {
  const event = createDomainEvent(state, {
    eventType: "mission.command.rejected",
    aggregateType: "mission",
    aggregateId: input.missionId,
    occurredAt: input.now,
    receivedAt: input.now,
    correlationId: input.correlationId,
    causationId: input.causationId,
    payload: {
      reason,
      ...details
    }
  });
  const audit = createAuditEvent(state, {
    actorType: "system",
    action: "mission.command.rejected",
    occurredAt: input.now,
    missionId: input.missionId,
    robotId: input.robotId,
    commandId: input.commandId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    details: {
      reason,
      ...details
    }
  });

  const nextState = appendGeneratedRecords(state, [event], [audit]);

  return {
    state: nextState,
    result: {
      status: "REJECTED",
      reason,
      ...(issues ? { issues } : {})
    },
    auditEvents: [audit],
    domainEvents: [event]
  };
}

/** Records a rejected dispatch as a terminal mission snapshot plus audit/domain events. */
function rejectDispatch(
  state: DomainState,
  input: DispatchMissionCommandInput,
  reason: DispatchRejectionReason,
  lifecycleState: "REJECTED" | "SAFETY_BLOCKED",
  details: Record<string, unknown>,
  issues?: readonly ProtocolValidationIssue[]
): DomainTransition<DispatchMissionResult> {
  const targetPose = targetPoseForCommand(input.type, input.payload);
  const mission: MissionSnapshot = {
    missionId: input.missionId,
    robotId: input.robotId,
    lifecycleState,
    operationalStatus: "DEGRADED",
    ...(targetPose ? { targetPose } : {}),
    createdAt: input.now,
    updatedAt: input.now,
    idempotencyKey: input.idempotencyKey,
    failureReason: reason
  };
  const event = createDomainEvent(state, {
    eventType: "mission.command.rejected",
    aggregateType: "mission",
    aggregateId: input.missionId,
    occurredAt: input.now,
    receivedAt: input.now,
    correlationId: input.correlationId,
    causationId: input.causationId,
    payload: {
      reason,
      ...details
    }
  });
  const audit = createAuditEvent(state, {
    actorType: "system",
    action: "mission.command.rejected",
    occurredAt: input.now,
    missionId: input.missionId,
    robotId: input.robotId,
    commandId: input.commandId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    details: {
      reason,
      ...details
    }
  });

  const nextState = appendGeneratedRecords(
    {
      ...state,
      missions: {
        ...state.missions,
        [mission.missionId]: mission
      }
    },
    [event],
    [audit]
  );

  return {
    state: nextState,
    result: {
      status: "REJECTED",
      reason,
      mission,
      ...(issues ? { issues } : {})
    },
    auditEvents: [audit],
    domainEvents: [event]
  };
}

/** Extracts the GO_TO_POSE target for snapshots that drive the operator map. */
function targetPoseForCommand(
  type: CommandType,
  payload: CommandPayload
): Pose2D | undefined {
  if (type !== "GO_TO_POSE") {
    return undefined;
  }

  const target = (payload as { readonly target?: unknown }).target;
  return isPose2D(target) ? target : undefined;
}

/** Validates protocol pose shape before copying optional target data into snapshots. */
function isPose2D(value: unknown): value is Pose2D {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Number.isFinite((value as { readonly x?: unknown }).x) &&
    Number.isFinite((value as { readonly y?: unknown }).y) &&
    Number.isFinite((value as { readonly theta?: unknown }).theta)
  );
}

/** Produces the canonical idempotency comparison payload for operator requests. */
function createPayloadSignature(input: DispatchMissionCommandInput): string {
  return stableSerialize({
    missionId: input.missionId,
    robotId: input.robotId,
    type: input.type,
    payload: input.payload
  });
}

/** Serializes objects with sorted keys so semantically identical payloads compare equal. */
function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`);
  return `{${entries.join(",")}}`;
}
