import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Dedicated Postgres schema owned by the fleet-persistence package. */
export const fleetPersistenceSchema = "fleet_persistence";

/** Local Docker Compose database URL used by development migration commands. */
export const localPostgresDatabaseUrl =
  "postgres://roboops:roboops_local_password@127.0.0.1:55432/roboops_control_plane";

/** Directory containing deterministic SQL migrations for fleet-persistence. */
export const defaultMigrationDirectoryUrl = new URL("../migrations/", import.meta.url);

/** Enforces a stable numeric prefix so migrations sort the same on every machine. */
export const migrationFileNamePattern = /^\d{4}_[a-z0-9_]+\.sql$/;

/** SQL migration loaded from disk with its immutable checksum. */
export interface SqlMigration {
  readonly name: string;
  readonly path: string;
  readonly sql: string;
  readonly checksumSha256: string;
}

/** Migration row already recorded in the target database. */
export interface AppliedMigration {
  readonly name: string;
  readonly checksumSha256: string;
}

/** One migration decision after comparing local files with the database. */
export interface MigrationPlanEntry {
  readonly migration: SqlMigration;
  readonly status: "apply" | "skip";
}

/** Creates the migration bookkeeping table before the normal plan is evaluated. */
export const schemaMigrationsBootstrapSql = `
CREATE SCHEMA IF NOT EXISTS ${fleetPersistenceSchema};

CREATE TABLE IF NOT EXISTS ${fleetPersistenceSchema}.schema_migrations (
  migration_name text PRIMARY KEY,
  checksum_sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`;

/** Returns migration SQL file names in deterministic application order. */
export function getOrderedMigrationFileNames(fileNames: readonly string[]): readonly string[] {
  const sqlFileNames = fileNames.filter((fileName) => fileName.endsWith(".sql"));
  const invalidFileNames = sqlFileNames.filter(
    (fileName) => !migrationFileNamePattern.test(fileName)
  );
  if (invalidFileNames.length > 0) {
    throw new Error(
      `Invalid migration file name(s): ${invalidFileNames.join(", ")}`
    );
  }
  return [...sqlFileNames].sort((left, right) => left.localeCompare(right));
}

/** Reads all SQL migrations from disk and attaches checksums for drift detection. */
export async function readOrderedSqlMigrations(
  directoryUrl: URL = defaultMigrationDirectoryUrl
): Promise<readonly SqlMigration[]> {
  const directory = ensureDirectoryUrl(directoryUrl);
  const entries = await readdir(directory, { withFileTypes: true });
  const fileNames = getOrderedMigrationFileNames(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  );

  return Promise.all(
    fileNames.map(async (name) => {
      const fileUrl = new URL(name, directory);
      const sql = await readFile(fileUrl, "utf8");
      return {
        name,
        path: fileURLToPath(fileUrl),
        sql,
        checksumSha256: sha256(sql)
      };
    })
  );
}

/** Builds an idempotent apply/skip plan and fails fast on checksum drift. */
export function buildMigrationPlan(
  migrations: readonly SqlMigration[],
  appliedMigrations: readonly AppliedMigration[]
): readonly MigrationPlanEntry[] {
  const migrationsByName = new Map(migrations.map((migration) => [migration.name, migration]));
  const appliedByName = new Map<string, AppliedMigration>();

  for (const appliedMigration of appliedMigrations) {
    if (!migrationsByName.has(appliedMigration.name)) {
      throw new Error(
        `Database has unknown migration ${appliedMigration.name}; refusing to continue`
      );
    }
    if (appliedByName.has(appliedMigration.name)) {
      throw new Error(`Database has duplicate migration row ${appliedMigration.name}`);
    }
    appliedByName.set(appliedMigration.name, appliedMigration);
  }

  return migrations.map((migration) => {
    const appliedMigration = appliedByName.get(migration.name);
    if (!appliedMigration) {
      return { migration, status: "apply" };
    }
    if (appliedMigration.checksumSha256 !== migration.checksumSha256) {
      throw new Error(
        `Migration checksum changed for ${migration.name}; create a new migration instead`
      );
    }
    return { migration, status: "skip" };
  });
}

/** Wraps a migration in a transaction and records its checksum after success. */
export function formatMigrationTransaction(migration: SqlMigration): string {
  const migrationSql = ensureSqlStatementTerminator(migration.sql.trim());
  const appliedMarker = migrationAppliedOutputMarker(migration.name);
  const migrationRecordSql = [
    migrationSql,
    [
      `INSERT INTO ${fleetPersistenceSchema}.schema_migrations`,
      "(migration_name, checksum_sha256)",
      `VALUES (${sqlStringLiteral(migration.name)}, ${sqlStringLiteral(
        migration.checksumSha256
      )})`,
      "ON CONFLICT (migration_name) DO NOTHING;"
    ].join(" "),
    `SELECT ${sqlStringLiteral(appliedMarker)};`
  ].join("\n");

  return [
    "BEGIN;",
    "SELECT pg_advisory_xact_lock(hashtext('roboops_fleet_persistence_migrations'));",
    formatChecksumGuard(migration),
    [
      `SELECT ${sqlDollarQuote(migrationRecordSql)}`,
      "WHERE NOT EXISTS (",
      `  SELECT 1 FROM ${fleetPersistenceSchema}.schema_migrations`,
      `  WHERE migration_name = ${sqlStringLiteral(migration.name)}`,
      ")"
    ].join(" "),
    "\\gexec",
    "COMMIT;",
    ""
  ].join("\n");
}

/** Returns the stdout marker emitted only when this process actually applied a migration. */
export function migrationAppliedOutputMarker(migrationName: string): string {
  return `roboops_migration_applied:${migrationName}`;
}

/** Checks psql output from a guarded transaction to decide whether it ran the body. */
export function didMigrationTransactionApply(
  migration: Pick<SqlMigration, "name">,
  output: string
): boolean {
  return output.includes(migrationAppliedOutputMarker(migration.name));
}

/** Produces a stable SHA-256 checksum for immutable SQL migration contents. */
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Normalizes caller-provided file URLs so relative migration names resolve safely. */
function ensureDirectoryUrl(url: URL): URL {
  if (url.href.endsWith("/")) {
    return url;
  }
  return new URL(`${url.href}/`);
}

/** Ensures migration bodies remain valid when concatenated into a transaction. */
function ensureSqlStatementTerminator(sql: string): string {
  return sql.endsWith(";") ? sql : `${sql};`;
}

/** Builds a checksum drift guard that executes after the migration lock is held. */
function formatChecksumGuard(migration: SqlMigration): string {
  return [
    "DO $roboops_checksum_guard$",
    "BEGIN",
    "  IF EXISTS (",
    `    SELECT 1 FROM ${fleetPersistenceSchema}.schema_migrations`,
    `    WHERE migration_name = ${sqlStringLiteral(migration.name)}`,
    `      AND checksum_sha256 <> ${sqlStringLiteral(migration.checksumSha256)}`,
    "  ) THEN",
    `    RAISE EXCEPTION ${sqlStringLiteral(
      `Migration checksum changed for ${migration.name}; create a new migration instead`
    )};`,
    "  END IF;",
    "END",
    "$roboops_checksum_guard$;"
  ].join("\n");
}

/** Dollar-quotes generated SQL so psql can execute it conditionally with gexec. */
function sqlDollarQuote(value: string): string {
  let tagIndex = 0;
  let delimiter = "$roboops_migration$";
  while (value.includes(delimiter)) {
    tagIndex += 1;
    delimiter = `$roboops_migration_${tagIndex}$`;
  }
  return `${delimiter}${value}${delimiter}`;
}

/** Escapes text as a SQL string literal for runner-generated bookkeeping inserts. */
function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
