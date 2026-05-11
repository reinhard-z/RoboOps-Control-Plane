import {
  type AuditEventV1,
  type AuditEventId,
  type CausationId,
  type CommandAckV1,
  type CommandEnvelopeV1,
  type CommandId,
  type CommandPayload,
  type CommandType,
  type CorrelationId,
  type EventEnvelopeV1,
  type EventId,
  type IdempotencyKey,
  type IsoTimestamp,
  type MissionId,
  type MissionLifecycleState,
  type MissionOperationalStatus,
  type ProtocolValidationIssue,
  type ReconnectHandshakeV1,
  type ReconciliationOutcomeKind,
  type ReconciliationResultV1,
  type RobotConnectionState,
  type RobotHealthState,
  type RobotTelemetryEventV1,
  type RobotId,
  type SafetyClass,
  isMotionCommandType,
  protocolSchemaVersions,
  validateCommandPayload
} from "@roboops/fleet-protocol";

export interface DomainConfig {
  readonly telemetryStaleAfterMs: number;
  readonly telemetryDegradedAfterMs: number;
  readonly telemetryOfflineAfterMs: number;
  readonly lowBatteryPercent: number;
  readonly maxCommandTtlMs: number;
  readonly allowedCommandTypes: readonly CommandType[];
}

export const defaultDomainConfig = {
  telemetryStaleAfterMs: 5_000,
  telemetryDegradedAfterMs: 10_000,
  telemetryOfflineAfterMs: 30_000,
  lowBatteryPercent: 20,
  maxCommandTtlMs: 30_000,
  allowedCommandTypes: [
    "GO_TO_POSE",
    "CANCEL_MISSION",
    "PAUSE_MISSION",
    "RESUME_MISSION",
    "EMERGENCY_STOP"
  ]
} as const satisfies DomainConfig;

export interface MissionSnapshot {
  readonly missionId: MissionId;
  readonly robotId: RobotId;
  readonly lifecycleState: MissionLifecycleState;
  readonly operationalStatus: MissionOperationalStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly currentCommandId?: CommandId;
  readonly lastCommandSequence?: number;
  readonly lastAcknowledgedCommandId?: CommandId;
  readonly lastAcknowledgedCommandSequence?: number;
  readonly idempotencyKey?: IdempotencyKey;
  readonly failureReason?: string;
}

export interface RobotSnapshot {
  readonly robotId: RobotId;
  readonly connectionState: RobotConnectionState;
  readonly updatedAt: IsoTimestamp;
  readonly health?: RobotHealthState;
  readonly batteryPercent?: number;
  readonly activeMissionId?: MissionId;
  readonly lastTelemetryObservedAt?: IsoTimestamp;
  readonly lastTelemetryReceivedAt?: IsoTimestamp;
  readonly lastAcknowledgedCommandId?: CommandId;
  readonly lastSeenCommandSequence: number;
  readonly edgeAgentVersion?: string;
}

export interface IdempotencyRecord {
  readonly idempotencyKey: IdempotencyKey;
  readonly payloadSignature: string;
  readonly commandId: CommandId;
  readonly missionId: MissionId;
}

export interface DomainState {
  readonly missions: Readonly<Record<MissionId, MissionSnapshot>>;
  readonly robots: Readonly<Record<RobotId, RobotSnapshot>>;
  readonly commands: Readonly<Record<CommandId, CommandEnvelopeV1>>;
  readonly idempotencyRecords: Readonly<Record<IdempotencyKey, IdempotencyRecord>>;
  readonly processedEventIds: readonly EventId[];
  readonly processedAckIds: readonly string[];
  readonly processedReconnectSessionIds: readonly string[];
  readonly nextSequenceByRobot: Readonly<Record<RobotId, number>>;
  readonly auditEvents: readonly AuditEventV1[];
  readonly domainEvents: readonly EventEnvelopeV1[];
}

export interface DomainTransition<TResult> {
  readonly state: DomainState;
  readonly result: TResult;
  readonly auditEvents: readonly AuditEventV1[];
  readonly domainEvents: readonly EventEnvelopeV1[];
}

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

export type CommandAckResult =
  | { readonly status: "PROCESSED"; readonly mission: MissionSnapshot }
  | { readonly status: "DUPLICATE_IGNORED" }
  | { readonly status: "STALE_IGNORED"; readonly command: CommandEnvelopeV1 }
  | { readonly status: "UNKNOWN_COMMAND" };

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

export type MissionTimeoutResult =
  | { readonly status: "TIMED_OUT"; readonly mission: MissionSnapshot }
  | { readonly status: "NOT_EXPIRED"; readonly mission: MissionSnapshot }
  | { readonly status: "NOT_WAITING_FOR_ACK"; readonly mission: MissionSnapshot }
  | { readonly status: "UNKNOWN_MISSION" };

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

/** Creates an empty in-memory domain state for tests, demos, or fresh repositories. */
export function createInitialDomainState(): DomainState {
  return {
    missions: {},
    robots: {},
    commands: {},
    idempotencyRecords: {},
    processedEventIds: [],
    processedAckIds: [],
    processedReconnectSessionIds: [],
    nextSequenceByRobot: {},
    auditEvents: [],
    domainEvents: []
  };
}

/** Inserts or replaces one robot snapshot without touching mission or event history. */
export function upsertRobotSnapshot(
  state: DomainState,
  robot: RobotSnapshot
): DomainState {
  return {
    ...state,
    robots: {
      ...state.robots,
      [robot.robotId]: robot
    }
  };
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

  const mission: MissionSnapshot = {
    missionId: input.missionId,
    robotId: input.robotId,
    lifecycleState: "DISPATCHED",
    operationalStatus: "NOMINAL",
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

/** Looks up a mission snapshot by id. */
export function getMission(
  state: DomainState,
  missionId: MissionId
): MissionSnapshot | undefined {
  return state.missions[missionId];
}

/** Looks up a robot snapshot by id. */
export function getRobot(
  state: DomainState,
  robotId: RobotId
): RobotSnapshot | undefined {
  return state.robots[robotId];
}

/** Returns true while a mission can still receive operational updates. */
export function isActiveMission(lifecycleState: MissionLifecycleState): boolean {
  return ![
    "REJECTED",
    "SAFETY_BLOCKED",
    "CANCELLED",
    "SUCCEEDED",
    "FAILED",
    "TIMED_OUT",
    "MANUAL_REVIEW"
  ].includes(lifecycleState);
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
  const mission: MissionSnapshot = {
    missionId: input.missionId,
    robotId: input.robotId,
    lifecycleState,
    operationalStatus: "DEGRADED",
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

/** Classifies heartbeat age into the robot connection states used for freshness policy. */
function classifyConnectionState(
  heartbeatAgeMs: number,
  config: DomainConfig
): RobotConnectionState {
  if (heartbeatAgeMs >= config.telemetryOfflineAfterMs) {
    return "OFFLINE";
  }
  if (heartbeatAgeMs >= config.telemetryDegradedAfterMs) {
    return "DEGRADED";
  }
  if (heartbeatAgeMs >= config.telemetryStaleAfterMs) {
    return "STALE";
  }
  return "ONLINE";
}

/** Treats motion commands and elevated safety classes as commands requiring fresh telemetry. */
function isRiskyCommand(type: CommandType, safetyClass: SafetyClass): boolean {
  return (
    safetyClass === "RISKY" ||
    safetyClass === "EMERGENCY_STOP" ||
    isMotionCommandType(type)
  );
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

/** Appends generated audit and domain events while preserving immutable state updates. */
function appendGeneratedRecords(
  state: DomainState,
  domainEvents: readonly EventEnvelopeV1[],
  auditEvents: readonly AuditEventV1[]
): DomainState {
  return {
    ...state,
    domainEvents: [...state.domainEvents, ...domainEvents],
    auditEvents: [...state.auditEvents, ...auditEvents]
  };
}

/** Creates a deterministic domain event envelope for reducer-produced events. */
function createDomainEvent(
  state: DomainState,
  input: Omit<EventEnvelopeV1, "schemaVersion" | "eventId">
): EventEnvelopeV1 {
  return {
    schemaVersion: protocolSchemaVersions.eventEnvelope,
    eventId: createGeneratedId("evt_domain", state.domainEvents.length + 1),
    ...input
  };
}

/** Creates a deterministic audit event envelope for reducer-produced audit history. */
function createAuditEvent(
  state: DomainState,
  input: Omit<AuditEventV1, "schemaVersion" | "auditEventId">
): AuditEventV1 {
  return {
    schemaVersion: protocolSchemaVersions.auditEvent,
    auditEventId: createGeneratedId("audit", state.auditEvents.length + 1) as AuditEventId,
    ...input
  };
}

/** Generates stable local ids for deterministic tests before real persistence exists. */
function createGeneratedId(prefix: string, sequence: number): string {
  return `${prefix}_${String(sequence).padStart(6, "0")}`;
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

/** Parses ISO timestamps at reducer boundaries and fails fast for invalid test/input data. */
function parseTimestamp(value: IsoTimestamp): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ISO timestamp: ${value}`);
  }
  return parsed;
}
