import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  PostgresOutboxStore,
  maxOutboxErrorTextLength,
  runPostgresMigrations
} from "../src/index.js";

const { Pool: PgPool } = pg;

const shouldRunPostgresTests = process.env.ROBOOPS_RUN_POSTGRES_TESTS === "true";
const testDatabaseUrl = process.env.FLEET_PERSISTENCE_TEST_DATABASE_URL;
const fixtureDedupePrefix = "outbox-store-test:";

describe.skipIf(!shouldRunPostgresTests || !testDatabaseUrl)(
  "PostgresOutboxStore",
  () => {
    let pool: Pool | undefined;
    let store: PostgresOutboxStore | undefined;

    beforeAll(async () => {
      await runPostgresMigrations({ databaseUrl: testDatabaseUrl });
      pool = new PgPool({ connectionString: testDatabaseUrl });
      store = new PostgresOutboxStore({ pool });
    });

    beforeEach(async () => {
      await deleteFixtureOutboxRows(requirePool(pool));
    });

    afterAll(async () => {
      if (pool) {
        await deleteFixtureOutboxRows(pool);
        await pool.end();
      }
    });

    it("claims the oldest available rows first", async () => {
      const testPool = requirePool(pool);
      const testStore = requireStore(store);
      await insertOutboxFixture(testPool, {
        dedupeKey: fixtureDedupeKey("claim-order", "late"),
        payloadId: "late",
        availableAt: "2000-01-01T00:02:00.000Z",
        createdAt: "2000-01-01T00:00:00.000Z"
      });
      await insertOutboxFixture(testPool, {
        dedupeKey: fixtureDedupeKey("claim-order", "first"),
        payloadId: "first",
        availableAt: "2000-01-01T00:00:00.000Z",
        createdAt: "2000-01-01T00:01:00.000Z"
      });
      await insertOutboxFixture(testPool, {
        dedupeKey: fixtureDedupeKey("claim-order", "second"),
        payloadId: "second",
        availableAt: "2000-01-01T00:00:00.000Z",
        createdAt: "2000-01-01T00:02:00.000Z"
      });

      const claimed = await testStore.claimBatch({
        workerId: "worker-claim-order",
        batchSize: 2,
        now: "2000-01-01T00:03:00.000Z"
      });

      expect(claimed.map((event) => event.payload["id"])).toEqual([
        "first",
        "second"
      ]);
    });

    it("does not claim rows already locked by another worker", async () => {
      const testPool = requirePool(pool);
      const testStore = requireStore(store);
      const firstId = await insertOutboxFixture(testPool, {
        dedupeKey: fixtureDedupeKey("locked", "first"),
        payloadId: "locked-first",
        availableAt: "2000-01-01T00:00:00.000Z",
        createdAt: "2000-01-01T00:00:00.000Z"
      });
      const secondId = await insertOutboxFixture(testPool, {
        dedupeKey: fixtureDedupeKey("locked", "second"),
        payloadId: "locked-second",
        availableAt: "2000-01-01T00:00:00.000Z",
        createdAt: "2000-01-01T00:01:00.000Z"
      });

      const firstClaim = await testStore.claimBatch({
        workerId: "worker-lock-owner",
        batchSize: 1,
        now: "2000-01-01T00:02:00.000Z"
      });
      const secondClaim = await testStore.claimBatch({
        workerId: "worker-lock-contender",
        batchSize: 1,
        now: "2000-01-01T00:02:00.000Z"
      });

      expect(firstClaim.map((event) => event.outboxId)).toEqual([firstId]);
      expect(secondClaim.map((event) => event.outboxId)).toEqual([secondId]);
      expect(secondClaim.map((event) => event.outboxId)).not.toContain(firstId);
    });

    it("increments attempt count each time a row is claimed", async () => {
      const testPool = requirePool(pool);
      const testStore = requireStore(store);
      const outboxId = await insertOutboxFixture(testPool, {
        dedupeKey: fixtureDedupeKey("attempts", "row"),
        payloadId: "attempts",
        availableAt: "2000-01-01T00:00:00.000Z",
        createdAt: "2000-01-01T00:00:00.000Z"
      });

      const firstClaim = await testStore.claimBatch({
        workerId: "worker-attempt-one",
        batchSize: 1,
        now: "2000-01-01T00:01:00.000Z"
      });
      expect(firstClaim[0]?.attemptCount).toBe(1);

      await testStore.recordFailure({
        outboxId,
        workerId: "worker-attempt-one",
        retryAt: "2000-01-01T00:02:00.000Z",
        error: new Error("retry later")
      });
      const secondClaim = await testStore.claimBatch({
        workerId: "worker-attempt-two",
        batchSize: 1,
        now: "2000-01-01T00:02:00.000Z"
      });

      expect(secondClaim[0]?.outboxId).toBe(outboxId);
      expect(secondClaim[0]?.attemptCount).toBe(2);
    });

    it("marks published rows so later claims exclude them", async () => {
      const testPool = requirePool(pool);
      const testStore = requireStore(store);
      const outboxId = await insertOutboxFixture(testPool, {
        dedupeKey: fixtureDedupeKey("published", "row"),
        payloadId: "published",
        availableAt: "2000-01-01T00:00:00.000Z",
        createdAt: "2000-01-01T00:00:00.000Z"
      });

      const claimed = await testStore.claimBatch({
        workerId: "worker-publisher",
        batchSize: 1,
        now: "2000-01-01T00:01:00.000Z"
      });
      expect(claimed[0]?.outboxId).toBe(outboxId);

      await expect(
        testStore.markPublished({
          outboxId,
          workerId: "worker-publisher",
          publishedAt: "2000-01-01T00:02:00.000Z"
        })
      ).resolves.toBe(true);
      const laterClaim = await testStore.claimBatch({
        workerId: "worker-later",
        batchSize: 10,
        now: "2000-01-01T00:03:00.000Z"
      });

      expect(laterClaim.map((event) => event.outboxId)).not.toContain(outboxId);
    });

    it("records sanitized failures and schedules rows for a later retry", async () => {
      const testPool = requirePool(pool);
      const testStore = requireStore(store);
      const outboxId = await insertOutboxFixture(testPool, {
        dedupeKey: fixtureDedupeKey("failure", "row"),
        payloadId: "failure",
        availableAt: "2000-01-01T00:00:00.000Z",
        createdAt: "2000-01-01T00:00:00.000Z"
      });
      const rawErrorText = [
        "driver failed for postgres://user:secret@127.0.0.1:55432/roboops_control_plane",
        "password=secret",
        "x".repeat(maxOutboxErrorTextLength * 2)
      ].join("\n");

      const claimed = await testStore.claimBatch({
        workerId: "worker-failure",
        batchSize: 1,
        now: "2000-01-01T00:01:00.000Z"
      });
      expect(claimed[0]?.outboxId).toBe(outboxId);

      await expect(
        testStore.recordFailure({
          outboxId,
          workerId: "worker-failure",
          retryAt: "2000-01-01T00:05:00.000Z",
          error: new Error(rawErrorText)
        })
      ).resolves.toBe(true);

      const stored = await readOutboxStatus(testPool, outboxId);
      expect(stored.lockedBy).toBeNull();
      expect(stored.lockedAt).toBeNull();
      expect(stored.availableAt).toBe("2000-01-01T00:05:00.000Z");
      expect(stored.lastError).not.toContain("postgres://");
      expect(stored.lastError).not.toContain("secret");
      expect(stored.lastError.length).toBeLessThanOrEqual(
        maxOutboxErrorTextLength
      );

      const tooEarlyClaim = await testStore.claimBatch({
        workerId: "worker-too-early",
        batchSize: 10,
        now: "2000-01-01T00:04:59.000Z"
      });
      const retryClaim = await testStore.claimBatch({
        workerId: "worker-retry",
        batchSize: 10,
        now: "2000-01-01T00:05:00.000Z"
      });

      expect(tooEarlyClaim.map((event) => event.outboxId)).not.toContain(outboxId);
      expect(retryClaim.map((event) => event.outboxId)).toContain(outboxId);
    });
  }
);

interface OutboxFixture {
  readonly dedupeKey: string;
  readonly payloadId: string;
  readonly availableAt: string;
  readonly createdAt: string;
}

interface OutboxStatusRow {
  readonly available_at: Date | string;
  readonly locked_at: Date | string | null;
  readonly locked_by: string | null;
  readonly last_error: string;
}

/** Ensures skipped opt-in tests never dereference an uninitialized pool. */
function requirePool(pool: Pool | undefined): Pool {
  if (!pool) {
    throw new Error("Postgres test pool was not initialized");
  }
  return pool;
}

/** Ensures skipped opt-in tests never dereference an uninitialized outbox store. */
function requireStore(
  store: PostgresOutboxStore | undefined
): PostgresOutboxStore {
  if (!store) {
    throw new Error("Postgres outbox store was not initialized");
  }
  return store;
}

/** Creates one isolated outbox row with deterministic queue ordering fields. */
async function insertOutboxFixture(
  pool: Pool,
  fixture: OutboxFixture
): Promise<string> {
  const result = await pool.query<{ readonly outbox_id: string }>(
    [
      "INSERT INTO fleet_persistence.outbox_events (",
      "  aggregate_type, aggregate_id, event_type, payload_json, correlation_id,",
      "  causation_id, created_at, available_at, dedupe_key",
      ") VALUES (",
      "  'mission', $1, 'test.event', $2::jsonb, $3,",
      "  NULL, $4, $5, $6",
      ")",
      "RETURNING outbox_id"
    ].join("\n"),
    [
      `mission-${fixture.payloadId}`,
      JSON.stringify({ id: fixture.payloadId }),
      `corr-${fixture.payloadId}`,
      fixture.createdAt,
      fixture.availableAt,
      fixture.dedupeKey
    ]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Expected inserted outbox fixture id");
  }
  return row.outbox_id;
}

/** Reads lock and retry fields directly so failure handling assertions stay precise. */
async function readOutboxStatus(
  pool: Pool,
  outboxId: string
): Promise<{
  readonly availableAt: string;
  readonly lockedAt: string | null;
  readonly lockedBy: string | null;
  readonly lastError: string;
}> {
  const result = await pool.query<OutboxStatusRow>(
    [
      "SELECT available_at, locked_at, locked_by, last_error",
      "FROM fleet_persistence.outbox_events",
      "WHERE outbox_id = $1"
    ].join("\n"),
    [outboxId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Expected outbox status row");
  }
  return {
    availableAt: toIsoTimestamp(row.available_at),
    lockedAt: row.locked_at ? toIsoTimestamp(row.locked_at) : null,
    lockedBy: row.locked_by,
    lastError: row.last_error
  };
}

/** Removes this test file's rows without touching repository contract fixtures. */
async function deleteFixtureOutboxRows(pool: Pool): Promise<void> {
  await pool.query(
    "DELETE FROM fleet_persistence.outbox_events WHERE dedupe_key LIKE $1",
    [`${fixtureDedupePrefix}%`]
  );
}

/** Names fixture rows so repeated local runs clean up only their own data. */
function fixtureDedupeKey(testName: string, rowName: string): string {
  return `${fixtureDedupePrefix}${testName}:${rowName}`;
}

/** Normalizes Postgres timestamps to ISO text for stable assertions. */
function toIsoTimestamp(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
}
