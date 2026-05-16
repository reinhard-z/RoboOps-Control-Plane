import type {
  CommandAckV1,
  CommandEnvelopeV1,
  CorrelationId,
  IsoTimestamp,
  MissionId,
  MissionLifecycleState,
} from "@roboops/fleet-protocol";

import {
  appendGeneratedRecords,
  createAuditEvent,
  createDomainEvent,
} from "./events.js";
import { isActiveMission } from "./policies.js";
import type {
  DomainState,
  DomainTransition,
  MissionSnapshot,
  RobotSnapshot,
} from "./state.js";
import { parseTimestamp } from "./time.js";

export type CommandAckResult =
  | { readonly status: "PROCESSED"; readonly mission: MissionSnapshot }
  | { readonly status: "DUPLICATE_IGNORED" }
  | { readonly status: "STALE_IGNORED"; readonly command: CommandEnvelopeV1 }
  | { readonly status: "UNKNOWN_COMMAND" };

export type MissionTimeoutResult =
  | { readonly status: "TIMED_OUT"; readonly mission: MissionSnapshot }
  | { readonly status: "NOT_EXPIRED"; readonly mission: MissionSnapshot }
  | {
      readonly status: "NOT_WAITING_FOR_ACK";
      readonly mission: MissionSnapshot;
    }
  | { readonly status: "UNKNOWN_MISSION" };

/** Applies an edge acknowledgement and advances the mission only when the ack is new and not stale. */
export function applyCommandAck(
  state: DomainState,
  ack: CommandAckV1,
): DomainTransition<CommandAckResult> {
  if (state.processedAckIds.includes(ack.ackId)) {
    return {
      state,
      result: { status: "DUPLICATE_IGNORED" },
      auditEvents: [],
      domainEvents: [],
    };
  }

  // Resolve the command first so unknown or replayed acks cannot mutate mission state.
  const command = state.commands[ack.commandId];
  if (!command) {
    return {
      state: {
        ...state,
        processedAckIds: [...state.processedAckIds, ack.ackId],
      },
      result: { status: "UNKNOWN_COMMAND" },
      auditEvents: [],
      domainEvents: [],
    };
  }

  // The command owns the mission relationship; ignore acks when that link is missing.
  const mission = state.missions[command.missionId];
  if (!mission) {
    return {
      state: {
        ...state,
        processedAckIds: [...state.processedAckIds, ack.ackId],
      },
      result: { status: "UNKNOWN_COMMAND" },
      auditEvents: [],
      domainEvents: [],
    };
  }

  // Older sequence acks are stale and must not roll the mission back.
  const lastAcknowledgedSequence = mission.lastAcknowledgedCommandSequence ?? 0;
  if (ack.lastSeenCommandSequence < lastAcknowledgedSequence) {
    return {
      state: {
        ...state,
        processedAckIds: [...state.processedAckIds, ack.ackId],
      },
      result: { status: "STALE_IGNORED", command },
      auditEvents: [],
      domainEvents: [],
    };
  }

  // Use the edge acknowledgement receive time as the domain transition time.
  const now = ack.receivedAt;

  // Command type matters because accepted cancel acks terminate the mission.
  const nextLifecycle = lifecycleFromAckStatus(ack.status, command);

  // Mission progress records the ack result while keeping lifecycle and health separate.
  const nextMission: MissionSnapshot = {
    ...mission,
    lifecycleState: nextLifecycle,
    operationalStatus: ack.status === "ACCEPTED" ? "NOMINAL" : "DEGRADED",
    updatedAt: now,
    lastAcknowledgedCommandId: ack.commandId,
    lastAcknowledgedCommandSequence: ack.lastSeenCommandSequence,
    ...(ack.reason ? { failureReason: ack.reason } : {}),
  };

  // Robot progress follows the highest sequence acknowledged or seen by the edge.
  const currentRobot = state.robots[command.robotId];
  const nextRobot: RobotSnapshot = currentRobot
    ? {
        robotId: currentRobot.robotId,
        connectionState: "ONLINE",
        updatedAt: now,
        ...(currentRobot.pose ? { pose: currentRobot.pose } : {}),
        ...(currentRobot.health ? { health: currentRobot.health } : {}),
        ...(currentRobot.batteryPercent !== undefined
          ? { batteryPercent: currentRobot.batteryPercent }
          : {}),
        ...(isActiveMission(nextMission.lifecycleState)
          ? { activeMissionId: nextMission.missionId }
          : {}),
        ...(currentRobot.lastTelemetryObservedAt
          ? { lastTelemetryObservedAt: currentRobot.lastTelemetryObservedAt }
          : {}),
        ...(currentRobot.lastTelemetryReceivedAt
          ? { lastTelemetryReceivedAt: currentRobot.lastTelemetryReceivedAt }
          : {}),
        lastAcknowledgedCommandId: ack.commandId,
        lastSeenCommandSequence: Math.max(
          currentRobot.lastSeenCommandSequence,
          ack.lastSeenCommandSequence,
        ),
        ...(currentRobot.edgeAgentVersion
          ? { edgeAgentVersion: currentRobot.edgeAgentVersion }
          : {}),
      }
    : ({
        robotId: command.robotId,
        connectionState: "ONLINE",
        activeMissionId: nextMission.missionId,
        lastAcknowledgedCommandId: ack.commandId,
        lastSeenCommandSequence: ack.lastSeenCommandSequence,
        updatedAt: now,
      } satisfies RobotSnapshot);

  // Domain events are machine-facing records for API streams and future persistence.
  const event = createDomainEvent(state, {
    eventType: "mission.command.acked",
    aggregateType: "command",
    aggregateId: ack.commandId,
    occurredAt: now,
    receivedAt: now,
    correlationId: ack.correlationId,
    causationId: ack.causationId,
    payload: {
      status: ack.status,
      commandType: command.type,
      lifecycleState: nextMission.lifecycleState,
      missionId: nextMission.missionId,
      robotId: ack.robotId,
      sequence: ack.lastSeenCommandSequence,
    },
  });

  // Audit events are operator-facing records explaining the state transition.
  const audit = createAuditEvent(state, {
    actorType: "edge",
    action: "mission.command.acked",
    occurredAt: now,
    missionId: nextMission.missionId,
    robotId: ack.robotId,
    commandId: ack.commandId,
    correlationId: ack.correlationId,
    causationId: ack.causationId,
    details: {
      status: ack.status,
      commandType: command.type,
      lifecycleState: nextMission.lifecycleState,
      sequence: ack.lastSeenCommandSequence,
    },
  });

  // Persist the ack decision, robot snapshot, and emitted records atomically in memory.
  const nextState = appendGeneratedRecords(
    {
      ...state,
      missions: {
        ...state.missions,
        [nextMission.missionId]: nextMission,
      },
      robots: {
        ...state.robots,
        [nextRobot.robotId]: nextRobot,
      },
      processedAckIds: [...state.processedAckIds, ack.ackId],
    },
    [event],
    [audit],
  );

  return {
    state: nextState,
    result: { status: "PROCESSED", mission: nextMission },
    auditEvents: [audit],
    domainEvents: [event],
  };
}

/** Marks a dispatched mission as timed out when its command expires before acknowledgement. */
export function applyMissionTimeout(
  state: DomainState,
  input: {
    readonly missionId: MissionId;
    readonly now: IsoTimestamp;
    readonly correlationId: CorrelationId;
  },
): DomainTransition<MissionTimeoutResult> {
  // Timeouts are mission-scoped because only the platform knows which command is pending.
  const mission = state.missions[input.missionId];
  if (!mission) {
    return {
      state,
      result: { status: "UNKNOWN_MISSION" },
      auditEvents: [],
      domainEvents: [],
    };
  }

  if (mission.lifecycleState !== "DISPATCHED" || !mission.currentCommandId) {
    return {
      state,
      result: { status: "NOT_WAITING_FOR_ACK", mission },
      auditEvents: [],
      domainEvents: [],
    };
  }

  // A timeout only applies once the pending command's expiry has actually passed.
  const command = state.commands[mission.currentCommandId];
  if (
    !command ||
    parseTimestamp(command.expiresAt) > parseTimestamp(input.now)
  ) {
    return {
      state,
      result: { status: "NOT_EXPIRED", mission },
      auditEvents: [],
      domainEvents: [],
    };
  }

  // Timeout degrades the mission and records a terminal lifecycle state.
  const nextMission: MissionSnapshot = {
    ...mission,
    lifecycleState: "TIMED_OUT",
    operationalStatus: "DEGRADED",
    updatedAt: input.now,
    failureReason: "command expired before acknowledgement",
  };
  // Emit a durable domain event for timeout consumers and streams.
  const event = createDomainEvent(state, {
    eventType: "mission.command.timeout",
    aggregateType: "mission",
    aggregateId: input.missionId,
    occurredAt: input.now,
    receivedAt: input.now,
    correlationId: input.correlationId,
    causationId: mission.currentCommandId,
    payload: {
      commandId: mission.currentCommandId,
    },
  });
  // Emit an audit event so operators can see why the mission stopped progressing.
  const audit = createAuditEvent(state, {
    actorType: "system",
    action: "mission.command.timeout",
    occurredAt: input.now,
    missionId: input.missionId,
    robotId: mission.robotId,
    commandId: mission.currentCommandId,
    correlationId: input.correlationId,
    causationId: mission.currentCommandId,
    details: {
      expiresAt: command?.expiresAt ?? null,
    },
  });

  // Store the terminal mission snapshot together with its generated records.
  const nextState = appendGeneratedRecords(
    {
      ...state,
      missions: {
        ...state.missions,
        [nextMission.missionId]: nextMission,
      },
    },
    [event],
    [audit],
  );

  return {
    state: nextState,
    result: { status: "TIMED_OUT", mission: nextMission },
    auditEvents: [audit],
    domainEvents: [event],
  };
}

/** Maps edge ack status into the mission lifecycle state used by the domain reducer. */
function lifecycleFromAckStatus(
  status: CommandAckV1["status"],
  command: CommandEnvelopeV1,
): MissionLifecycleState {
  if (status === "ACCEPTED" || status === "DUPLICATE") {
    if (command.type === "CANCEL_MISSION") {
      return "CANCELLED";
    }
    return "RUNNING";
  }
  if (status === "EXPIRED") {
    return "TIMED_OUT";
  }
  if (status === "REJECTED") {
    return "REJECTED";
  }
  return "FAILED";
}
