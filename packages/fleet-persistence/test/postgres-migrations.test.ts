import { describe, expect, it } from "vitest";

import {
  buildMigrationPlan,
  didMigrationTransactionApply,
  formatMigrationTransaction,
  getOrderedMigrationFileNames,
  migrationAppliedOutputMarker,
  readOrderedSqlMigrations,
  type SqlMigration
} from "../src/index.js";

const requiredTables = [
  "robots",
  "robot_sessions",
  "missions",
  "domain_events",
  "commands",
  "command_acks",
  "robot_telemetry_events",
  "audit_events",
  "outbox_events",
  "idempotency_keys"
] as const;

const requiredConstraintFragments = [
  "CONSTRAINT commands_command_id_key UNIQUE (command_id)",
  "CONSTRAINT commands_robot_id_sequence_key UNIQUE (robot_id, sequence)",
  'CONSTRAINT idempotency_keys_key_key UNIQUE ("key")',
  "CONSTRAINT domain_events_event_id_key UNIQUE (event_id)",
  "CONSTRAINT robot_telemetry_events_event_id_key UNIQUE (event_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_dedupe_key_key"
] as const;

describe("Postgres migration files", () => {
  it("discovers deterministic SQL migrations in filename order", async () => {
    const migrations = await readOrderedSqlMigrations();

    expect(migrations.map((migration) => migration.name)).toEqual([
      "0001_core_schema.sql",
      "0002_domain_state_bookmarks.sql",
      "0003_robot_session_resolution.sql"
    ]);
    expect(migrations[0]?.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects SQL migration names without a numeric prefix", () => {
    expect(() =>
      getOrderedMigrationFileNames([
        "0002_second_schema.sql",
        "core_schema.sql"
      ])
    ).toThrow("Invalid migration file name");
  });

  it("contains the persistence core tables and uniqueness constraints", async () => {
    const migration = firstMigration(await readOrderedSqlMigrations());

    for (const tableName of requiredTables) {
      expect(migration.sql).toContain(
        `CREATE TABLE IF NOT EXISTS fleet_persistence.${tableName}`
      );
    }
    for (const constraintFragment of requiredConstraintFragments) {
      expect(migration.sql).toContain(constraintFragment);
    }
  });

  it("keeps append-only logs tolerant of unresolved external references", async () => {
    const migration = firstMigration(await readOrderedSqlMigrations());
    const commandAcksTable = tableDefinition(migration.sql, "command_acks");
    const domainEventsTable = tableDefinition(migration.sql, "domain_events");
    const telemetryTable = tableDefinition(migration.sql, "robot_telemetry_events");
    const auditTable = tableDefinition(migration.sql, "audit_events");

    expect(commandAcksTable).toContain("command_id text NOT NULL,");
    expect(commandAcksTable).toContain("mission_id text,");
    expect(commandAcksTable).toContain("robot_id text NOT NULL,");
    expect(commandAcksTable).toContain(
      "resolved_command_id text REFERENCES fleet_persistence.commands (command_id)"
    );
    expect(commandAcksTable).toContain(
      "resolved_mission_id text REFERENCES fleet_persistence.missions (mission_id)"
    );
    expect(commandAcksTable).not.toContain(
      "command_id text NOT NULL REFERENCES"
    );
    expect(commandAcksTable).not.toContain("robot_id text NOT NULL REFERENCES");
    expect(domainEventsTable).toContain("mission_id text,");
    expect(domainEventsTable).toContain("robot_id text,");
    expect(domainEventsTable).toContain("command_id text,");
    expect(domainEventsTable).not.toContain("REFERENCES");
    expect(telemetryTable).toContain("current_mission_id text,");
    expect(telemetryTable).toContain("robot_id text NOT NULL,");
    expect(telemetryTable).toContain(
      "resolved_robot_id text REFERENCES fleet_persistence.robots (robot_id)"
    );
    expect(telemetryTable).toContain(
      "resolved_mission_id text REFERENCES fleet_persistence.missions (mission_id)"
    );
    expect(telemetryTable).not.toContain("robot_id text NOT NULL REFERENCES");
    expect(telemetryTable).not.toContain(
      "current_mission_id text REFERENCES fleet_persistence.missions"
    );
    expect(auditTable).toContain("mission_id text,");
    expect(auditTable).toContain("robot_id text,");
    expect(auditTable).toContain("command_id text,");
    expect(auditTable).not.toContain("REFERENCES");
  });

  it("contains reducer bookkeeping for repository state that is not a canonical entity", async () => {
    const migration = (await readOrderedSqlMigrations()).find(
      (candidate) => candidate.name === "0002_domain_state_bookmarks.sql"
    );
    if (!migration) {
      throw new Error("Missing domain state bookmark migration");
    }

    expect(migration.sql).toContain(
      "CREATE TABLE IF NOT EXISTS fleet_persistence.domain_state_bookmarks"
    );
    expect(migration.sql).toContain("processed_event_ids text[] NOT NULL");
    expect(migration.sql).toContain("processed_ack_ids text[] NOT NULL");
    expect(migration.sql).toContain(
      "processed_reconnect_session_ids text[] NOT NULL"
    );
    expect(migration.sql).toContain("next_sequence_by_robot jsonb NOT NULL");
    expect(migration.sql).toContain("domain_event_ids text[] NOT NULL");
    expect(migration.sql).toContain("audit_event_ids text[] NOT NULL");
  });

  it("keeps robot session history tolerant of unresolved robot references", async () => {
    const migration = (await readOrderedSqlMigrations()).find(
      (candidate) => candidate.name === "0003_robot_session_resolution.sql"
    );
    if (!migration) {
      throw new Error("Missing robot session resolution migration");
    }

    expect(migration.sql).toContain("ADD COLUMN IF NOT EXISTS resolved_robot_id text");
    expect(migration.sql).toContain(
      "DROP CONSTRAINT IF EXISTS robot_sessions_robot_id_fkey"
    );
    expect(migration.sql).toContain(
      "FOREIGN KEY (resolved_robot_id)"
    );
    expect(migration.sql).toContain(
      "REFERENCES fleet_persistence.robots (robot_id)"
    );
    expect(migration.sql).toContain(
      "CREATE INDEX IF NOT EXISTS robot_sessions_resolved_robot_id_idx"
    );
  });
});

describe("Postgres migration planning", () => {
  it("applies unapplied migrations and skips matching applied checksums", async () => {
    const migrations = await readOrderedSqlMigrations();
    const firstPlan = buildMigrationPlan(migrations, []);

    expect(firstPlan.map((entry) => entry.status)).toEqual(
      migrations.map(() => "apply")
    );

    const appliedMigrations = migrations.map((migration) => ({
      name: migration.name,
      checksumSha256: migration.checksumSha256
    }));
    const secondPlan = buildMigrationPlan(migrations, appliedMigrations);

    expect(secondPlan.map((entry) => entry.status)).toEqual(
      migrations.map(() => "skip")
    );
  });

  it("fails when an applied migration checksum no longer matches local SQL", async () => {
    const migration = firstMigration(await readOrderedSqlMigrations());

    expect(() =>
      buildMigrationPlan([migration], [
        { name: migration.name, checksumSha256: "not-the-current-checksum" }
      ])
    ).toThrow("Migration checksum changed");
  });

  it("wraps each migration in a transaction with checksum bookkeeping", async () => {
    const migration = firstMigration(await readOrderedSqlMigrations());
    const transactionSql = formatMigrationTransaction(migration);

    expect(transactionSql).toContain("BEGIN;");
    expect(transactionSql).toContain(
      "INSERT INTO fleet_persistence.schema_migrations"
    );
    expect(transactionSql).toContain("ON CONFLICT (migration_name) DO NOTHING;");
    expect(transactionSql).toContain("WHERE NOT EXISTS (");
    expect(transactionSql).toContain(
      "SELECT 1 FROM fleet_persistence.schema_migrations"
    );
    expect(transactionSql).toContain("\\gexec");
  });

  it("detects whether a guarded migration transaction actually applied", async () => {
    const migration = firstMigration(await readOrderedSqlMigrations());
    const marker = migrationAppliedOutputMarker(migration.name);

    expect(didMigrationTransactionApply(migration, `\n${marker}\n`)).toBe(true);
    expect(didMigrationTransactionApply(migration, "\n")).toBe(false);
  });
});

/** Returns the baseline migration while keeping test failures readable. */
function firstMigration(migrations: readonly SqlMigration[]): SqlMigration {
  const migration = migrations[0];
  if (!migration) {
    throw new Error("Expected at least one SQL migration");
  }
  return migration;
}

/** Extracts one CREATE TABLE body so assertions target the intended table. */
function tableDefinition(sql: string, tableName: string): string {
  const marker = `CREATE TABLE IF NOT EXISTS fleet_persistence.${tableName} (`;
  const startIndex = sql.indexOf(marker);
  if (startIndex < 0) {
    throw new Error(`Missing table definition for ${tableName}`);
  }
  const endIndex = sql.indexOf("\n);\n", startIndex);
  if (endIndex < 0) {
    throw new Error(`Unterminated table definition for ${tableName}`);
  }
  return sql.slice(startIndex, endIndex);
}
