import { pathToFileURL } from "node:url";

import {
  PostgresDomainStateRepository,
  localPostgresDatabaseUrl
} from "@roboops/fleet-persistence";

import { loadFleetPlatformConfig } from "./config.js";
import {
  classifyReadinessError,
  readinessRepositoryReadTimeoutMs,
  repositoryReadinessCheckName,
  runRepositoryReadinessCheck
} from "./readiness.js";
import type { FleetPlatformConfig } from "./types.js";

/** Minimal repository surface needed by the read-only readiness command. */
export interface FleetPlatformPostgresReadinessRepository {
  read(): Promise<unknown>;
  close?(): Promise<void>;
}

/** Input accepted by the read-only Postgres readiness validation path. */
export interface FleetPlatformPostgresReadinessOptions {
  readonly databaseUrl: string;
  readonly timeoutMs?: number;
  readonly repositoryFactory?: (
    options: FleetPlatformPostgresReadinessRepositoryOptions
  ) => FleetPlatformPostgresReadinessRepository;
}

/** Repository construction options passed through so tests can avoid real Postgres. */
export interface FleetPlatformPostgresReadinessRepositoryOptions {
  readonly databaseUrl: string;
  readonly timeoutMs: number;
}

/** Sanitized result returned after the repository read path succeeds. */
export interface FleetPlatformPostgresReadinessSummary {
  readonly persistenceMode: "postgres";
  readonly check: typeof repositoryReadinessCheckName;
}

/** Small IO boundary so CLI output can be asserted without console interception. */
export interface FleetPlatformPostgresReadinessCliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

/** Parsed command-line options before they are resolved against environment config. */
interface ParsedCliOptions {
  readonly local: boolean;
  readonly databaseUrl?: string;
  readonly timeoutMs?: number;
  readonly help: boolean;
}

/** Verifies that Postgres is reachable and migrated enough for the repository read path. */
export async function checkFleetPlatformPostgresReadiness(
  options: FleetPlatformPostgresReadinessOptions
): Promise<FleetPlatformPostgresReadinessSummary> {
  const timeoutMs = options.timeoutMs ?? readinessRepositoryReadTimeoutMs;
  const repository =
    options.repositoryFactory?.({ databaseUrl: options.databaseUrl, timeoutMs }) ??
    new PostgresDomainStateRepository({
      databaseUrl: options.databaseUrl,
      poolConfig: {
        allowExitOnIdle: true,
        connectionTimeoutMillis: timeoutMs,
        idle_in_transaction_session_timeout: timeoutMs,
        query_timeout: postgresOperationTimeoutMs(timeoutMs),
        statement_timeout: postgresOperationTimeoutMs(timeoutMs)
      }
    });

  let readinessError: unknown;
  try {
    await runRepositoryReadinessCheck(() => repository.read(), timeoutMs);
  } catch (error: unknown) {
    readinessError = error;
  }

  const closeError = await closeReadinessRepository(repository, timeoutMs).catch(
    (error: unknown) => error
  );
  if (readinessError) {
    throw readinessError;
  }
  if (closeError) {
    throw closeError;
  }

  return {
    persistenceMode: "postgres",
    check: repositoryReadinessCheckName
  };
}

/** Runs the read-only Postgres readiness CLI and returns the intended process exit code. */
export async function runFleetPlatformPostgresReadinessCli(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  io: FleetPlatformPostgresReadinessCliIo = {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message)
  },
  repositoryFactory?: FleetPlatformPostgresReadinessOptions["repositoryFactory"]
): Promise<number> {
  try {
    const parsed = parseCliOptions(args);
    if (parsed.help) {
      io.stdout(formatUsage());
      return 0;
    }

    const databaseUrl = resolveDatabaseUrl(parsed, env);
    const summary = await checkFleetPlatformPostgresReadiness({
      databaseUrl,
      ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
      ...(repositoryFactory ? { repositoryFactory } : {})
    });
    io.stdout(
      [
        "fleet platform Postgres readiness validated",
        `persistenceMode=${summary.persistenceMode}`,
        `check=${summary.check}`
      ].join(" ")
    );
    return 0;
  } catch (error: unknown) {
    const errorType = classifyReadinessError(error);
    const message =
      error instanceof FleetPlatformPostgresReadinessCliError
        ? error.sanitizedMessage
        : "persistence backend is not ready";
    io.stderr(
      [
        "fleet platform Postgres readiness failed",
        `check=${repositoryReadinessCheckName}`,
        `errorType=${errorType}`,
        `message=${quoteCliValue(message)}`
      ].join(" ")
    );
    return 1;
  }
}

/** Converts CLI flags into validation options without exposing connection strings. */
function parseCliOptions(args: readonly string[]): ParsedCliOptions {
  const options: {
    local: boolean;
    databaseUrl?: string;
    timeoutMs?: number;
    help: boolean;
  } = {
    local: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--local") {
      options.local = true;
      continue;
    }
    if (arg === "--database-url") {
      const value = args[index + 1];
      if (!value) {
        throw new FleetPlatformPostgresReadinessCliError(
          "--database-url requires a value"
        );
      }
      options.databaseUrl = value;
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = args[index + 1];
      if (!value) {
        throw new FleetPlatformPostgresReadinessCliError(
          "--timeout-ms requires a value"
        );
      }
      options.timeoutMs = parseTimeoutMs(value);
      index += 1;
      continue;
    }
    throw new FleetPlatformPostgresReadinessCliError(
      "unknown Postgres readiness argument"
    );
  }

  if (options.local && options.databaseUrl) {
    throw new FleetPlatformPostgresReadinessCliError(
      "use either --local or --database-url, not both"
    );
  }
  return options;
}

/** Resolves the database URL from explicit flags or the normal Fleet Platform env. */
function resolveDatabaseUrl(
  options: ParsedCliOptions,
  env: NodeJS.ProcessEnv
): string {
  if (options.local) {
    return localPostgresDatabaseUrl;
  }
  if (options.databaseUrl) {
    return options.databaseUrl;
  }

  const config = loadFleetPlatformConfigForReadiness(env);
  if (config.persistence.mode !== "postgres") {
    throw new FleetPlatformPostgresReadinessCliError(
      "Fleet Platform Postgres persistence is not configured"
    );
  }
  return config.persistence.databaseUrl;
}

/** Parses a positive timeout in milliseconds for slow local environments. */
function parseTimeoutMs(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new FleetPlatformPostgresReadinessCliError(
      "--timeout-ms must be a positive integer"
    );
  }
  return parsed;
}

/** Gives pg slightly less time than the outer readiness guard so query cleanup wins. */
function postgresOperationTimeoutMs(timeoutMs: number): number {
  const guardBandMs = Math.min(100, Math.floor(timeoutMs / 4));
  return Math.max(1, timeoutMs - guardBandMs);
}

/** Bounds repository shutdown so a checked-out client cannot hang the command. */
async function closeReadinessRepository(
  repository: FleetPlatformPostgresReadinessRepository,
  timeoutMs: number
): Promise<void> {
  if (!repository.close) {
    return;
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      repository.close(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new ReadinessCloseTimeoutError(timeoutMs));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/** Loads normal Fleet Platform config while replacing raw config errors with safe text. */
function loadFleetPlatformConfigForReadiness(
  env: NodeJS.ProcessEnv
): FleetPlatformConfig {
  try {
    return loadFleetPlatformConfig(env);
  } catch {
    throw new FleetPlatformPostgresReadinessCliError(
      "Fleet Platform Postgres persistence configuration is invalid"
    );
  }
}

/** Quotes one CLI value without allowing control characters into console output. */
function quoteCliValue(value: string): string {
  return JSON.stringify(value.replaceAll(/[\r\n\t]/g, " "));
}

/** Prints terse CLI usage for local Postgres readiness validation. */
function formatUsage(): string {
  return [
    "Usage: pnpm --filter @roboops/fleet-platform check:postgres -- [options]",
    "",
    "Options:",
    "  --local                 Use the local Docker Compose database URL.",
    "  --database-url <url>    Use an explicit Postgres connection string.",
    "  --timeout-ms <ms>       Override the bounded repository read timeout.",
    "  --help                  Show this help text."
  ].join("\n");
}

/** Error class for validation failures whose message is safe to print. */
class FleetPlatformPostgresReadinessCliError extends Error {
  constructor(readonly sanitizedMessage: string) {
    super(sanitizedMessage);
    this.name = "FleetPlatformPostgresReadinessCliError";
  }
}

/** Cleanup sentinel used only to avoid indefinite waits during CLI shutdown. */
class ReadinessCloseTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`repository close exceeded ${timeoutMs}ms`);
    this.name = "ReadinessCloseTimeoutError";
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runFleetPlatformPostgresReadinessCli();
}
