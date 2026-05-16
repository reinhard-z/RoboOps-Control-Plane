import { createHash } from "node:crypto";

import pg from "pg";
import type { Pool, PoolClient, PoolConfig, QueryResultRow } from "pg";

import {
  type DomainState,
  type IdempotencyRecord,
  type MissionSnapshot,
  type RobotSnapshot,
  createInitialDomainState
} from "@roboops/fleet-domain";
import type {
  AuditEventV1,
  CommandEnvelopeV1,
  EventEnvelopeV1,
  RobotId
} from "@roboops/fleet-protocol";

import { fleetPersistenceSchema } from "./postgres-migrations.js";
import type {
  DomainStateMutator,
  DomainStateRepository
} from "./repository.js";

const { Pool: PgPool } = pg;

const repositoryLockName = "roboops_fleet_persistence_domain_state";
const currentStateId = "current";

const tableNames = {
  auditEvents: `${fleetPersistenceSchema}.audit_events`,
  commandAcks: `${fleetPersistenceSchema}.command_acks`,
  commands: `${fleetPersistenceSchema}.commands`,
  domainEvents: `${fleetPersistenceSchema}.domain_events`,
  idempotencyKeys: `${fleetPersistenceSchema}.idempotency_keys`,
  missions: `${fleetPersistenceSchema}.missions`,
  outboxEvents: `${fleetPersistenceSchema}.outbox_events`,
  robotSessions: `${fleetPersistenceSchema}.robot_sessions`,
  robotTelemetryEvents: `${fleetPersistenceSchema}.robot_telemetry_events`,
  robots: `${fleetPersistenceSchema}.robots`,
  stateBookmarks: `${fleetPersistenceSchema}.domain_state_bookmarks`
} as const;

/** Internal row shape queued for later at-least-once publication workers. */
interface OutboxRecord {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: EventEnvelopeV1 | AuditEventV1;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly dedupeKey: string;
}

/** SQL for inserting one transactional outbox row with idempotent dedupe handling. */
const insertOutboxRecordSql = `
INSERT INTO ${tableNames.outboxEvents} (
  aggregate_type,
  aggregate_id,
  event_type,
  payload_json,
  correlation_id,
  causation_id,
  dedupe_key
) VALUES (
  $1,
  $2,
  $3,
  $4::jsonb,
  $5,
  $6,
  $7
)
ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
`;

/** Connection options for the Postgres-backed whole-state repository adapter. */
export interface PostgresDomainStateRepositoryOptions {
  readonly databaseUrl?: string;
  readonly pool?: Pool;
  readonly poolConfig?: PoolConfig;
}

/** Postgres implementation of the current DomainStateRepository boundary. */
export class PostgresDomainStateRepository implements DomainStateRepository {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(options: PostgresDomainStateRepositoryOptions) {
    if (options.pool && (options.databaseUrl || options.poolConfig)) {
      throw new Error("Pass either an existing Postgres pool or connection config");
    }

    this.ownsPool = !options.pool;
    this.pool =
      options.pool ??
      new PgPool({
        ...options.poolConfig,
        connectionString: options.databaseUrl ?? options.poolConfig?.connectionString
      });
  }

  /** Closes the internally owned pool; externally supplied pools remain caller-owned. */
  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async read(): Promise<DomainState> {
    return this.withTransaction(
      (client) => readDomainState(client),
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
    );
  }

  async write(state: DomainState): Promise<void> {
    await this.withTransaction(async (client) => {
      await lockRepository(client);
      const currentState = await readDomainState(client);
      const outboxRecords = selectNewOutboxRecords(currentState, state);
      await replaceDomainState(client, state, outboxRecords);
    });
  }

  async reset(state: DomainState): Promise<void> {
    await this.withTransaction(async (client) => {
      await lockRepository(client);
      await replaceDomainState(client, state);
    });
  }

  async update<TResult>(mutator: DomainStateMutator<TResult>): Promise<TResult> {
    return this.withTransaction(async (client) => {
      await lockRepository(client);
      const currentState = await readDomainState(client);
      const mutation = mutator(currentState);
      const outboxRecords = selectNewOutboxRecords(currentState, mutation.state);
      await replaceDomainState(client, mutation.state, outboxRecords);
      return mutation.result;
    });
  }

  /** Runs one repository operation in an explicit transaction with rollback on failure. */
  private async withTransaction<TResult>(
    operation: (client: PoolClient) => Promise<TResult>,
    beginSql = "BEGIN"
  ): Promise<TResult> {
    const client = await this.pool.connect();
    try {
      await client.query(beginSql);
      try {
        const result = await operation(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      client.release();
    }
  }
}

/** Serializes repository writers so read-modify-write updates cannot overwrite each other. */
async function lockRepository(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    repositoryLockName
  ]);
}

/** Loads the complete reducer aggregate from relational tables and bookmark metadata. */
async function readDomainState(client: PoolClient): Promise<DomainState> {
  const bookmarks = await readStateBookmarks(client);
  const robots = await readRobots(client);
  const missions = await readMissions(client);
  const commands = await readCommands(client);
  const idempotencyRecords = await readIdempotencyRecords(client);
  const domainEvents = await readDomainEvents(client, bookmarks.domainEventIds);
  const auditEvents = await readAuditEvents(client, bookmarks.auditEventIds);

  return {
    robots,
    missions,
    commands,
    idempotencyRecords,
    processedEventIds: bookmarks.processedEventIds,
    processedAckIds: bookmarks.processedAckIds,
    processedReconnectSessionIds: bookmarks.processedReconnectSessionIds,
    nextSequenceByRobot: bookmarks.nextSequenceByRobot,
    domainEvents,
    auditEvents
  };
}

/** Replaces the current repository view while preserving schema-level integrity checks. */
async function replaceDomainState(
  client: PoolClient,
  state: DomainState,
  outboxRecords: readonly OutboxRecord[] = []
): Promise<void> {
  await clearDomainState(client);
  await insertRobots(client, Object.values(state.robots));
  await insertMissions(client, Object.values(state.missions));
  await insertCommands(client, Object.values(state.commands));
  await insertDomainEvents(client, state.domainEvents);
  await insertAuditEvents(client, state.auditEvents);
  await insertOutboxRecords(client, outboxRecords);
  await insertIdempotencyRecords(client, Object.values(state.idempotencyRecords));
  await resolvePreservedFactLogReferences(client);
  await writeStateBookmarks(client, state);
}

/** Infers new reducer records from whole-state replacement using stable envelope identity. */
function selectNewOutboxRecords(
  currentState: DomainState,
  nextState: DomainState
): readonly OutboxRecord[] {
  const persistedKeys = new Set([
    ...currentState.domainEvents.map(domainEventDedupeKey),
    ...currentState.auditEvents.map(auditEventDedupeKey)
  ]);
  const records: OutboxRecord[] = [];

  for (const event of nextState.domainEvents) {
    const dedupeKey = domainEventDedupeKey(event);
    if (!persistedKeys.has(dedupeKey)) {
      records.push(domainEventOutboxRecord(event, dedupeKey));
    }
  }

  for (const event of nextState.auditEvents) {
    const dedupeKey = auditEventDedupeKey(event);
    if (!persistedKeys.has(dedupeKey)) {
      records.push(auditEventOutboxRecord(event, dedupeKey));
    }
  }

  return records;
}

/** Converts a domain event envelope into the generic outbox queue row shape. */
function domainEventOutboxRecord(
  event: EventEnvelopeV1,
  dedupeKey: string
): OutboxRecord {
  return {
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    payload: event,
    correlationId: event.correlationId,
    ...(event.causationId !== undefined ? { causationId: event.causationId } : {}),
    dedupeKey
  };
}

/** Converts an audit event into an outbox row while preserving its full envelope. */
function auditEventOutboxRecord(
  event: AuditEventV1,
  dedupeKey: string
): OutboxRecord {
  const aggregate = auditEventAggregate(event);
  return {
    aggregateType: aggregate.type,
    aggregateId: aggregate.id,
    eventType: event.action,
    payload: event,
    correlationId: event.correlationId,
    ...(event.causationId !== undefined ? { causationId: event.causationId } : {}),
    dedupeKey
  };
}

/** Chooses the most specific aggregate hint available on an audit event. */
function auditEventAggregate(
  event: AuditEventV1
): { readonly type: string; readonly id: string } {
  if (event.missionId) {
    return { type: "mission", id: event.missionId };
  }
  if (event.robotId) {
    return { type: "robot", id: event.robotId };
  }
  if (event.commandId) {
    return { type: "command", id: event.commandId };
  }
  return { type: "system", id: event.auditEventId };
}

/** Names the durable identity used by the outbox uniqueness guard for domain events. */
function domainEventDedupeKey(event: EventEnvelopeV1): string {
  return `domain:${event.eventId}:${stableValueSha256(event)}`;
}

/** Names the durable identity used by the outbox uniqueness guard for audit events. */
function auditEventDedupeKey(event: AuditEventV1): string {
  return `audit:${event.auditEventId}:${stableValueSha256(event)}`;
}

/** Clears state-owned tables while preserving append-only edge fact logs. */
async function clearDomainState(client: PoolClient): Promise<void> {
  await client.query(`DELETE FROM ${tableNames.stateBookmarks}`);
  await client.query(`DELETE FROM ${tableNames.idempotencyKeys}`);
  await client.query(`DELETE FROM ${tableNames.auditEvents}`);
  await client.query(`DELETE FROM ${tableNames.domainEvents}`);
  await detachPreservedFactLogReferences(client);
  await client.query(`DELETE FROM ${tableNames.commands}`);
  await client.query(`DELETE FROM ${tableNames.missions}`);
  await client.query(`DELETE FROM ${tableNames.robots}`);
}

/** Detaches nullable resolved references before canonical snapshot rows are replaced. */
async function detachPreservedFactLogReferences(client: PoolClient): Promise<void> {
  await client.query(
    [
      `UPDATE ${tableNames.commandAcks}`,
      "SET resolved_command_id = NULL,",
      "    resolved_mission_id = NULL",
      "WHERE resolved_command_id IS NOT NULL",
      "   OR resolved_mission_id IS NOT NULL"
    ].join("\n")
  );
  await client.query(
    [
      `UPDATE ${tableNames.robotTelemetryEvents}`,
      "SET resolved_robot_id = NULL,",
      "    resolved_mission_id = NULL",
      "WHERE resolved_robot_id IS NOT NULL",
      "   OR resolved_mission_id IS NOT NULL"
    ].join("\n")
  );
  await client.query(
    [
      `UPDATE ${tableNames.robotSessions}`,
      "SET resolved_robot_id = NULL",
      "WHERE resolved_robot_id IS NOT NULL"
    ].join("\n")
  );
}

/** Reconnects preserved fact logs to matching canonical rows after replacement. */
async function resolvePreservedFactLogReferences(client: PoolClient): Promise<void> {
  await client.query(
    [
      `UPDATE ${tableNames.commandAcks} AS ack`,
      "SET resolved_command_id = command.command_id",
      `FROM ${tableNames.commands} AS command`,
      "WHERE ack.command_id = command.command_id",
      "  AND ack.resolved_command_id IS DISTINCT FROM command.command_id"
    ].join("\n")
  );
  await client.query(
    [
      `UPDATE ${tableNames.commandAcks} AS ack`,
      "SET resolved_mission_id = mission.mission_id",
      `FROM ${tableNames.missions} AS mission`,
      "WHERE ack.mission_id = mission.mission_id",
      "  AND ack.resolved_mission_id IS DISTINCT FROM mission.mission_id"
    ].join("\n")
  );
  await client.query(
    [
      `UPDATE ${tableNames.robotTelemetryEvents} AS telemetry`,
      "SET resolved_robot_id = robot.robot_id",
      `FROM ${tableNames.robots} AS robot`,
      "WHERE telemetry.robot_id = robot.robot_id",
      "  AND telemetry.resolved_robot_id IS DISTINCT FROM robot.robot_id"
    ].join("\n")
  );
  await client.query(
    [
      `UPDATE ${tableNames.robotTelemetryEvents} AS telemetry`,
      "SET resolved_mission_id = mission.mission_id",
      `FROM ${tableNames.missions} AS mission`,
      "WHERE telemetry.current_mission_id = mission.mission_id",
      "  AND telemetry.resolved_mission_id IS DISTINCT FROM mission.mission_id"
    ].join("\n")
  );
  await client.query(
    [
      `UPDATE ${tableNames.robotSessions} AS session`,
      "SET resolved_robot_id = robot.robot_id",
      `FROM ${tableNames.robots} AS robot`,
      "WHERE session.robot_id = robot.robot_id",
      "  AND session.resolved_robot_id IS DISTINCT FROM robot.robot_id"
    ].join("\n")
  );
}

/** Inserts robot snapshots into the canonical robot table. */
async function insertRobots(
  client: PoolClient,
  robots: readonly RobotSnapshot[]
): Promise<void> {
  for (const robot of robots) {
    await client.query(
      [
        `INSERT INTO ${tableNames.robots} (`,
        "  robot_id, connection_state, health, battery_percent, active_mission_id,",
        "  last_telemetry_observed_at, last_telemetry_received_at,",
        "  last_acknowledged_command_id, last_seen_command_sequence,",
        "  edge_agent_version, snapshot_json, updated_at",
        ") VALUES (",
        "  $1, $2, $3, $4, $5,",
        "  $6, $7, $8, $9, $10, $11::jsonb, $12",
        ")"
      ].join("\n"),
      [
        robot.robotId,
        robot.connectionState,
        robot.health ?? null,
        robot.batteryPercent ?? null,
        robot.activeMissionId ?? null,
        robot.lastTelemetryObservedAt ?? null,
        robot.lastTelemetryReceivedAt ?? null,
        robot.lastAcknowledgedCommandId ?? null,
        robot.lastSeenCommandSequence,
        robot.edgeAgentVersion ?? null,
        jsonb(robot),
        robot.updatedAt
      ]
    );
  }
}

/** Inserts mission snapshots with robot references enforced by Postgres. */
async function insertMissions(
  client: PoolClient,
  missions: readonly MissionSnapshot[]
): Promise<void> {
  for (const mission of missions) {
    await client.query(
      [
        `INSERT INTO ${tableNames.missions} (`,
        "  mission_id, robot_id, lifecycle_state, operational_status,",
        "  current_command_id, last_command_sequence,",
        "  last_acknowledged_command_id, last_acknowledged_command_sequence,",
        "  idempotency_key, failure_reason, snapshot_json, created_at, updated_at",
        ") VALUES (",
        "  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13",
        ")"
      ].join("\n"),
      [
        mission.missionId,
        mission.robotId,
        mission.lifecycleState,
        mission.operationalStatus,
        mission.currentCommandId ?? null,
        mission.lastCommandSequence ?? null,
        mission.lastAcknowledgedCommandId ?? null,
        mission.lastAcknowledgedCommandSequence ?? null,
        mission.idempotencyKey ?? null,
        mission.failureReason ?? null,
        jsonb(mission),
        mission.createdAt,
        mission.updatedAt
      ]
    );
  }
}

/** Inserts command envelopes as a durable command log plus JSON payload facts. */
async function insertCommands(
  client: PoolClient,
  commands: readonly CommandEnvelopeV1[]
): Promise<void> {
  for (const command of commands) {
    await client.query(
      [
        `INSERT INTO ${tableNames.commands} (`,
        "  command_id, mission_id, robot_id, type, idempotency_key, sequence,",
        "  issued_at, expires_at, requires_ack, safety_class, correlation_id,",
        "  causation_id, payload_json, envelope_json",
        ") VALUES (",
        "  $1, $2, $3, $4, $5, $6,",
        "  $7, $8, $9, $10, $11,",
        "  $12, $13::jsonb, $14::jsonb",
        ")"
      ].join("\n"),
      [
        command.commandId,
        command.missionId,
        command.robotId,
        command.type,
        command.idempotencyKey,
        command.sequence,
        command.issuedAt,
        command.expiresAt,
        command.requiresAck,
        command.safetyClass,
        command.correlationId,
        command.causationId,
        jsonb(command.payload),
        jsonb(command)
      ]
    );
  }
}

/** Inserts reducer-produced domain events without forcing unresolved IDs through FKs. */
async function insertDomainEvents(
  client: PoolClient,
  events: readonly EventEnvelopeV1[]
): Promise<void> {
  for (const event of events) {
    await client.query(
      [
        `INSERT INTO ${tableNames.domainEvents} (`,
        "  event_id, aggregate_type, aggregate_id, event_type, occurred_at,",
        "  received_at, mission_id, robot_id, command_id, correlation_id,",
        "  causation_id, payload_json, envelope_json",
        ") VALUES (",
        "  $1, $2, $3, $4, $5,",
        "  $6, $7, $8, $9, $10,",
        "  $11, $12::jsonb, $13::jsonb",
        ")"
      ].join("\n"),
      [
        event.eventId,
        event.aggregateType,
        event.aggregateId,
        event.eventType,
        event.occurredAt,
        event.receivedAt,
        eventMissionId(event),
        eventRobotId(event),
        eventCommandId(event),
        event.correlationId,
        event.causationId ?? null,
        jsonb(event.payload),
        jsonb(event)
      ]
    );
  }
}

/** Inserts audit events with details stored as the operator-facing JSON fact. */
async function insertAuditEvents(
  client: PoolClient,
  events: readonly AuditEventV1[]
): Promise<void> {
  for (const event of events) {
    await client.query(
      [
        `INSERT INTO ${tableNames.auditEvents} (`,
        "  audit_event_id, actor_type, action, occurred_at, mission_id,",
        "  robot_id, command_id, correlation_id, causation_id,",
        "  details_json, envelope_json",
        ") VALUES (",
        "  $1, $2, $3, $4, $5,",
        "  $6, $7, $8, $9,",
        "  $10::jsonb, $11::jsonb",
        ")"
      ].join("\n"),
      [
        event.auditEventId,
        event.actorType,
        event.action,
        event.occurredAt,
        event.missionId ?? null,
        event.robotId ?? null,
        event.commandId ?? null,
        event.correlationId,
        event.causationId ?? null,
        jsonb(event.details),
        jsonb(event)
      ]
    );
  }
}

/** Queues new reducer records for future publication without publishing externally. */
async function insertOutboxRecords(
  client: PoolClient,
  records: readonly OutboxRecord[]
): Promise<void> {
  for (const record of records) {
    await client.query(insertOutboxRecordSql, outboxRecordParameters(record));
  }
}

/** Maps an outbox record to query parameters in SQL placeholder order. */
function outboxRecordParameters(record: OutboxRecord): unknown[] {
  return [
    record.aggregateType,
    record.aggregateId,
    record.eventType,
    jsonb(record.payload),
    record.correlationId,
    record.causationId ?? null,
    record.dedupeKey
  ];
}

/** Inserts idempotency records after their command and mission references exist. */
async function insertIdempotencyRecords(
  client: PoolClient,
  records: readonly IdempotencyRecord[]
): Promise<void> {
  for (const record of records) {
    await client.query(
      [
        `INSERT INTO ${tableNames.idempotencyKeys} (`,
        '  "key", payload_signature, mission_id, command_id, record_json, updated_at',
        ") VALUES (",
        "  $1, $2, $3, $4, $5::jsonb, now()",
        ")"
      ].join("\n"),
      [
        record.idempotencyKey,
        record.payloadSignature,
        record.missionId,
        record.commandId,
        jsonb(record)
      ]
    );
  }
}

/** Writes reducer bookkeeping that does not belong in a canonical entity table. */
async function writeStateBookmarks(
  client: PoolClient,
  state: DomainState
): Promise<void> {
  await client.query(
    [
      `INSERT INTO ${tableNames.stateBookmarks} (`,
      "  state_id, processed_event_ids, processed_ack_ids,",
      "  processed_reconnect_session_ids, next_sequence_by_robot,",
      "  domain_event_ids, audit_event_ids, updated_at",
      ") VALUES (",
      "  $1, $2::text[], $3::text[], $4::text[], $5::jsonb, $6::text[], $7::text[], now()",
      ")"
    ].join("\n"),
    [
      currentStateId,
      [...state.processedEventIds],
      [...state.processedAckIds],
      [...state.processedReconnectSessionIds],
      jsonb(state.nextSequenceByRobot),
      state.domainEvents.map((event) => event.eventId),
      state.auditEvents.map((event) => event.auditEventId)
    ]
  );
}

interface StateBookmarkRow extends QueryResultRow {
  readonly processed_event_ids: readonly string[];
  readonly processed_ack_ids: readonly string[];
  readonly processed_reconnect_session_ids: readonly string[];
  readonly next_sequence_by_robot: unknown;
  readonly domain_event_ids: readonly string[];
  readonly audit_event_ids: readonly string[];
}

interface StateBookmarks {
  readonly processedEventIds: readonly string[];
  readonly processedAckIds: readonly string[];
  readonly processedReconnectSessionIds: readonly string[];
  readonly nextSequenceByRobot: Readonly<Record<RobotId, number>>;
  readonly domainEventIds: readonly string[];
  readonly auditEventIds: readonly string[];
}

/** Reads singleton reducer bookkeeping, defaulting to an empty state for new schemas. */
async function readStateBookmarks(client: PoolClient): Promise<StateBookmarks> {
  const result = await client.query<StateBookmarkRow>(
    [
      "SELECT processed_event_ids, processed_ack_ids,",
      "  processed_reconnect_session_ids, next_sequence_by_robot,",
      "  domain_event_ids, audit_event_ids",
      `FROM ${tableNames.stateBookmarks}`,
      "WHERE state_id = $1"
    ].join("\n"),
    [currentStateId]
  );
  const row = result.rows[0];
  if (!row) {
    const emptyState = createInitialDomainState();
    return {
      processedEventIds: emptyState.processedEventIds,
      processedAckIds: emptyState.processedAckIds,
      processedReconnectSessionIds: emptyState.processedReconnectSessionIds,
      nextSequenceByRobot: emptyState.nextSequenceByRobot,
      domainEventIds: [],
      auditEventIds: []
    };
  }

  return {
    processedEventIds: [...row.processed_event_ids],
    processedAckIds: [...row.processed_ack_ids],
    processedReconnectSessionIds: [...row.processed_reconnect_session_ids],
    nextSequenceByRobot: readNextSequenceByRobot(row.next_sequence_by_robot),
    domainEventIds: [...row.domain_event_ids],
    auditEventIds: [...row.audit_event_ids]
  };
}

interface RobotRow extends QueryResultRow {
  readonly robot_id: string;
  readonly connection_state: string;
  readonly health: string | null;
  readonly battery_percent: number | null;
  readonly active_mission_id: string | null;
  readonly last_telemetry_observed_at: Date | string | null;
  readonly last_telemetry_received_at: Date | string | null;
  readonly last_acknowledged_command_id: string | null;
  readonly last_seen_command_sequence: number | string;
  readonly edge_agent_version: string | null;
  readonly updated_at: Date | string;
}

/** Reads canonical robot rows into reducer snapshots. */
async function readRobots(
  client: PoolClient
): Promise<Readonly<Record<string, RobotSnapshot>>> {
  const result = await client.query<RobotRow>(
    [
      "SELECT robot_id, connection_state, health, battery_percent, active_mission_id,",
      "  last_telemetry_observed_at, last_telemetry_received_at,",
      "  last_acknowledged_command_id, last_seen_command_sequence,",
      "  edge_agent_version, updated_at",
      `FROM ${tableNames.robots}`,
      "ORDER BY robot_id"
    ].join("\n")
  );
  const robots: Record<string, RobotSnapshot> = {};
  for (const row of result.rows) {
    robots[row.robot_id] = {
      robotId: row.robot_id,
      connectionState: row.connection_state as RobotSnapshot["connectionState"],
      updatedAt: toIsoTimestamp(row.updated_at),
      ...(row.health !== null
        ? { health: row.health as NonNullable<RobotSnapshot["health"]> }
        : {}),
      ...(row.battery_percent !== null ? { batteryPercent: row.battery_percent } : {}),
      ...(row.active_mission_id !== null
        ? { activeMissionId: row.active_mission_id }
        : {}),
      ...(row.last_telemetry_observed_at
        ? { lastTelemetryObservedAt: toIsoTimestamp(row.last_telemetry_observed_at) }
        : {}),
      ...(row.last_telemetry_received_at
        ? { lastTelemetryReceivedAt: toIsoTimestamp(row.last_telemetry_received_at) }
        : {}),
      ...(row.last_acknowledged_command_id !== null
        ? { lastAcknowledgedCommandId: row.last_acknowledged_command_id }
        : {}),
      lastSeenCommandSequence: toNumber(row.last_seen_command_sequence),
      ...(row.edge_agent_version !== null
        ? { edgeAgentVersion: row.edge_agent_version }
        : {})
    };
  }
  return robots;
}

interface MissionRow extends QueryResultRow {
  readonly mission_id: string;
  readonly robot_id: string;
  readonly lifecycle_state: string;
  readonly operational_status: string;
  readonly current_command_id: string | null;
  readonly last_command_sequence: number | string | null;
  readonly last_acknowledged_command_id: string | null;
  readonly last_acknowledged_command_sequence: number | string | null;
  readonly idempotency_key: string | null;
  readonly failure_reason: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

/** Reads canonical mission rows into reducer snapshots. */
async function readMissions(
  client: PoolClient
): Promise<Readonly<Record<string, MissionSnapshot>>> {
  const result = await client.query<MissionRow>(
    [
      "SELECT mission_id, robot_id, lifecycle_state, operational_status,",
      "  current_command_id, last_command_sequence,",
      "  last_acknowledged_command_id, last_acknowledged_command_sequence,",
      "  idempotency_key, failure_reason, created_at, updated_at",
      `FROM ${tableNames.missions}`,
      "ORDER BY mission_id"
    ].join("\n")
  );
  const missions: Record<string, MissionSnapshot> = {};
  for (const row of result.rows) {
    missions[row.mission_id] = {
      missionId: row.mission_id,
      robotId: row.robot_id,
      lifecycleState: row.lifecycle_state as MissionSnapshot["lifecycleState"],
      operationalStatus: row.operational_status as MissionSnapshot["operationalStatus"],
      createdAt: toIsoTimestamp(row.created_at),
      updatedAt: toIsoTimestamp(row.updated_at),
      ...(row.current_command_id !== null
        ? { currentCommandId: row.current_command_id }
        : {}),
      ...(row.last_command_sequence !== null
        ? { lastCommandSequence: toNumber(row.last_command_sequence) }
        : {}),
      ...(row.last_acknowledged_command_id !== null
        ? { lastAcknowledgedCommandId: row.last_acknowledged_command_id }
        : {}),
      ...(row.last_acknowledged_command_sequence !== null
        ? {
            lastAcknowledgedCommandSequence: toNumber(
              row.last_acknowledged_command_sequence
            )
          }
        : {}),
      ...(row.idempotency_key !== null ? { idempotencyKey: row.idempotency_key } : {}),
      ...(row.failure_reason !== null ? { failureReason: row.failure_reason } : {})
    };
  }
  return missions;
}

interface CommandRow extends QueryResultRow {
  readonly command_id: string;
  readonly envelope_json: unknown;
}

/** Reads command envelopes from their stored JSON while constraints protect key columns. */
async function readCommands(
  client: PoolClient
): Promise<Readonly<Record<string, CommandEnvelopeV1>>> {
  const result = await client.query<CommandRow>(
    [
      "SELECT command_id, envelope_json",
      `FROM ${tableNames.commands}`,
      "ORDER BY robot_id, sequence, command_id"
    ].join("\n")
  );
  const commands: Record<string, CommandEnvelopeV1> = {};
  for (const row of result.rows) {
    commands[row.command_id] = readJsonObject<CommandEnvelopeV1>(
      row.envelope_json,
      `command ${row.command_id}`
    );
  }
  return commands;
}

interface IdempotencyRow extends QueryResultRow {
  readonly key: string;
  readonly payload_signature: string;
  readonly command_id: string;
  readonly mission_id: string;
}

/** Reads idempotency records from constrained columns instead of opaque JSON. */
async function readIdempotencyRecords(
  client: PoolClient
): Promise<Readonly<Record<string, IdempotencyRecord>>> {
  const result = await client.query<IdempotencyRow>(
    [
      'SELECT "key", payload_signature, command_id, mission_id',
      `FROM ${tableNames.idempotencyKeys}`,
      'ORDER BY "key"'
    ].join("\n")
  );
  const records: Record<string, IdempotencyRecord> = {};
  for (const row of result.rows) {
    records[row.key] = {
      idempotencyKey: row.key,
      payloadSignature: row.payload_signature,
      commandId: row.command_id,
      missionId: row.mission_id
    };
  }
  return records;
}

interface DomainEventRow extends QueryResultRow {
  readonly event_id: string;
  readonly envelope_json: unknown;
}

/** Reads domain event envelopes in the reducer order recorded by bookmarks. */
async function readDomainEvents(
  client: PoolClient,
  eventIds: readonly string[]
): Promise<readonly EventEnvelopeV1[]> {
  const result = await client.query<DomainEventRow>(
    [
      "SELECT event_id, envelope_json",
      `FROM ${tableNames.domainEvents}`,
      "ORDER BY event_row_id"
    ].join("\n")
  );
  return orderJsonEnvelopeRows(
    result.rows,
    eventIds,
    "domain event",
    (row) => row.event_id,
    (row) => readJsonObject<EventEnvelopeV1>(row.envelope_json, row.event_id)
  );
}

interface AuditEventRow extends QueryResultRow {
  readonly audit_event_id: string;
  readonly envelope_json: unknown;
}

/** Reads audit event envelopes in the reducer order recorded by bookmarks. */
async function readAuditEvents(
  client: PoolClient,
  eventIds: readonly string[]
): Promise<readonly AuditEventV1[]> {
  const result = await client.query<AuditEventRow>(
    [
      "SELECT audit_event_id, envelope_json",
      `FROM ${tableNames.auditEvents}`,
      "ORDER BY occurred_at, audit_event_id"
    ].join("\n")
  );
  return orderJsonEnvelopeRows(
    result.rows,
    eventIds,
    "audit event",
    (row) => row.audit_event_id,
    (row) => readJsonObject<AuditEventV1>(row.envelope_json, row.audit_event_id)
  );
}

/** Orders JSON rows according to persisted reducer array identity. */
function orderJsonEnvelopeRows<TRow, TValue>(
  rows: readonly TRow[],
  orderedIds: readonly string[],
  label: string,
  getId: (row: TRow) => string,
  getValue: (row: TRow) => TValue
): readonly TValue[] {
  if (orderedIds.length === 0) {
    return rows.map(getValue);
  }

  const rowsById = new Map(rows.map((row) => [getId(row), row]));
  const orderedRows: TValue[] = [];
  for (const id of orderedIds) {
    const row = rowsById.get(id);
    if (!row) {
      throw new Error(`Domain state bookmark references missing ${label} ${id}`);
    }
    orderedRows.push(getValue(row));
    rowsById.delete(id);
  }

  for (const row of rows) {
    if (rowsById.has(getId(row))) {
      orderedRows.push(getValue(row));
    }
  }
  return orderedRows;
}

/** Extracts the best mission identifier hint from a domain event without adding FKs. */
function eventMissionId(event: EventEnvelopeV1): string | null {
  if (event.aggregateType === "mission") {
    return event.aggregateId;
  }
  return stringPayloadField(event.payload, "missionId") ?? null;
}

/** Extracts the best robot identifier hint from a domain event without adding FKs. */
function eventRobotId(event: EventEnvelopeV1): string | null {
  if (event.aggregateType === "robot") {
    return event.aggregateId;
  }
  return stringPayloadField(event.payload, "robotId") ?? null;
}

/** Extracts the best command identifier hint from a domain event without adding FKs. */
function eventCommandId(event: EventEnvelopeV1): string | null {
  if (event.aggregateType === "command") {
    return event.aggregateId;
  }
  return stringPayloadField(event.payload, "commandId") ?? null;
}

/** Returns a string payload field only when an event payload actually contains one. */
function stringPayloadField(
  payload: Readonly<Record<string, unknown>>,
  key: string
): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

/** Serializes a value for jsonb parameters while keeping SQL text parameterized. */
function jsonb(value: unknown): string {
  return JSON.stringify(value);
}

/** Hashes JSON-compatible values after sorting object keys for process-stable identity. */
function stableValueSha256(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

/** Canonical JSON tree used to hash event envelopes without key-order drift. */
type StableJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly StableJsonValue[]
  | { readonly [key: string]: StableJsonValue };

/** Serializes JSON-like values deterministically so jsonb key order cannot affect dedupe. */
function stableJsonStringify(value: unknown): string {
  return JSON.stringify(toStableJsonValue(value));
}

/** Converts protocol envelopes into a canonical JSON-compatible value tree. */
function toStableJsonValue(value: unknown): StableJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(toStableJsonValue);
  }

  if (typeof value === "object") {
    const stableObject: Record<string, StableJsonValue> = {};
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    for (const [key, entryValue] of entries) {
      stableObject[key] = toStableJsonValue(entryValue);
    }
    return stableObject;
  }

  throw new Error(`Cannot create stable JSON for ${typeof value} value`);
}

/** Converts Postgres timestamps to the ISO string shape used by protocol contracts. */
function toIsoTimestamp(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp returned from Postgres: ${value}`);
  }
  return parsed.toISOString();
}

/** Converts bigint-capable Postgres numerics into safe JavaScript numbers. */
function toNumber(value: number | string): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numberValue)) {
    throw new Error(`Unsafe numeric value returned from Postgres: ${value}`);
  }
  return numberValue;
}

/** Validates jsonb object values before casting them back to protocol/domain types. */
function readJsonObject<TValue>(value: unknown, description: string): TValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${description} to be a JSON object`);
  }
  return value as TValue;
}

/** Reads and validates the robot sequence map from jsonb metadata. */
function readNextSequenceByRobot(
  value: unknown
): Readonly<Record<RobotId, number>> {
  const record = readJsonObject<Record<string, unknown>>(
    value,
    "next_sequence_by_robot"
  );
  const nextSequenceByRobot: Record<RobotId, number> = {};
  for (const [robotId, sequence] of Object.entries(record)) {
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence)) {
      throw new Error(`Invalid next sequence for robot ${robotId}`);
    }
    nextSequenceByRobot[robotId] = sequence;
  }
  return nextSequenceByRobot;
}
