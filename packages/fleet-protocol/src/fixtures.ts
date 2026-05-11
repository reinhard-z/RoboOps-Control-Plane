import {
  type AuditEventV1,
  type CommandAckV1,
  type CommandEnvelopeV1,
  type EventEnvelopeV1,
  type GoToPosePayload,
  type ReconnectHandshakeV1,
  type ReconciliationResultV1,
  type RobotTelemetryEventV1,
  protocolSchemaVersions
} from "./types.js";

/** Deterministic protocol examples used by tests and future contract documentation. */
export const fixtureTimestamps = {
  issuedAt: "2026-05-10T12:00:00.000Z",
  expiresAt: "2026-05-10T12:00:10.000Z",
  observedAt: "2026-05-10T12:00:03.000Z",
  receivedAt: "2026-05-10T12:00:04.000Z",
  reconnectedAt: "2026-05-10T12:01:30.000Z"
} as const;

export const goToPosePayloadFixture = {
  target: { x: 2, y: 4.5, theta: 1.57 }
} as const satisfies GoToPosePayload;

export const commandEnvelopeFixture = {
  schemaVersion: protocolSchemaVersions.commandEnvelope,
  commandId: "cmd_01JPROTO000000000000000001",
  missionId: "mission_01JPROTO00000000000001",
  robotId: "robot-a",
  type: "GO_TO_POSE",
  idempotencyKey: "operator-123:mission_01JPROTO00000000000001:create",
  sequence: 42,
  issuedAt: fixtureTimestamps.issuedAt,
  expiresAt: fixtureTimestamps.expiresAt,
  requiresAck: true,
  safetyClass: "NORMAL",
  correlationId: "corr_01JPROTO0000000000000001",
  causationId: "evt_01JPROTO00000000000000001",
  payload: goToPosePayloadFixture
} as const satisfies CommandEnvelopeV1<GoToPosePayload>;

export const commandAckFixture = {
  schemaVersion: protocolSchemaVersions.commandAck,
  ackId: "ack_01JPROTO000000000000000001",
  commandId: commandEnvelopeFixture.commandId,
  missionId: commandEnvelopeFixture.missionId,
  robotId: commandEnvelopeFixture.robotId,
  status: "ACCEPTED",
  receivedAt: fixtureTimestamps.receivedAt,
  lastSeenCommandSequence: commandEnvelopeFixture.sequence,
  correlationId: commandEnvelopeFixture.correlationId,
  causationId: commandEnvelopeFixture.commandId
} as const satisfies CommandAckV1;

export const robotTelemetryEventFixture = {
  schemaVersion: protocolSchemaVersions.robotTelemetry,
  eventId: "evt_01JPROTO00000000000000002",
  robotId: commandEnvelopeFixture.robotId,
  observedAt: fixtureTimestamps.observedAt,
  receivedAt: fixtureTimestamps.receivedAt,
  pose: { x: 1.7, y: 4.1, theta: 1.51 },
  batteryPercent: 71,
  health: "OK",
  connectionState: "ONLINE",
  currentMissionId: commandEnvelopeFixture.missionId,
  lastAcknowledgedCommandId: commandEnvelopeFixture.commandId,
  lastSeenCommandSequence: commandEnvelopeFixture.sequence,
  edgeAgentVersion: "0.1.0"
} as const satisfies RobotTelemetryEventV1;

export const eventEnvelopeFixture = {
  schemaVersion: protocolSchemaVersions.eventEnvelope,
  eventId: robotTelemetryEventFixture.eventId,
  eventType: "robot.telemetry.received",
  aggregateType: "robot",
  aggregateId: commandEnvelopeFixture.robotId,
  occurredAt: robotTelemetryEventFixture.observedAt,
  receivedAt: robotTelemetryEventFixture.receivedAt,
  correlationId: commandEnvelopeFixture.correlationId,
  causationId: commandEnvelopeFixture.commandId,
  payload: {
    robotId: commandEnvelopeFixture.robotId,
    missionId: commandEnvelopeFixture.missionId
  }
} as const satisfies EventEnvelopeV1;

export const reconnectHandshakeFixture = {
  schemaVersion: protocolSchemaVersions.reconnectHandshake,
  robotId: commandEnvelopeFixture.robotId,
  edgeSessionId: "edge_session_01JPROTO0000000001",
  connectedAt: fixtureTimestamps.reconnectedAt,
  lastSeenCommandSequence: commandEnvelopeFixture.sequence,
  lastAcknowledgedCommandId: commandEnvelopeFixture.commandId,
  reportedMissionId: commandEnvelopeFixture.missionId,
  reportedMissionLifecycleState: "RUNNING",
  lastTelemetryObservedAt: "2026-05-10T12:01:29.000Z",
  edgeAgentVersion: "0.1.0"
} as const satisfies ReconnectHandshakeV1;

export const reconciliationResultFixture = {
  schemaVersion: protocolSchemaVersions.reconciliationResult,
  robotId: commandEnvelopeFixture.robotId,
  missionId: commandEnvelopeFixture.missionId,
  outcome: "RESUME_RUNNING",
  reason: "cloud and edge mission state match",
  decidedAt: fixtureTimestamps.reconnectedAt,
  lastSeenCommandSequence: commandEnvelopeFixture.sequence,
  lastAcknowledgedCommandId: commandEnvelopeFixture.commandId,
  correlationId: commandEnvelopeFixture.correlationId
} as const satisfies ReconciliationResultV1;

export const auditEventFixture = {
  schemaVersion: protocolSchemaVersions.auditEvent,
  auditEventId: "audit_01JPROTO000000000000001",
  actorType: "system",
  action: "mission.reconciliation.completed",
  occurredAt: fixtureTimestamps.reconnectedAt,
  missionId: commandEnvelopeFixture.missionId,
  robotId: commandEnvelopeFixture.robotId,
  commandId: commandEnvelopeFixture.commandId,
  correlationId: commandEnvelopeFixture.correlationId,
  causationId: reconnectHandshakeFixture.edgeSessionId,
  details: {
    outcome: reconciliationResultFixture.outcome
  }
} as const satisfies AuditEventV1;

export const protocolFixtures = {
  commandEnvelopeV1: commandEnvelopeFixture,
  commandAckV1: commandAckFixture,
  eventEnvelopeV1: eventEnvelopeFixture,
  robotTelemetryEventV1: robotTelemetryEventFixture,
  reconnectHandshakeV1: reconnectHandshakeFixture,
  reconciliationResultV1: reconciliationResultFixture,
  auditEventV1: auditEventFixture
} as const;
