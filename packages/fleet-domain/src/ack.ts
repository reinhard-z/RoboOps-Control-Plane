import type {
  CommandAckV1,
  CommandEnvelopeV1,
  CorrelationId,
  IsoTimestamp,
  MissionId,
  MissionLifecycleState
} from "@roboops/fleet-protocol";

import { appendGeneratedRecords, createAuditEvent, createDomainEvent } from "./events.js";
import { isActiveMission } from "./policies.js";
import type {
  DomainState,
  DomainTransition,
  MissionSnapshot,
  RobotSnapshot
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
  | { readonly status: "NOT_WAITING_FOR_ACK"; readonly mission: MissionSnapshot }
  | { readonly status: "UNKNOWN_MISSION" };

/** Applies an edge acknowledgement and advances the mission only when the ack is new and not stale. */
export function applyCommandAck(
  state: DomainState,
  ack: CommandAckV1
): DomainTransition<CommandAckResult> {
  if (state.processedAckIds.includes(ack.ackId)) {
    return {
      state,
      result: { status: "DUPLICATE_IGNORED" },
      auditEvents: [],
      domainEvents: []
    };
  }

  const command = state.commands[ack.commandId];
  if (!command) {
    return {
      state: { ...state, processedAckIds: [...state.processedAckIds, ack.ackId] },
      result: { status: "UNKNOWN_COMMAND" },
      auditEvents: [],
      domainEvents: []
    };
  }

  const mission = state.missions[command.missionId];
  if (!mission) {
    return {
      state: { ...state, processedAckIds: [...state.processedAckIds, ack.ackId] },
      result: { status: "UNKNOWN_COMMAND" },
      auditEvents: [],
      domainEvents: []
    };
  }

  const lastAcknowledgedSequence = mission.lastAcknowledgedCommandSequence ?? 0;
  if (ack.lastSeenCommandSequence < lastAcknowledgedSequence) {
    return {
      state: { ...state, processedAckIds: [...state.processedAckIds, ack.ackId] },
      result: { status: "STALE_IGNORED", command },
      auditEvents: [],
      domainEvents: []
    };
  }

  const now = ack.receivedAt;
  const nextLifecycle = lifecycleFromAckStatus(ack.status);
  const nextMission: MissionSnapshot = {
    ...mission,
    lifecycleState: nextLifecycle,
    operationalStatus: ack.status === "ACCEPTED" ? "NOMINAL" : "DEGRADED",
    updatedAt: now,
    lastAcknowledgedCommandId: ack.commandId,
    lastAcknowledgedCommandSequence: ack.lastSeenCommandSequence,
    ...(ack.reason ? { failureReason: ack.reason } : {})
  };

  const currentRobot = state.robots[command.robotId];
  const nextRobot: RobotSnapshot = currentRobot
    ? {
        robotId: currentRobot.robotId,
        connectionState: "ONLINE",
        updatedAt: now,
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
          ack.lastSeenCommandSequence
        ),
        ...(currentRobot.edgeAgentVersion
          ? { edgeAgentVersion: currentRobot.edgeAgentVersion }
          : {})
      }
    : {
        robotId: command.robotId,
        connectionState: "ONLINE",
        activeMissionId: nextMission.missionId,
        lastAcknowledgedCommandId: ack.commandId,
        lastSeenCommandSequence: ack.lastSeenCommandSequence,
        updatedAt: now
      } satisfies RobotSnapshot;

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
      missionId: nextMission.missionId,
      robotId: ack.robotId,
      sequence: ack.lastSeenCommandSequence
    }
  });
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
      sequence: ack.lastSeenCommandSequence
    }
  });

  const nextState = appendGeneratedRecords(
    {
      ...state,
      missions: {
        ...state.missions,
        [nextMission.missionId]: nextMission
      },
      robots: {
        ...state.robots,
        [nextRobot.robotId]: nextRobot
      },
      processedAckIds: [...state.processedAckIds, ack.ackId]
    },
    [event],
    [audit]
  );

  return {
    state: nextState,
    result: { status: "PROCESSED", mission: nextMission },
    auditEvents: [audit],
    domainEvents: [event]
  };
}

/** Marks a dispatched mission as timed out when its command expires before acknowledgement. */
export function applyMissionTimeout(
  state: DomainState,
  input: {
    readonly missionId: MissionId;
    readonly now: IsoTimestamp;
    readonly correlationId: CorrelationId;
  }
): DomainTransition<MissionTimeoutResult> {
  const mission = state.missions[input.missionId];
  if (!mission) {
    return {
      state,
      result: { status: "UNKNOWN_MISSION" },
      auditEvents: [],
      domainEvents: []
    };
  }

  if (mission.lifecycleState !== "DISPATCHED" || !mission.currentCommandId) {
    return {
      state,
      result: { status: "NOT_WAITING_FOR_ACK", mission },
      auditEvents: [],
      domainEvents: []
    };
  }

  const command = state.commands[mission.currentCommandId];
  if (!command || parseTimestamp(command.expiresAt) > parseTimestamp(input.now)) {
    return {
      state,
      result: { status: "NOT_EXPIRED", mission },
      auditEvents: [],
      domainEvents: []
    };
  }

  const nextMission: MissionSnapshot = {
    ...mission,
    lifecycleState: "TIMED_OUT",
    operationalStatus: "DEGRADED",
    updatedAt: input.now,
    failureReason: "command expired before acknowledgement"
  };
  const event = createDomainEvent(state, {
    eventType: "mission.command.timeout",
    aggregateType: "mission",
    aggregateId: input.missionId,
    occurredAt: input.now,
    receivedAt: input.now,
    correlationId: input.correlationId,
    causationId: mission.currentCommandId,
    payload: {
      commandId: mission.currentCommandId
    }
  });
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
      expiresAt: command?.expiresAt ?? null
    }
  });

  const nextState = appendGeneratedRecords(
    {
      ...state,
      missions: {
        ...state.missions,
        [nextMission.missionId]: nextMission
      }
    },
    [event],
    [audit]
  );

  return {
    state: nextState,
    result: { status: "TIMED_OUT", mission: nextMission },
    auditEvents: [audit],
    domainEvents: [event]
  };
}

/** Maps edge ack status into the mission lifecycle state used by the domain reducer. */
function lifecycleFromAckStatus(status: CommandAckV1["status"]): MissionLifecycleState {
  if (status === "ACCEPTED" || status === "DUPLICATE") {
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
