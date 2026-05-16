import type {
  CorrelationId,
  IsoTimestamp,
  RobotConnectionState,
  RobotId,
  RobotTelemetryEventV1
} from "@roboops/fleet-protocol";

import { appendGeneratedRecords, createAuditEvent, createDomainEvent } from "./events.js";
import {
  type DomainConfig,
  classifyConnectionState,
  defaultDomainConfig,
  isActiveMission
} from "./policies.js";
import type {
  DomainState,
  DomainTransition,
  MissionSnapshot,
  RobotSnapshot
} from "./state.js";
import { parseTimestamp } from "./time.js";

export type TelemetryResult =
  | { readonly status: "PROCESSED"; readonly robot: RobotSnapshot }
  | { readonly status: "DUPLICATE_IGNORED" };

export type FreshnessResult =
  | {
      readonly status: "UPDATED";
      readonly robot: RobotSnapshot;
      readonly previousConnectionState: RobotConnectionState;
    }
  | { readonly status: "UNCHANGED"; readonly robot: RobotSnapshot }
  | { readonly status: "UNKNOWN_ROBOT" };

/** Records telemetry from the edge, deduplicates by event id, and updates robot/mission snapshots. */
export function ingestRobotTelemetry(
  state: DomainState,
  telemetry: RobotTelemetryEventV1
): DomainTransition<TelemetryResult> {
  if (state.processedEventIds.includes(telemetry.eventId)) {
    return {
      state,
      result: { status: "DUPLICATE_IGNORED" },
      auditEvents: [],
      domainEvents: []
    };
  }

  const existingRobot = state.robots[telemetry.robotId];
  const nextRobot: RobotSnapshot = {
    robotId: telemetry.robotId,
    connectionState: telemetry.connectionState,
    pose: telemetry.pose,
    health: telemetry.health,
    batteryPercent: telemetry.batteryPercent,
    updatedAt: telemetry.receivedAt,
    lastTelemetryObservedAt: telemetry.observedAt,
    lastTelemetryReceivedAt: telemetry.receivedAt,
    lastSeenCommandSequence: Math.max(
      existingRobot?.lastSeenCommandSequence ?? 0,
      telemetry.lastSeenCommandSequence
    ),
    edgeAgentVersion: telemetry.edgeAgentVersion,
    ...(telemetry.currentMissionId
      ? { activeMissionId: telemetry.currentMissionId }
      : existingRobot?.activeMissionId
        ? { activeMissionId: existingRobot.activeMissionId }
        : {}),
    ...(telemetry.lastAcknowledgedCommandId
      ? { lastAcknowledgedCommandId: telemetry.lastAcknowledgedCommandId }
      : existingRobot?.lastAcknowledgedCommandId
        ? { lastAcknowledgedCommandId: existingRobot.lastAcknowledgedCommandId }
        : {})
  };

  const mission = telemetry.currentMissionId
    ? state.missions[telemetry.currentMissionId]
    : undefined;
  const nextMission: MissionSnapshot | undefined =
    mission && isActiveMission(mission.lifecycleState)
      ? {
          ...mission,
          lifecycleState:
            mission.lifecycleState === "DISPATCHED" ? "RUNNING" : mission.lifecycleState,
          operationalStatus:
            telemetry.connectionState === "ONLINE" && telemetry.health === "OK"
              ? "NOMINAL"
              : "DEGRADED",
          updatedAt: telemetry.receivedAt,
          ...(telemetry.lastAcknowledgedCommandId
            ? { lastAcknowledgedCommandId: telemetry.lastAcknowledgedCommandId }
            : {}),
          lastAcknowledgedCommandSequence: telemetry.lastSeenCommandSequence
        }
      : undefined;

  const event = createDomainEvent(state, {
    eventType: "robot.telemetry.received",
    aggregateType: "robot",
    aggregateId: telemetry.robotId,
    occurredAt: telemetry.observedAt,
    receivedAt: telemetry.receivedAt,
    correlationId: `corr_${telemetry.eventId}`,
    causationId: telemetry.eventId,
    payload: {
      robotId: telemetry.robotId,
      batteryPercent: telemetry.batteryPercent,
      connectionState: telemetry.connectionState,
      pose: telemetry.pose,
      currentMissionId: telemetry.currentMissionId ?? null
    }
  });
  const audit = createAuditEvent(state, {
    actorType: "edge",
    action: "robot.telemetry.received",
    occurredAt: telemetry.receivedAt,
    ...(telemetry.currentMissionId ? { missionId: telemetry.currentMissionId } : {}),
    robotId: telemetry.robotId,
    ...(telemetry.lastAcknowledgedCommandId
      ? { commandId: telemetry.lastAcknowledgedCommandId }
      : {}),
    correlationId: `corr_${telemetry.eventId}`,
    causationId: telemetry.eventId,
    details: {
      batteryPercent: telemetry.batteryPercent,
      connectionState: telemetry.connectionState,
      health: telemetry.health
    }
  });

  const missions = nextMission
    ? {
        ...state.missions,
        [nextMission.missionId]: nextMission
      }
    : state.missions;

  const nextState = appendGeneratedRecords(
    {
      ...state,
      missions,
      robots: {
        ...state.robots,
        [nextRobot.robotId]: nextRobot
      },
      processedEventIds: [...state.processedEventIds, telemetry.eventId]
    },
    [event],
    [audit]
  );

  return {
    state: nextState,
    result: { status: "PROCESSED", robot: nextRobot },
    auditEvents: [audit],
    domainEvents: [event]
  };
}

/** Recomputes robot freshness from heartbeat age and degrades active missions without failing them. */
export function evaluateTelemetryFreshness(
  state: DomainState,
  input: {
    readonly robotId: RobotId;
    readonly now: IsoTimestamp;
    readonly correlationId?: CorrelationId;
  },
  config: DomainConfig = defaultDomainConfig
): DomainTransition<FreshnessResult> {
  const robot = state.robots[input.robotId];
  if (!robot) {
    return {
      state,
      result: { status: "UNKNOWN_ROBOT" },
      auditEvents: [],
      domainEvents: []
    };
  }

  const lastSeenAt = robot.lastTelemetryReceivedAt ?? robot.lastTelemetryObservedAt;
  const nextConnectionState = lastSeenAt
    ? classifyConnectionState(parseTimestamp(input.now) - parseTimestamp(lastSeenAt), config)
    : "OFFLINE";

  if (nextConnectionState === robot.connectionState) {
    return {
      state,
      result: { status: "UNCHANGED", robot },
      auditEvents: [],
      domainEvents: []
    };
  }

  const nextRobot: RobotSnapshot = {
    ...robot,
    connectionState: nextConnectionState,
    updatedAt: input.now
  };

  const activeMission = robot.activeMissionId
    ? state.missions[robot.activeMissionId]
    : undefined;
  const nextMission: MissionSnapshot | undefined =
    activeMission && isActiveMission(activeMission.lifecycleState)
      ? {
          ...activeMission,
          operationalStatus:
            nextConnectionState === "ONLINE" ? "NOMINAL" : "DEGRADED",
          updatedAt: input.now
        }
      : undefined;

  const correlationId = input.correlationId ?? `corr_freshness_${input.robotId}`;
  const event = createDomainEvent(state, {
    eventType: "robot.connection.freshness_changed",
    aggregateType: "robot",
    aggregateId: input.robotId,
    occurredAt: input.now,
    receivedAt: input.now,
    correlationId,
    payload: {
      previousConnectionState: robot.connectionState,
      connectionState: nextConnectionState
    }
  });
  const audit = createAuditEvent(state, {
    actorType: "system",
    action: "robot.connection.freshness_changed",
    occurredAt: input.now,
    ...(nextMission ? { missionId: nextMission.missionId } : {}),
    robotId: input.robotId,
    correlationId,
    details: {
      previousConnectionState: robot.connectionState,
      connectionState: nextConnectionState
    }
  });

  const nextState = appendGeneratedRecords(
    {
      ...state,
      robots: {
        ...state.robots,
        [nextRobot.robotId]: nextRobot
      },
      missions: nextMission
        ? {
            ...state.missions,
            [nextMission.missionId]: nextMission
          }
        : state.missions
    },
    [event],
    [audit]
  );

  return {
    state: nextState,
    result: {
      status: "UPDATED",
      robot: nextRobot,
      previousConnectionState: robot.connectionState
    },
    auditEvents: [audit],
    domainEvents: [event]
  };
}
