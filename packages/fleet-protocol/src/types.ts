/** Protocol version strings for every message shape that can cross package or process boundaries. */
export const protocolSchemaVersions = {
  commandEnvelope: "command.envelope.v1",
  commandAck: "command.ack.v1",
  eventEnvelope: "event.envelope.v1",
  robotTelemetry: "robot.telemetry.v1",
  reconnectHandshake: "reconnect.handshake.v1",
  auditEvent: "audit.event.v1",
  reconciliationResult: "reconciliation.result.v1"
} as const;

/** Commands the platform is allowed to issue to an edge runtime. */
export const commandTypes = [
  "GO_TO_POSE",
  "CANCEL_MISSION",
  "PAUSE_MISSION",
  "RESUME_MISSION",
  "EMERGENCY_STOP"
] as const;

export const motionCommandTypes = ["GO_TO_POSE", "RESUME_MISSION"] as const;

export const safetyClasses = ["NORMAL", "RISKY", "EMERGENCY_STOP"] as const;

/** Acknowledgement statuses returned by the edge after it receives a command. */
export const commandAckStatuses = [
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
  "DUPLICATE",
  "FAILED"
] as const;

/** Durable progress of a mission from operator request through terminal outcome. */
export const missionLifecycleStates = [
  "CREATED",
  "VALIDATED",
  "REJECTED",
  "SAFETY_BLOCKED",
  "ASSIGNED",
  "DISPATCHED",
  "ACKNOWLEDGED",
  "RUNNING",
  "CANCEL_REQUESTED",
  "CANCELLED",
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "MANUAL_REVIEW"
] as const;

/** Non-terminal operational risk overlay for an otherwise active mission. */
export const missionOperationalStatuses = [
  "NOMINAL",
  "DEGRADED",
  "RECONNECTING",
  "RECONCILING",
  "RECOVERED"
] as const;

/** Connectivity/freshness status for the robot or edge runtime. */
export const robotConnectionStates = [
  "ONLINE",
  "STALE",
  "DEGRADED",
  "OFFLINE",
  "RECONNECTING"
] as const;

export const robotHealthStates = ["OK", "WARN", "ERROR", "ESTOP"] as const;

export const reconciliationOutcomeKinds = [
  "RESUME_RUNNING",
  "MARK_SUCCEEDED",
  "MARK_FAILED",
  "MANUAL_REVIEW"
] as const;

export const auditActorTypes = ["operator", "system", "edge", "demo"] as const;

export type SchemaVersion =
  (typeof protocolSchemaVersions)[keyof typeof protocolSchemaVersions];
export type CommandType = (typeof commandTypes)[number];
export type MotionCommandType = (typeof motionCommandTypes)[number];
export type SafetyClass = (typeof safetyClasses)[number];
export type CommandAckStatus = (typeof commandAckStatuses)[number];
export type MissionLifecycleState = (typeof missionLifecycleStates)[number];
export type MissionOperationalStatus = (typeof missionOperationalStatuses)[number];
export type RobotConnectionState = (typeof robotConnectionStates)[number];
export type RobotHealthState = (typeof robotHealthStates)[number];
export type ReconciliationOutcomeKind = (typeof reconciliationOutcomeKinds)[number];
export type AuditActorType = (typeof auditActorTypes)[number];

export type IsoTimestamp = string;
export type CommandId = string;
export type MissionId = string;
export type RobotId = string;
export type EventId = string;
export type AuditEventId = string;
export type CorrelationId = string;
export type CausationId = string;
export type IdempotencyKey = string;
export type EdgeSessionId = string;

export interface Pose2D {
  readonly x: number;
  readonly y: number;
  readonly theta: number;
}

export interface GoToPosePayload {
  readonly target: Pose2D;
}

export interface CancelMissionPayload {
  readonly reason: string;
}

export interface EmptyCommandPayload {
  readonly reason?: string;
}

export type CommandPayload =
  | GoToPosePayload
  | CancelMissionPayload
  | EmptyCommandPayload;

/** Versioned command sent from the Fleet Platform down to the outbound edge connection. */
export interface CommandEnvelopeV1<TPayload extends CommandPayload = CommandPayload> {
  readonly schemaVersion: typeof protocolSchemaVersions.commandEnvelope;
  readonly commandId: CommandId;
  readonly missionId: MissionId;
  readonly robotId: RobotId;
  readonly type: CommandType;
  readonly idempotencyKey: IdempotencyKey;
  readonly sequence: number;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly requiresAck: boolean;
  readonly safetyClass: SafetyClass;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId;
  readonly payload: TPayload;
}

/** Edge response proving whether a command was accepted, rejected, expired, or duplicated. */
export interface CommandAckV1 {
  readonly schemaVersion: typeof protocolSchemaVersions.commandAck;
  readonly ackId: string;
  readonly commandId: CommandId;
  readonly missionId?: MissionId;
  readonly robotId: RobotId;
  readonly status: CommandAckStatus;
  readonly receivedAt: IsoTimestamp;
  readonly lastSeenCommandSequence: number;
  readonly reason?: string;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId;
}

/** Generic event wrapper used for domain events, outbox messages, and future event logs. */
export interface EventEnvelopeV1<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  readonly schemaVersion: typeof protocolSchemaVersions.eventEnvelope;
  readonly eventId: EventId;
  readonly eventType: string;
  readonly aggregateType: "mission" | "robot" | "command" | "system";
  readonly aggregateId: string;
  readonly occurredAt: IsoTimestamp;
  readonly receivedAt: IsoTimestamp;
  readonly correlationId: CorrelationId;
  readonly causationId?: CausationId;
  readonly payload: TPayload;
}

/** Robot telemetry report accepted by the platform from the edge runtime. */
export interface RobotTelemetryEventV1 {
  readonly schemaVersion: typeof protocolSchemaVersions.robotTelemetry;
  readonly eventId: EventId;
  readonly robotId: RobotId;
  readonly observedAt: IsoTimestamp;
  readonly receivedAt: IsoTimestamp;
  readonly pose: Pose2D;
  readonly batteryPercent: number;
  readonly health: RobotHealthState;
  readonly connectionState: RobotConnectionState;
  readonly currentMissionId?: MissionId;
  readonly lastAcknowledgedCommandId?: CommandId;
  readonly lastSeenCommandSequence: number;
  readonly edgeAgentVersion: string;
}

/** Edge reconnect summary used to reconcile cloud state with robot-reported state. */
export interface ReconnectHandshakeV1 {
  readonly schemaVersion: typeof protocolSchemaVersions.reconnectHandshake;
  readonly robotId: RobotId;
  readonly edgeSessionId: EdgeSessionId;
  readonly connectedAt: IsoTimestamp;
  readonly lastSeenCommandSequence: number;
  readonly lastAcknowledgedCommandId?: CommandId;
  readonly reportedMissionId?: MissionId;
  readonly reportedMissionLifecycleState?: MissionLifecycleState;
  readonly lastTelemetryObservedAt: IsoTimestamp;
  readonly edgeAgentVersion: string;
}

/** Human/operator-facing audit trail entry for important domain decisions. */
export interface AuditEventV1 {
  readonly schemaVersion: typeof protocolSchemaVersions.auditEvent;
  readonly auditEventId: AuditEventId;
  readonly actorType: AuditActorType;
  readonly action: string;
  readonly occurredAt: IsoTimestamp;
  readonly missionId?: MissionId;
  readonly robotId?: RobotId;
  readonly commandId?: CommandId;
  readonly correlationId: CorrelationId;
  readonly causationId?: CausationId;
  readonly details: Record<string, unknown>;
}

/** Explicit result of comparing platform state with edge state after reconnect. */
export interface ReconciliationResultV1 {
  readonly schemaVersion: typeof protocolSchemaVersions.reconciliationResult;
  readonly robotId: RobotId;
  readonly missionId?: MissionId;
  readonly outcome: ReconciliationOutcomeKind;
  readonly reason: string;
  readonly decidedAt: IsoTimestamp;
  readonly lastSeenCommandSequence: number;
  readonly lastAcknowledgedCommandId?: CommandId;
  readonly correlationId: CorrelationId;
}

export interface ProtocolValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ProtocolValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ProtocolValidationIssue[];
}

export function isKnownCommandType(value: string): value is CommandType {
  return commandTypes.includes(value as CommandType);
}

export function isMotionCommandType(value: CommandType): value is MotionCommandType {
  return motionCommandTypes.includes(value as MotionCommandType);
}

export function isKnownMissionLifecycleState(
  value: string
): value is MissionLifecycleState {
  return missionLifecycleStates.includes(value as MissionLifecycleState);
}

export function validateCommandPayload(
  type: CommandType,
  payload: unknown
): ProtocolValidationResult {
  const issues: ProtocolValidationIssue[] = [];

  if (!isRecord(payload)) {
    return {
      valid: false,
      issues: [{ path: "payload", message: "payload must be an object" }]
    };
  }

  if (type === "GO_TO_POSE") {
    const target = payload["target"];
    if (!isRecord(target)) {
      issues.push({ path: "payload.target", message: "target is required" });
    } else {
      for (const coordinate of ["x", "y", "theta"] as const) {
        if (!Number.isFinite(target[coordinate])) {
          issues.push({
            path: `payload.target.${coordinate}`,
            message: `${coordinate} must be a finite number`
          });
        }
      }
    }
  }

  if (type === "CANCEL_MISSION") {
    if (typeof payload["reason"] !== "string" || payload["reason"].length === 0) {
      issues.push({
        path: "payload.reason",
        message: "reason is required for CANCEL_MISSION"
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

export function isIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
