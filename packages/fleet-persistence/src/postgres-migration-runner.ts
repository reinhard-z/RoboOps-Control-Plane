import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  type AppliedMigration,
  buildMigrationPlan,
  defaultMigrationDirectoryUrl,
  didMigrationTransactionApply,
  formatMigrationTransaction,
  localPostgresDatabaseUrl,
  readOrderedSqlMigrations,
  schemaMigrationsBootstrapSql
} from "./postgres-migrations.js";

/** Options used when invoking the local psql client. */
export interface PsqlCommandOptions {
  readonly databaseUrl?: string;
  readonly psqlBin?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Options for applying the fleet-persistence SQL migration directory. */
export interface PostgresMigrationRunnerOptions extends PsqlCommandOptions {
  readonly migrationsDirectoryUrl?: URL;
}

/** Summary returned by the migration runner for tests and CLI output. */
export interface PostgresMigrationRunSummary {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

/** Applies pending SQL migrations to a Postgres database through psql. */
export async function runPostgresMigrations(
  options: PostgresMigrationRunnerOptions = {}
): Promise<PostgresMigrationRunSummary> {
  const migrations = await readOrderedSqlMigrations(
    options.migrationsDirectoryUrl ?? defaultMigrationDirectoryUrl
  );
  await runPsql(schemaMigrationsBootstrapSql, options);

  const appliedMigrations = await readAppliedPostgresMigrations(options);
  const plan = buildMigrationPlan(migrations, appliedMigrations);
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const entry of plan) {
    if (entry.status === "skip") {
      skipped.push(entry.migration.name);
      continue;
    }

    const output = await runPsql(formatMigrationTransaction(entry.migration), options);
    if (didMigrationTransactionApply(entry.migration, output)) {
      applied.push(entry.migration.name);
    } else {
      skipped.push(entry.migration.name);
    }
  }

  return { applied, skipped };
}

/** Reads migration bookkeeping rows from the target database. */
export async function readAppliedPostgresMigrations(
  options: PsqlCommandOptions = {}
): Promise<readonly AppliedMigration[]> {
  const output = await runPsql(
    [
      "SELECT migration_name || E'\\t' || checksum_sha256",
      "FROM fleet_persistence.schema_migrations",
      "ORDER BY migration_name;"
    ].join("\n"),
    options
  );
  return parseAppliedMigrationRows(output);
}

/** Executes SQL through psql and returns stdout once the process exits cleanly. */
export function runPsql(sql: string, options: PsqlCommandOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const databaseUrl =
      options.databaseUrl ?? options.env?.DATABASE_URL ?? process.env.DATABASE_URL;
    const args = [
      "--no-psqlrc",
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      "--tuples-only",
      "--no-align"
    ];
    if (databaseUrl) {
      args.push(databaseUrl);
    }

    const child = spawn(options.psqlBin ?? "psql", args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (exitCode === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `psql exited with code ${exitCode ?? "unknown"}${stderr ? `: ${stderr}` : ""}`
        )
      );
    });
    child.stdin.end(sql);
  });
}

/** Parses the tab-delimited migration rows returned by psql. */
function parseAppliedMigrationRows(output: string): readonly AppliedMigration[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, checksumSha256] = line.split("\t");
      if (!name || !checksumSha256) {
        throw new Error(`Invalid schema_migrations row: ${line}`);
      }
      return { name, checksumSha256 };
    });
}

/** Converts CLI flags into runner options without adding runtime dependencies. */
function parseCliOptions(args: readonly string[]): PostgresMigrationRunnerOptions {
  const options: {
    databaseUrl?: string;
    psqlBin?: string;
  } = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--local") {
      options.databaseUrl = localPostgresDatabaseUrl;
      continue;
    }
    if (arg === "--database-url") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--database-url requires a value");
      }
      options.databaseUrl = value;
      index += 1;
      continue;
    }
    if (arg === "--psql-bin") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--psql-bin requires a value");
      }
      options.psqlBin = value;
      index += 1;
      continue;
    }
    if (arg === "--help") {
      continue;
    }
    throw new Error(`Unknown migration runner argument: ${arg}`);
  }

  return options;
}

/** Prints terse CLI usage for local migration runs. */
function printUsage(): void {
  console.log(
    [
      "Usage: pnpm --filter @roboops/fleet-persistence migrate -- [options]",
      "",
      "Options:",
      "  --local                 Use the local Docker Compose database URL.",
      "  --database-url <url>    Use an explicit Postgres connection string.",
      "  --psql-bin <path>       Use a non-default psql binary.",
      "  --help                  Show this help text."
    ].join("\n")
  );
}

/** Runs the CLI entrypoint when this module is executed directly. */
async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    printUsage();
    return;
  }

  const summary = await runPostgresMigrations(parseCliOptions(process.argv.slice(2)));
  console.log(
    `fleet-persistence migrations complete: ${summary.applied.length} applied, ${summary.skipped.length} skipped`
  );
  for (const migrationName of summary.applied) {
    console.log(`applied ${migrationName}`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
