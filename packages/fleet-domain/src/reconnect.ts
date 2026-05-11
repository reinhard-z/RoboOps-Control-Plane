import {
  type CorrelationId,
  type IsoTimestamp,
  type ReconnectHandshakeV1,
  type ReconciliationOutcomeKind,
  type ReconciliationResultV1,
  type RobotId,
  protocolSchemaVersions
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

export type ReconnectStartResult =
  | { readonly status: "PROCESSED"; readonly robot: RobotSnapshot }
  | { readonly status: "UNKNOWN_ROBOT" };

export type ReconnectHandshakeResult =
  | {
      readonly status: "PROCESSED";
      readonly reconciliation: ReconciliationResultV1;
      readonly mission?: MissionSnapshot;
    }
  | { readonly status: "DUPLICATE_IGNORED" };

/** Moves a robot and any active mission into reconnecting status before processing a handshake. */
export function beginReconnect(
  state: DomainState,
  input: {
    readonly robotId: RobotId;
    readonly now: IsoTimestamp;
    readonly correlationId: CorrelationId;
  }
): DomainTransition<ReconnectStartResult> {
  const robot = state.robots[input.robotId];
  if (!robot) {
    return {
      state,
      result: { status: "UNKNOWN_ROBOT" },
      auditEvents: [],
      domainEvents: []
    };
  }

  const nextRobot: RobotSnapshot = {
    ...robot,
    connectionState: "RECONNECTING",
    updatedAt: input.now
  };
  const activeMission = robot.activeMissionId
    ? state.missions[robot.activeMissionId]
    : undefined;
  const nextMission =
    activeMission && isActiveMission(activeMission.lifecycleState)
      ? {
          ...activeMission,
          operationalStatus: "RECONNECTING" as const,
          updatedAt: input.now
        }
      : undefined;

  const event = createDomainEvent(state, {
    eventType: "robot.reconnect.started",
    aggregateType: "robot",
    aggregateId: input.robotId,
    occurredAt: input.now,
    receivedAt: input.now,
    correlationId: input.correlationId,
    payload: {
      previousConnectionState: robot.connectionState
    }
  });
  const audit = createAuditEvent(state, {
    actorType: "system",
    action: "robot.reconnect.started",
    occurredAt: input.now,
    ...(nextMission ? { missionId: nextMission.missionId } : {}),
    robotId: input.robotId,
    correlationId: input.correlationId,
    details: {
      previousConnectionState: robot.connectionState
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
    result: { status: "PROCESSED", robot: nextRobot },
    auditEvents: [audit],
    domainEvents: [event]
  };
}

/** Processes a reconnect handshake and produces an explicit reconciliation outcome. */
export function processReconnectHandshake(
  state: DomainState,
  handshake: ReconnectHandshakeV1,
  input: {
    readonly now?: IsoTimestamp;
    readonly correlationId: CorrelationId;
  }
): DomainTransition<ReconnectHandshakeResult> {
  if (state.processedReconnectSessionIds.includes(handshake.edgeSessionId)) {
    return {
      state,
      result: { status: "DUPLICATE_IGNORED" },
      auditEvents: [],
      domainEvents: []
    };
  }

  const decidedAt = input.now ?? handshake.connectedAt;
  const robot = state.robots[handshake.robotId];
  const activeCloudMission = robot?.activeMissionId
    ? state.missions[robot.activeMissionId]
    : undefined;
  const reportedMission = handshake.reportedMissionId
    ? state.missions[handshake.reportedMissionId]
    : undefined;
  const decision = decideReconciliation(
    state,
    handshake,
    activeCloudMission,
    reportedMission
  );

  const reconciliation = createReconciliationResult(
    handshake,
    decision,
    decidedAt,
    input.correlationId
  );
  const nextMission = reportedMission
    ? applyReconciliationToMission(reportedMission, reconciliation, decidedAt)
    : activeCloudMission && reconciliation.outcome === "MANUAL_REVIEW"
      ? applyReconciliationToMission(activeCloudMission, reconciliation, decidedAt)
      : undefined;

  const nextRobot: RobotSnapshot = {
    robotId: handshake.robotId,
    connectionState:
      reconciliation.outcome === "MANUAL_REVIEW" ? "DEGRADED" : "ONLINE",
    updatedAt: decidedAt,
    ...(robot?.health ? { health: robot.health } : {}),
    ...(robot?.batteryPercent !== undefined
      ? { batteryPercent: robot.batteryPercent }
      : {}),
    lastTelemetryObservedAt: handshake.lastTelemetryObservedAt,
    ...(robot?.lastTelemetryReceivedAt
      ? { lastTelemetryReceivedAt: robot.lastTelemetryReceivedAt }
      : {}),
    lastSeenCommandSequence: Math.max(
      robot?.lastSeenCommandSequence ?? 0,
      handshake.lastSeenCommandSequence
    ),
    edgeAgentVersion: handshake.edgeAgentVersion,
    ...(nextMission && isActiveMission(nextMission.lifecycleState)
      ? { activeMissionId: nextMission.missionId }
      : robot?.activeMissionId && !nextMission
        ? { activeMissionId: robot.activeMissionId }
        : {}),
    ...(handshake.lastAcknowledgedCommandId
      ? { lastAcknowledgedCommandId: handshake.lastAcknowledgedCommandId }
      : robot?.lastAcknowledgedCommandId
        ? { lastAcknowledgedCommandId: robot.lastAcknowledgedCommandId }
        : {})
  };

  const event = createDomainEvent(state, {
    eventType: "mission.reconciliation.completed",
    aggregateType: nextMission ? "mission" : "robot",
    aggregateId: nextMission?.missionId ?? handshake.robotId,
    occurredAt: decidedAt,
    receivedAt: decidedAt,
    correlationId: input.correlationId,
    causationId: handshake.edgeSessionId,
    payload: {
      outcome: reconciliation.outcome,
      reason: reconciliation.reason,
      robotId: handshake.robotId,
      reportedMissionId: handshake.reportedMissionId ?? null
    }
  });
  const audit = createAuditEvent(state, {
    actorType: "system",
    action: "mission.reconciliation.completed",
    occurredAt: decidedAt,
    ...(nextMission ? { missionId: nextMission.missionId } : {}),
    robotId: handshake.robotId,
    ...(handshake.lastAcknowledgedCommandId
      ? { commandId: handshake.lastAcknowledgedCommandId }
      : {}),
    correlationId: input.correlationId,
    causationId: handshake.edgeSessionId,
    details: {
      outcome: reconciliation.outcome,
      reason: reconciliation.reason,
      lastSeenCommandSequence: handshake.lastSeenCommandSequence
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
        : state.missions,
      processedReconnectSessionIds: [
        ...state.processedReconnectSessionIds,
        handshake.edgeSessionId
      ]
    },
    [event],
    [audit]
  );

  const result = nextMission
    ? { status: "PROCESSED" as const, reconciliation, mission: nextMission }
    : { status: "PROCESSED" as const, reconciliation };

  return {
    state: nextState,
    result,
    auditEvents: [audit],
    domainEvents: [event]
  };
}

/** Compares cloud and robot-reported state to decide whether to resume, finish, fail, or require review. */
function decideReconciliation(
  state: DomainState,
  handshake: ReconnectHandshakeV1,
  activeCloudMission: MissionSnapshot | undefined,
  reportedMission: MissionSnapshot | undefined
): { readonly outcome: ReconciliationOutcomeKind; readonly reason: string } {
  if (!handshake.reportedMissionId || !reportedMission) {
    return {
      outcome: "MANUAL_REVIEW",
      reason: "robot reported an unknown or missing mission"
    };
  }

  if (
    activeCloudMission &&
    activeCloudMission.missionId !== handshake.reportedMissionId
  ) {
    return {
      outcome: "MANUAL_REVIEW",
      reason: "cloud active mission conflicts with robot-reported mission"
    };
  }

  const latestCommand = reportedMission.currentCommandId
    ? state.commands[reportedMission.currentCommandId]
    : undefined;
  if (
    latestCommand &&
    reportedMission.lifecycleState === "DISPATCHED" &&
    parseTimestamp(latestCommand.expiresAt) < parseTimestamp(handshake.connectedAt) &&
    handshake.lastSeenCommandSequence >= latestCommand.sequence
  ) {
    return {
      outcome: "MANUAL_REVIEW",
      reason: "robot claims it saw a cloud command that expired before acknowledgement"
    };
  }

  if (
    reportedMission.lastCommandSequence !== undefined &&
    handshake.lastSeenCommandSequence < reportedMission.lastCommandSequence &&
    handshake.lastAcknowledgedCommandId !== reportedMission.lastAcknowledgedCommandId
  ) {
    return {
      outcome: "MANUAL_REVIEW",
      reason: "reconnect handshake has an unexplained command sequence gap"
    };
  }

  if (handshake.reportedMissionLifecycleState === "SUCCEEDED") {
    return { outcome: "MARK_SUCCEEDED", reason: "robot reports mission succeeded" };
  }

  if (handshake.reportedMissionLifecycleState === "FAILED") {
    return { outcome: "MARK_FAILED", reason: "robot reports mission failed" };
  }

  return {
    outcome: "RESUME_RUNNING",
    reason: "cloud and robot mission state match"
  };
}

/** Builds the versioned protocol object that describes the reconciliation decision. */
function createReconciliationResult(
  handshake: ReconnectHandshakeV1,
  decision: { readonly outcome: ReconciliationOutcomeKind; readonly reason: string },
  decidedAt: IsoTimestamp,
  correlationId: CorrelationId
): ReconciliationResultV1 {
  return {
    schemaVersion: protocolSchemaVersions.reconciliationResult,
    robotId: handshake.robotId,
    ...(handshake.reportedMissionId ? { missionId: handshake.reportedMissionId } : {}),
    outcome: decision.outcome,
    reason: decision.reason,
    decidedAt,
    lastSeenCommandSequence: handshake.lastSeenCommandSequence,
    ...(handshake.lastAcknowledgedCommandId
      ? { lastAcknowledgedCommandId: handshake.lastAcknowledgedCommandId }
      : {}),
    correlationId
  };
}

/** Applies a reconciliation outcome back onto the mission snapshot. */
function applyReconciliationToMission(
  mission: MissionSnapshot,
  reconciliation: ReconciliationResultV1,
  now: IsoTimestamp
): MissionSnapshot {
  if (reconciliation.outcome === "MARK_SUCCEEDED") {
    return {
      ...mission,
      lifecycleState: "SUCCEEDED",
      operationalStatus: "RECOVERED",
      updatedAt: now
    };
  }

  if (reconciliation.outcome === "MARK_FAILED") {
    return {
      ...mission,
      lifecycleState: "FAILED",
      operationalStatus: "RECOVERED",
      updatedAt: now,
      failureReason: reconciliation.reason
    };
  }

  if (reconciliation.outcome === "MANUAL_REVIEW") {
    return {
      ...mission,
      lifecycleState: "MANUAL_REVIEW",
      operationalStatus: "RECONCILING",
      updatedAt: now,
      failureReason: reconciliation.reason
    };
  }

  return {
    ...mission,
    lifecycleState: "RUNNING",
    operationalStatus: "RECOVERED",
    updatedAt: now
  };
}
