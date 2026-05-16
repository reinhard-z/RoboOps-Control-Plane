import type {
  AuditEventV1,
  CommandEnvelopeV1,
  CommandId,
  EventEnvelopeV1,
  EventId,
  IdempotencyKey,
  IsoTimestamp,
  MissionId,
  MissionLifecycleState,
  MissionOperationalStatus,
  Pose2D,
  RobotConnectionState,
  RobotHealthState,
  RobotId
} from "@roboops/fleet-protocol";

/** Current platform view of one mission and its latest command progress. */
export interface MissionSnapshot {
  readonly missionId: MissionId;
  readonly robotId: RobotId;
  readonly lifecycleState: MissionLifecycleState;
  readonly operationalStatus: MissionOperationalStatus;
  readonly targetPose?: Pose2D;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly currentCommandId?: CommandId;
  readonly lastCommandSequence?: number;
  readonly lastAcknowledgedCommandId?: CommandId;
  readonly lastAcknowledgedCommandSequence?: number;
  readonly idempotencyKey?: IdempotencyKey;
  readonly failureReason?: string;
}

/** Current platform view of one robot, including connectivity and telemetry freshness. */
export interface RobotSnapshot {
  readonly robotId: RobotId;
  readonly connectionState: RobotConnectionState;
  readonly updatedAt: IsoTimestamp;
  readonly pose?: Pose2D;
  readonly health?: RobotHealthState;
  readonly batteryPercent?: number;
  readonly activeMissionId?: MissionId;
  readonly lastTelemetryObservedAt?: IsoTimestamp;
  readonly lastTelemetryReceivedAt?: IsoTimestamp;
  readonly lastAcknowledgedCommandId?: CommandId;
  readonly lastSeenCommandSequence: number;
  readonly edgeAgentVersion?: string;
}

/** Links an operator idempotency key to the command and payload it first created. */
export interface IdempotencyRecord {
  readonly idempotencyKey: IdempotencyKey;
  readonly payloadSignature: string;
  readonly commandId: CommandId;
  readonly missionId: MissionId;
}

/** Immutable in-memory aggregate state consumed and returned by all domain reducers. */
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

/** Standard reducer return shape with the next state and newly emitted records. */
export interface DomainTransition<TResult> {
  readonly state: DomainState;
  readonly result: TResult;
  readonly auditEvents: readonly AuditEventV1[];
  readonly domainEvents: readonly EventEnvelopeV1[];
}

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
