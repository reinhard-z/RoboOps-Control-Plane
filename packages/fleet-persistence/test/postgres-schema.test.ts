import { describe, expect, it } from "vitest";

import { runPostgresMigrations, runPsql } from "../src/index.js";

const shouldRunPostgresTests = process.env.ROBOOPS_RUN_POSTGRES_TESTS === "true";
const testDatabaseUrl = process.env.FLEET_PERSISTENCE_TEST_DATABASE_URL;

const expectedTables = [
  "audit_events",
  "command_acks",
  "commands",
  "domain_state_bookmarks",
  "domain_events",
  "idempotency_keys",
  "missions",
  "outbox_events",
  "robot_sessions",
  "robot_telemetry_events",
  "robots",
  "schema_migrations"
] as const;

const expectedUniqueConstraintsAndIndexes = [
  "constraint:commands:commands_command_id_key",
  "constraint:commands:commands_robot_id_sequence_key",
  "constraint:domain_events:domain_events_event_id_key",
  "constraint:idempotency_keys:idempotency_keys_key_key",
  "constraint:robot_telemetry_events:robot_telemetry_events_event_id_key",
  "index:outbox_events:outbox_events_dedupe_key_key"
] as const;

describe.skipIf(!shouldRunPostgresTests || !testDatabaseUrl)(
  "Postgres schema migration",
  () => {
    it("is idempotent and creates the expected tables and uniqueness guards", async () => {
      const options = { databaseUrl: testDatabaseUrl };

      await runPostgresMigrations(options);
      const secondRun = await runPostgresMigrations(options);

      expect(secondRun.applied).toEqual([]);
      expect(secondRun.skipped).toEqual([
        "0001_core_schema.sql",
        "0002_domain_state_bookmarks.sql",
        "0003_robot_session_resolution.sql"
      ]);

      const tableRows = await runPsql(
        [
          "SELECT table_name",
          "FROM information_schema.tables",
          "WHERE table_schema = 'fleet_persistence'",
          "ORDER BY table_name;"
        ].join("\n"),
        options
      );
      expect(outputLines(tableRows)).toEqual(expectedTables);

      const constraintRows = await runPsql(
        [
          "SELECT 'constraint:' || rel.relname || ':' || con.conname",
          "FROM pg_constraint con",
          "JOIN pg_class rel ON rel.oid = con.conrelid",
          "JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace",
          "WHERE nsp.nspname = 'fleet_persistence'",
          "  AND con.contype = 'u'",
          "UNION ALL",
          "SELECT 'index:' || tablename || ':' || indexname",
          "FROM pg_indexes",
          "WHERE schemaname = 'fleet_persistence'",
          "  AND indexname = 'outbox_events_dedupe_key_key'",
          "ORDER BY 1;"
        ].join("\n"),
        options
      );
      expect(outputLines(constraintRows)).toEqual(
        expectedUniqueConstraintsAndIndexes
      );
    });
  }
);

/** Converts psql tuple output into stable non-empty lines for assertions. */
function outputLines(output: string): readonly string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
