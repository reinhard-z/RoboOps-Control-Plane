import {
  type CommandAckV1,
  type CommandPayload,
  type ReconnectHandshakeV1,
  type RobotTelemetryEventV1,
  commandAckStatuses,
  isIsoTimestamp,
  isKnownCommandType,
  isKnownMissionLifecycleState,
  protocolSchemaVersions,
  robotConnectionStates,
  robotHealthStates,
  safetyClasses,
  validateCommandPayload
} from "@roboops/fleet-protocol";

import type {
  CancelMissionRequest,
  CreateMissionRequest,
  EdgeHelloPayload,
  EdgeWireMessage,
  ValidationIssue,
  ValidationResult
} from "./types.js";

/** Parses and validates the POST /missions body against protocol command rules. */
export function parseCreateMissionRequest(body: unknown): ValidationResult<CreateMissionRequest> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(body)) {
    return invalid([{ path: "$", message: "request body must be an object" }]);
  }

  const robotId = readRequiredString(body, "robotId", issues);
  const typeValue = readOptionalString(body, "type") ?? "GO_TO_POSE";
  if (!isKnownCommandType(typeValue)) {
    issues.push({ path: "type", message: "type must be a known command type" });
  }

  const payload = body["payload"] ?? {};
  if (isKnownCommandType(typeValue)) {
    const payloadValidation = validateCommandPayload(typeValue, payload);
    for (const payloadIssue of payloadValidation.issues) {
      issues.push(payloadIssue);
    }
  }

  const safetyClass = readOptionalEnum(body, "safetyClass", safetyClasses, issues);
  const expiresInMs = readOptionalPositiveInteger(body, "expiresInMs", issues);
  const missionId = readOptionalString(body, "missionId");
  const commandId = readOptionalString(body, "commandId");
  const idempotencyKey = readOptionalString(body, "idempotencyKey");
  const requiresAck = readOptionalBoolean(body, "requiresAck", issues);

  if (issues.length > 0 || !robotId || !isKnownCommandType(typeValue)) {
    return invalid(issues);
  }

  return valid({
    robotId,
    type: typeValue,
    payload: payload as CommandPayload,
    ...(missionId ? { missionId } : {}),
    ...(commandId ? { commandId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(expiresInMs ? { expiresInMs } : {}),
    ...(requiresAck !== undefined ? { requiresAck } : {}),
    ...(safetyClass ? { safetyClass } : {})
  });
}

/** Parses and validates the POST /missions/:missionId/cancel body. */
export function parseCancelMissionRequest(body: unknown): ValidationResult<CancelMissionRequest> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(body)) {
    return invalid([{ path: "$", message: "request body must be an object" }]);
  }

  const reason = readOptionalString(body, "reason") ?? "operator requested cancel";
  const commandId = readOptionalString(body, "commandId");
  const idempotencyKey = readOptionalString(body, "idempotencyKey");
  const expiresInMs = readOptionalPositiveInteger(body, "expiresInMs", issues);

  if (issues.length > 0) {
    return invalid(issues);
  }

  return valid({
    reason,
    ...(commandId ? { commandId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(expiresInMs ? { expiresInMs } : {})
  });
}

/** Parses one JSON message received from an edge WebSocket connection. */
export function parseEdgeWireMessage(body: unknown): ValidationResult<EdgeWireMessage> {
  if (!isRecord(body)) {
    return invalid([{ path: "$", message: "edge message must be an object" }]);
  }

  const type = body["type"];
  if (type === "edge.hello") {
    return parseEdgeHello(body["payload"]);
  }
  if (type === "edge.telemetry") {
    return mapPayload(parseRobotTelemetry(body["payload"]), (payload) => ({
      type: "edge.telemetry" as const,
      payload
    }));
  }
  if (type === "edge.command_ack") {
    return mapPayload(parseCommandAck(body["payload"]), (payload) => ({
      type: "edge.command_ack" as const,
      payload
    }));
  }
  if (type === "edge.reconnect_handshake") {
    return mapPayload(parseReconnectHandshake(body["payload"]), (payload) => ({
      type: "edge.reconnect_handshake" as const,
      payload
    }));
  }

  return invalid([{ path: "type", message: "unsupported edge message type" }]);
}

/** Parses and validates a command acknowledgement protocol payload. */
export function parseCommandAck(body: unknown): ValidationResult<CommandAckV1> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(body)) {
    return invalid([{ path: "payload", message: "payload must be an object" }]);
  }

  requireConst(
    body,
    "schemaVersion",
    protocolSchemaVersions.commandAck,
    issues
  );
  const ackId = readRequiredString(body, "ackId", issues);
  const commandId = readRequiredString(body, "commandId", issues);
  const missionId = readOptionalString(body, "missionId");
  const robotId = readRequiredString(body, "robotId", issues);
  const status = readRequiredEnum(body, "status", commandAckStatuses, issues);
  const receivedAt = readRequiredIsoTimestamp(body, "receivedAt", issues);
  const lastSeenCommandSequence = readRequiredNonNegativeInteger(
    body,
    "lastSeenCommandSequence",
    issues
  );
  const reason = readOptionalString(body, "reason");
  const correlationId = readRequiredString(body, "correlationId", issues);
  const causationId = readRequiredString(body, "causationId", issues);

  if (
    issues.length > 0 ||
    !ackId ||
    !commandId ||
    !robotId ||
    !status ||
    !receivedAt ||
    lastSeenCommandSequence === undefined ||
    !correlationId ||
    !causationId
  ) {
    return invalid(issues);
  }

  return valid({
    schemaVersion: protocolSchemaVersions.commandAck,
    ackId,
    commandId,
    ...(missionId ? { missionId } : {}),
    robotId,
    status,
    receivedAt,
    lastSeenCommandSequence,
    ...(reason ? { reason } : {}),
    correlationId,
    causationId
  });
}

/** Parses and validates a robot telemetry protocol payload. */
export function parseRobotTelemetry(body: unknown): ValidationResult<RobotTelemetryEventV1> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(body)) {
    return invalid([{ path: "payload", message: "payload must be an object" }]);
  }

  requireConst(
    body,
    "schemaVersion",
    protocolSchemaVersions.robotTelemetry,
    issues
  );
  const eventId = readRequiredString(body, "eventId", issues);
  const robotId = readRequiredString(body, "robotId", issues);
  const observedAt = readRequiredIsoTimestamp(body, "observedAt", issues);
  const receivedAt = readRequiredIsoTimestamp(body, "receivedAt", issues);
  const pose = readPose(body["pose"], issues);
  const batteryPercent = readNumberInRange(body, "batteryPercent", 0, 100, issues);
  const health = readRequiredEnum(body, "health", robotHealthStates, issues);
  const connectionState = readRequiredEnum(
    body,
    "connectionState",
    robotConnectionStates,
    issues
  );
  const currentMissionId = readOptionalString(body, "currentMissionId");
  const lastAcknowledgedCommandId = readOptionalString(
    body,
    "lastAcknowledgedCommandId"
  );
  const lastSeenCommandSequence = readRequiredNonNegativeInteger(
    body,
    "lastSeenCommandSequence",
    issues
  );
  const edgeAgentVersion = readRequiredString(body, "edgeAgentVersion", issues);

  if (
    issues.length > 0 ||
    !eventId ||
    !robotId ||
    !observedAt ||
    !receivedAt ||
    !pose ||
    batteryPercent === undefined ||
    !health ||
    !connectionState ||
    lastSeenCommandSequence === undefined ||
    !edgeAgentVersion
  ) {
    return invalid(issues);
  }

  return valid({
    schemaVersion: protocolSchemaVersions.robotTelemetry,
    eventId,
    robotId,
    observedAt,
    receivedAt,
    pose,
    batteryPercent,
    health,
    connectionState,
    ...(currentMissionId ? { currentMissionId } : {}),
    ...(lastAcknowledgedCommandId ? { lastAcknowledgedCommandId } : {}),
    lastSeenCommandSequence,
    edgeAgentVersion
  });
}

/** Parses and validates a reconnect handshake protocol payload. */
export function parseReconnectHandshake(
  body: unknown
): ValidationResult<ReconnectHandshakeV1> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(body)) {
    return invalid([{ path: "payload", message: "payload must be an object" }]);
  }

  requireConst(
    body,
    "schemaVersion",
    protocolSchemaVersions.reconnectHandshake,
    issues
  );
  const robotId = readRequiredString(body, "robotId", issues);
  const edgeSessionId = readRequiredString(body, "edgeSessionId", issues);
  const connectedAt = readRequiredIsoTimestamp(body, "connectedAt", issues);
  const lastSeenCommandSequence = readRequiredNonNegativeInteger(
    body,
    "lastSeenCommandSequence",
    issues
  );
  const lastAcknowledgedCommandId = readOptionalString(
    body,
    "lastAcknowledgedCommandId"
  );
  const reportedMissionId = readOptionalString(body, "reportedMissionId");
  const reportedMissionLifecycleState = readOptionalString(
    body,
    "reportedMissionLifecycleState"
  );
  if (
    reportedMissionLifecycleState &&
    !isKnownMissionLifecycleState(reportedMissionLifecycleState)
  ) {
    issues.push({
      path: "reportedMissionLifecycleState",
      message: "reportedMissionLifecycleState must be a known mission state"
    });
  }
  const lastTelemetryObservedAt = readRequiredIsoTimestamp(
    body,
    "lastTelemetryObservedAt",
    issues
  );
  const edgeAgentVersion = readRequiredString(body, "edgeAgentVersion", issues);

  if (
    issues.length > 0 ||
    !robotId ||
    !edgeSessionId ||
    !connectedAt ||
    lastSeenCommandSequence === undefined ||
    !lastTelemetryObservedAt ||
    !edgeAgentVersion
  ) {
    return invalid(issues);
  }

  return valid({
    schemaVersion: protocolSchemaVersions.reconnectHandshake,
    robotId,
    edgeSessionId,
    connectedAt,
    lastSeenCommandSequence,
    ...(lastAcknowledgedCommandId ? { lastAcknowledgedCommandId } : {}),
    ...(reportedMissionId ? { reportedMissionId } : {}),
    ...(reportedMissionLifecycleState && isKnownMissionLifecycleState(reportedMissionLifecycleState)
      ? { reportedMissionLifecycleState }
      : {}),
    lastTelemetryObservedAt,
    edgeAgentVersion
  });
}

/** Converts an edge hello payload into the typed wire message. */
function parseEdgeHello(body: unknown): ValidationResult<EdgeWireMessage> {
  const issues: ValidationIssue[] = [];
  const payload = body === undefined ? {} : body;
  if (!isRecord(payload)) {
    return invalid([{ path: "payload", message: "payload must be an object" }]);
  }

  const edgeSessionId = readOptionalString(payload, "edgeSessionId");
  const edgeAgentVersion = readOptionalString(payload, "edgeAgentVersion");
  const lastSeenCommandSequence = readOptionalNonNegativeInteger(
    payload,
    "lastSeenCommandSequence",
    issues
  );

  if (issues.length > 0) {
    return invalid(issues);
  }

  const helloPayload: EdgeHelloPayload = {
    ...(edgeSessionId ? { edgeSessionId } : {}),
    ...(edgeAgentVersion ? { edgeAgentVersion } : {}),
    ...(lastSeenCommandSequence !== undefined ? { lastSeenCommandSequence } : {})
  };

  return valid({ type: "edge.hello", payload: helloPayload });
}

/** Maps a nested validation result while preserving validation errors. */
function mapPayload<TInput, TOutput>(
  result: ValidationResult<TInput>,
  mapper: (value: TInput) => TOutput
): ValidationResult<TOutput> {
  if (!result.ok) {
    return result;
  }
  return valid(mapper(result.value));
}

/** Builds a successful validation result. */
function valid<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

/** Builds a failed validation result with at least one issue. */
function invalid<T>(issues: readonly ValidationIssue[]): ValidationResult<T> {
  return {
    ok: false,
    issues:
      issues.length > 0
        ? issues
        : [{ path: "$", message: "request validation failed" }]
  };
}

/** Checks whether a value is a non-array JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a required non-empty string and records an issue when missing. */
function readRequiredString(
  record: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): string | undefined {
  const value = record[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  issues.push({ path: key, message: `${key} must be a non-empty string` });
  return undefined;
}

/** Reads an optional non-empty string. Empty strings are treated as absent. */
function readOptionalString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}

/** Reads an optional boolean and reports type mismatches. */
function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  issues.push({ path: key, message: `${key} must be a boolean` });
  return undefined;
}

/** Reads an optional enum value from a readonly list. */
function readOptionalEnum<TValue extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly TValue[],
  issues: ValidationIssue[]
): TValue | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    issues.push({ path: key, message: `${key} must be one of: ${allowed.join(", ")}` });
    return undefined;
  }
  if (!allowed.includes(value as TValue)) {
    issues.push({ path: key, message: `${key} must be one of: ${allowed.join(", ")}` });
    return undefined;
  }
  return value as TValue;
}

/** Reads a required enum value from a readonly list. */
function readRequiredEnum<TValue extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly TValue[],
  issues: ValidationIssue[]
): TValue | undefined {
  const value = record[key];
  if (typeof value !== "string" || !allowed.includes(value as TValue)) {
    issues.push({ path: key, message: `${key} must be one of: ${allowed.join(", ")}` });
    return undefined;
  }
  return value as TValue;
}

/** Reads an optional positive integer field. */
function readOptionalPositiveInteger(
  record: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (Number.isInteger(value) && Number(value) > 0) {
    return Number(value);
  }
  issues.push({ path: key, message: `${key} must be a positive integer` });
  return undefined;
}

/** Reads a required non-negative integer field. */
function readRequiredNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): number | undefined {
  const value = record[key];
  if (Number.isInteger(value) && Number(value) >= 0) {
    return Number(value);
  }
  issues.push({ path: key, message: `${key} must be a non-negative integer` });
  return undefined;
}

/** Reads an optional non-negative integer field. */
function readOptionalNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (Number.isInteger(value) && Number(value) >= 0) {
    return Number(value);
  }
  issues.push({ path: key, message: `${key} must be a non-negative integer` });
  return undefined;
}

/** Reads a required ISO timestamp string. */
function readRequiredIsoTimestamp(
  record: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): string | undefined {
  const value = readRequiredString(record, key, issues);
  if (value && !isIsoTimestamp(value)) {
    issues.push({ path: key, message: `${key} must be an ISO timestamp` });
    return undefined;
  }
  return value;
}

/** Reads a bounded number field such as battery percentage. */
function readNumberInRange(
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  issues: ValidationIssue[]
): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) {
    return value;
  }
  issues.push({ path: key, message: `${key} must be a finite number from ${min} to ${max}` });
  return undefined;
}

/** Reads and validates the 2D pose object shared by commands and telemetry. */
function readPose(
  value: unknown,
  issues: ValidationIssue[]
): { readonly x: number; readonly y: number; readonly theta: number } | undefined {
  if (!isRecord(value)) {
    issues.push({ path: "pose", message: "pose must be an object" });
    return undefined;
  }

  const x = readFiniteNumber(value, "pose.x", "x", issues);
  const y = readFiniteNumber(value, "pose.y", "y", issues);
  const theta = readFiniteNumber(value, "pose.theta", "theta", issues);
  if (x === undefined || y === undefined || theta === undefined) {
    return undefined;
  }

  return { x, y, theta };
}

/** Reads a finite number from an object while reporting a fully qualified issue path. */
function readFiniteNumber(
  record: Record<string, unknown>,
  path: string,
  key: string,
  issues: ValidationIssue[]
): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  issues.push({ path, message: `${path} must be a finite number` });
  return undefined;
}

/** Requires a literal protocol version value. */
function requireConst(
  record: Record<string, unknown>,
  key: string,
  expected: string,
  issues: ValidationIssue[]
): void {
  if (record[key] !== expected) {
    issues.push({ path: key, message: `${key} must be ${expected}` });
  }
}
