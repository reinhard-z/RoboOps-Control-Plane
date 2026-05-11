import {
  auditActorTypes,
  commandAckStatuses,
  commandTypes,
  missionLifecycleStates,
  missionOperationalStatuses,
  protocolSchemaVersions,
  reconciliationOutcomeKinds,
  robotConnectionStates,
  robotHealthStates,
  safetyClasses
} from "./types.js";

export type JsonSchema = Readonly<Record<string, unknown>>;

// Shared schema fragments reused across protocol messages.
const isoTimestampSchema = {
  type: "string",
  format: "date-time"
} as const;

const idSchema = {
  type: "string",
  minLength: 1
} as const;

const pose2dSchema = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y", "theta"],
  properties: {
    x: { type: "number" },
    y: { type: "number" },
    theta: { type: "number" }
  }
} as const;

const goToPosePayloadSchema = {
  type: "object",
  additionalProperties: false,
  required: ["target"],
  properties: {
    target: pose2dSchema
  }
} as const;

const cancelMissionPayloadSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reason"],
  properties: {
    reason: { type: "string", minLength: 1 }
  }
} as const;

const emptyCommandPayloadSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reason: { type: "string", minLength: 1 }
  }
} as const;

// Command sent from the Fleet Platform to an edge runtime.
export const commandEnvelopeV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://roboops.dev/schemas/command.envelope.v1.schema.json",
  title: "CommandEnvelopeV1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "commandId",
    "missionId",
    "robotId",
    "type",
    "idempotencyKey",
    "sequence",
    "issuedAt",
    "expiresAt",
    "requiresAck",
    "safetyClass",
    "correlationId",
    "causationId",
    "payload"
  ],
  properties: {
    schemaVersion: { const: protocolSchemaVersions.commandEnvelope },
    commandId: idSchema,
    missionId: idSchema,
    robotId: idSchema,
    type: { enum: commandTypes },
    idempotencyKey: idSchema,
    sequence: { type: "integer", minimum: 1 },
    issuedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
    requiresAck: { type: "boolean" },
    safetyClass: { enum: safetyClasses },
    correlationId: idSchema,
    causationId: idSchema,
    payload: {
      oneOf: [
        goToPosePayloadSchema,
        cancelMissionPayloadSchema,
        emptyCommandPayloadSchema
      ]
    }
  }
} as const satisfies JsonSchema;

// Edge acknowledgement returned after receiving a platform command.
export const commandAckV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://roboops.dev/schemas/command.ack.v1.schema.json",
  title: "CommandAckV1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "ackId",
    "commandId",
    "robotId",
    "status",
    "receivedAt",
    "lastSeenCommandSequence",
    "correlationId",
    "causationId"
  ],
  properties: {
    schemaVersion: { const: protocolSchemaVersions.commandAck },
    ackId: idSchema,
    commandId: idSchema,
    missionId: idSchema,
    robotId: idSchema,
    status: { enum: commandAckStatuses },
    receivedAt: isoTimestampSchema,
    lastSeenCommandSequence: { type: "integer", minimum: 0 },
    reason: { type: "string" },
    correlationId: idSchema,
    causationId: idSchema
  }
} as const satisfies JsonSchema;

// Generic event envelope for domain events, outbox records, and future event streams.
export const eventEnvelopeV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://roboops.dev/schemas/event.envelope.v1.schema.json",
  title: "EventEnvelopeV1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "eventId",
    "eventType",
    "aggregateType",
    "aggregateId",
    "occurredAt",
    "receivedAt",
    "correlationId",
    "payload"
  ],
  properties: {
    schemaVersion: { const: protocolSchemaVersions.eventEnvelope },
    eventId: idSchema,
    eventType: idSchema,
    aggregateType: { enum: ["mission", "robot", "command", "system"] },
    aggregateId: idSchema,
    occurredAt: isoTimestampSchema,
    receivedAt: isoTimestampSchema,
    correlationId: idSchema,
    causationId: idSchema,
    payload: { type: "object" }
  }
} as const satisfies JsonSchema;

// Telemetry report accepted from the edge runtime.
export const robotTelemetryEventV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://roboops.dev/schemas/robot.telemetry.v1.schema.json",
  title: "RobotTelemetryEventV1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "eventId",
    "robotId",
    "observedAt",
    "receivedAt",
    "pose",
    "batteryPercent",
    "health",
    "connectionState",
    "lastSeenCommandSequence",
    "edgeAgentVersion"
  ],
  properties: {
    schemaVersion: { const: protocolSchemaVersions.robotTelemetry },
    eventId: idSchema,
    robotId: idSchema,
    observedAt: isoTimestampSchema,
    receivedAt: isoTimestampSchema,
    pose: pose2dSchema,
    batteryPercent: { type: "number", minimum: 0, maximum: 100 },
    health: { enum: robotHealthStates },
    connectionState: { enum: robotConnectionStates },
    currentMissionId: idSchema,
    lastAcknowledgedCommandId: idSchema,
    lastSeenCommandSequence: { type: "integer", minimum: 0 },
    edgeAgentVersion: idSchema
  }
} as const satisfies JsonSchema;

// Reconnect summary used to compare edge-reported state with platform state.
export const reconnectHandshakeV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://roboops.dev/schemas/reconnect.handshake.v1.schema.json",
  title: "ReconnectHandshakeV1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "robotId",
    "edgeSessionId",
    "connectedAt",
    "lastSeenCommandSequence",
    "lastTelemetryObservedAt",
    "edgeAgentVersion"
  ],
  properties: {
    schemaVersion: { const: protocolSchemaVersions.reconnectHandshake },
    robotId: idSchema,
    edgeSessionId: idSchema,
    connectedAt: isoTimestampSchema,
    lastSeenCommandSequence: { type: "integer", minimum: 0 },
    lastAcknowledgedCommandId: idSchema,
    reportedMissionId: idSchema,
    reportedMissionLifecycleState: { enum: missionLifecycleStates },
    lastTelemetryObservedAt: isoTimestampSchema,
    edgeAgentVersion: idSchema
  }
} as const satisfies JsonSchema;

// Audit trail entry for operator-visible domain decisions.
export const auditEventV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://roboops.dev/schemas/audit.event.v1.schema.json",
  title: "AuditEventV1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "auditEventId",
    "actorType",
    "action",
    "occurredAt",
    "correlationId",
    "details"
  ],
  properties: {
    schemaVersion: { const: protocolSchemaVersions.auditEvent },
    auditEventId: idSchema,
    actorType: { enum: auditActorTypes },
    action: idSchema,
    occurredAt: isoTimestampSchema,
    missionId: idSchema,
    robotId: idSchema,
    commandId: idSchema,
    correlationId: idSchema,
    causationId: idSchema,
    details: { type: "object" }
  }
} as const satisfies JsonSchema;

// Result produced after reconnect reconciliation.
export const reconciliationResultV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://roboops.dev/schemas/reconciliation.result.v1.schema.json",
  title: "ReconciliationResultV1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "robotId",
    "outcome",
    "reason",
    "decidedAt",
    "lastSeenCommandSequence",
    "correlationId"
  ],
  properties: {
    schemaVersion: { const: protocolSchemaVersions.reconciliationResult },
    robotId: idSchema,
    missionId: idSchema,
    outcome: { enum: reconciliationOutcomeKinds },
    reason: idSchema,
    decidedAt: isoTimestampSchema,
    lastSeenCommandSequence: { type: "integer", minimum: 0 },
    lastAcknowledgedCommandId: idSchema,
    correlationId: idSchema
  }
} as const satisfies JsonSchema;

// Public enum schema for UI/API consumers that need the state vocabulary.
export const missionStateEnumsSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://roboops.dev/schemas/mission-state-enums.v1.schema.json",
  title: "MissionStateEnumsV1",
  type: "object",
  additionalProperties: false,
  properties: {
    lifecycleState: { enum: missionLifecycleStates },
    operationalStatus: { enum: missionOperationalStatuses },
    robotConnectionState: { enum: robotConnectionStates }
  }
} as const satisfies JsonSchema;

// Registry exported by the protocol package for contract tests and validators.
export const protocolJsonSchemas = {
  commandEnvelopeV1: commandEnvelopeV1Schema,
  commandAckV1: commandAckV1Schema,
  eventEnvelopeV1: eventEnvelopeV1Schema,
  robotTelemetryEventV1: robotTelemetryEventV1Schema,
  reconnectHandshakeV1: reconnectHandshakeV1Schema,
  auditEventV1: auditEventV1Schema,
  reconciliationResultV1: reconciliationResultV1Schema,
  missionStateEnumsV1: missionStateEnumsSchema
} as const;

export function getProtocolJsonSchemas(): typeof protocolJsonSchemas {
  return protocolJsonSchemas;
}
