import pg from "pg";
import type { Pool, PoolConfig, QueryResultRow } from "pg";

import { fleetPersistenceSchema } from "./postgres-migrations.js";

const { Pool: PgPool } = pg;

const outboxTableName = `${fleetPersistenceSchema}.outbox_events`;

/** Maximum stored failure text keeps diagnostics useful without turning rows into logs. */
export const maxOutboxErrorTextLength = 512;

/** Connection options for the Postgres transactional outbox helper. */
export interface PostgresOutboxStoreOptions {
  readonly databaseUrl?: string;
  readonly pool?: Pool;
  readonly poolConfig?: PoolConfig;
}

/** Input for claiming a bounded batch of currently available outbox rows. */
export interface ClaimOutboxBatchOptions {
  readonly workerId: string;
  readonly batchSize: number;
  readonly now?: Date | string;
}

/** Input for marking a claimed row as successfully published. */
export interface MarkOutboxEventPublishedOptions {
  readonly outboxId: string;
  readonly workerId: string;
  readonly publishedAt?: Date | string;
}

/** Input for releasing a failed claimed row for a later retry. */
export interface RecordOutboxEventFailureOptions {
  readonly outboxId: string;
  readonly workerId: string;
  readonly retryAt: Date | string;
  readonly error: unknown;
}

/** Outbox event row claimed by one worker for at-least-once processing. */
export interface ClaimedOutboxEvent {
  readonly outboxId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly createdAt: string;
  readonly availableAt: string;
  readonly lockedAt: string;
  readonly lockedBy: string;
  readonly attemptCount: number;
}

/** Postgres helper for claiming, publishing, and retrying transactional outbox rows. */
export class PostgresOutboxStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(options: PostgresOutboxStoreOptions) {
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

  /** Claims the oldest currently available unpublished rows for one worker. */
  async claimBatch(
    options: ClaimOutboxBatchOptions
  ): Promise<readonly ClaimedOutboxEvent[]> {
    const workerId = requireWorkerId(options.workerId);
    const batchSize = requirePositiveInteger(options.batchSize, "batchSize");
    const now = options.now ?? new Date();

    const result = await this.pool.query<OutboxEventRow>(
      [
        "WITH candidate AS (",
        "  SELECT outbox_id",
        `  FROM ${outboxTableName}`,
        "  WHERE published_at IS NULL",
        "    AND locked_at IS NULL",
        "    AND available_at <= $1",
        "  ORDER BY available_at, created_at, outbox_id",
        "  LIMIT $2",
        "  FOR UPDATE SKIP LOCKED",
        ")",
        `UPDATE ${outboxTableName} AS outbox`,
        "SET locked_at = $1,",
        "    locked_by = $3,",
        "    attempt_count = outbox.attempt_count + 1",
        "FROM candidate",
        "WHERE outbox.outbox_id = candidate.outbox_id",
        "RETURNING outbox.outbox_id, outbox.aggregate_type, outbox.aggregate_id,",
        "  outbox.event_type, outbox.payload_json, outbox.correlation_id,",
        "  outbox.causation_id, outbox.created_at, outbox.available_at,",
        "  outbox.locked_at, outbox.locked_by, outbox.attempt_count"
      ].join("\n"),
      [now, batchSize, workerId]
    );

    return result.rows.map(toClaimedOutboxEvent).sort(compareClaimedOutboxEvents);
  }

  /** Marks a row published only when it is still claimed by the expected worker. */
  async markPublished(
    options: MarkOutboxEventPublishedOptions
  ): Promise<boolean> {
    const workerId = requireWorkerId(options.workerId);
    const publishedAt = options.publishedAt ?? new Date();
    const result = await this.pool.query(
      [
        `UPDATE ${outboxTableName}`,
        "SET published_at = $3,",
        "    locked_at = NULL,",
        "    locked_by = NULL,",
        "    last_error = NULL",
        "WHERE outbox_id = $1",
        "  AND locked_by = $2",
        "  AND locked_at IS NOT NULL",
        "  AND published_at IS NULL"
      ].join("\n"),
      [options.outboxId, workerId, publishedAt]
    );
    return result.rowCount === 1;
  }

  /** Records a sanitized failure and clears the claim so another pass can retry later. */
  async recordFailure(
    options: RecordOutboxEventFailureOptions
  ): Promise<boolean> {
    const workerId = requireWorkerId(options.workerId);
    const result = await this.pool.query(
      [
        `UPDATE ${outboxTableName}`,
        "SET available_at = $3,",
        "    locked_at = NULL,",
        "    locked_by = NULL,",
        "    last_error = $4",
        "WHERE outbox_id = $1",
        "  AND locked_by = $2",
        "  AND locked_at IS NOT NULL",
        "  AND published_at IS NULL"
      ].join("\n"),
      [
        options.outboxId,
        workerId,
        options.retryAt,
        sanitizeOutboxErrorText(options.error)
      ]
    );
    return result.rowCount === 1;
  }
}

/** Converts arbitrary failure values into bounded text safe to store or surface. */
export function sanitizeOutboxErrorText(error: unknown): string {
  const rawText = error instanceof Error ? error.message : String(error);
  const sanitized = rawText
    .replaceAll(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/g, "[redacted-url]")
    .replaceAll(
      /\b(password|passwd|pwd|user|username)=([^\s"'<>]+)/gi,
      "$1=[redacted]"
    )
    .replaceAll(/[\r\n\t]/g, " ")
    .replaceAll(/\s{2,}/g, " ")
    .trim();
  const fallback = sanitized.length > 0 ? sanitized : "outbox publication failed";

  if (fallback.length <= maxOutboxErrorTextLength) {
    return fallback;
  }
  return `${fallback.slice(0, maxOutboxErrorTextLength - 3)}...`;
}

interface OutboxEventRow extends QueryResultRow {
  readonly outbox_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly payload_json: unknown;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly created_at: Date | string;
  readonly available_at: Date | string;
  readonly locked_at: Date | string;
  readonly locked_by: string;
  readonly attempt_count: number | string;
}

/** Maps Postgres row names and timestamp values into the public claimed event shape. */
function toClaimedOutboxEvent(row: OutboxEventRow): ClaimedOutboxEvent {
  return {
    outboxId: row.outbox_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: readJsonObject(row.payload_json, `outbox payload ${row.outbox_id}`),
    correlationId: row.correlation_id,
    ...(row.causation_id !== null ? { causationId: row.causation_id } : {}),
    createdAt: toIsoTimestamp(row.created_at),
    availableAt: toIsoTimestamp(row.available_at),
    lockedAt: toIsoTimestamp(row.locked_at),
    lockedBy: row.locked_by,
    attemptCount: toNumber(row.attempt_count)
  };
}

/** Keeps claimed rows in deterministic queue order after UPDATE RETURNING. */
function compareClaimedOutboxEvents(
  left: ClaimedOutboxEvent,
  right: ClaimedOutboxEvent
): number {
  return (
    left.availableAt.localeCompare(right.availableAt) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.outboxId.localeCompare(right.outboxId)
  );
}

/** Rejects blank worker identifiers before they become durable lock metadata. */
function requireWorkerId(workerId: string): string {
  const normalized = workerId.trim();
  if (normalized.length === 0) {
    throw new Error("workerId is required");
  }
  return normalized;
}

/** Validates caller-owned limits so the claim query stays bounded. */
function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

/** Converts Postgres timestamps to ISO strings used by app-facing DTOs. */
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

/** Validates jsonb object values before publishing code depends on object fields. */
function readJsonObject(
  value: unknown,
  description: string
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${description} to be a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}
