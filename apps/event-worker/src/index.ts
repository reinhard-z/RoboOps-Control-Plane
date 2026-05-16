import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

import {
  PostgresOutboxStore,
  localPostgresDatabaseUrl
} from "@roboops/fleet-persistence";
import type { ClaimedOutboxEvent } from "@roboops/fleet-persistence";

export const eventWorkerApp = "@roboops/event-worker";

const defaultBatchSize = 10;
const defaultRetryDelayMs = 30_000;

/** Minimal store surface the worker needs from the persistence package. */
export interface EventWorkerOutboxStore {
  claimBatch(options: {
    readonly workerId: string;
    readonly batchSize: number;
    readonly now?: Date | string;
  }): Promise<readonly ClaimedOutboxEvent[]>;
  markPublished(options: {
    readonly outboxId: string;
    readonly workerId: string;
    readonly publishedAt?: Date | string;
  }): Promise<boolean>;
  recordFailure(options: {
    readonly outboxId: string;
    readonly workerId: string;
    readonly retryAt: Date | string;
    readonly error: unknown;
  }): Promise<boolean>;
  close?(): Promise<void>;
}

/** Publisher boundary kept deliberately local until an external bus is introduced. */
export interface EventWorkerPublisher {
  publish(event: ClaimedOutboxEvent): Promise<void>;
}

/** Options for one bounded worker pass over the transactional outbox. */
export interface RunEventWorkerOnceOptions {
  readonly store: EventWorkerOutboxStore;
  readonly workerId: string;
  readonly batchSize?: number;
  readonly retryDelayMs?: number;
  readonly publisher?: EventWorkerPublisher;
  readonly now?: () => Date;
}

/** Counts returned by the single-pass worker for CLI output and tests. */
export interface EventWorkerRunSummary {
  readonly claimedCount: number;
  readonly publishedCount: number;
  readonly failedCount: number;
  readonly deferredCount: number;
  readonly staleClaimCount: number;
}

/** Small IO boundary so CLI tests do not intercept global console output. */
export interface EventWorkerCliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

/** Test and embedding hooks for the CLI wrapper. */
export interface EventWorkerCliDependencies {
  readonly store?: EventWorkerOutboxStore;
  readonly publisher?: EventWorkerPublisher;
}

/** No-op publisher used only when the CLI explicitly asks to mark rows published. */
export class NoopOutboxPublisher implements EventWorkerPublisher {
  async publish(): Promise<void> {}
}

/** Runs one bounded outbox pass without owning process lifetime or scheduling. */
export async function runEventWorkerOnce(
  options: RunEventWorkerOnceOptions
): Promise<EventWorkerRunSummary> {
  const batchSize = options.batchSize ?? defaultBatchSize;
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  const clock = options.now ?? (() => new Date());
  const claimedEvents = await options.store.claimBatch({
    workerId: options.workerId,
    batchSize,
    now: clock()
  });

  let publishedCount = 0;
  let failedCount = 0;
  let deferredCount = 0;
  let staleClaimCount = 0;

  for (const event of claimedEvents) {
    if (!options.publisher) {
      const released = await recordRetryableFailure(
        options.store,
        event,
        options.workerId,
        retryDelayMs,
        clock,
        new Error("outbox publication is not configured")
      );
      deferredCount += released ? 1 : 0;
      staleClaimCount += released ? 0 : 1;
      continue;
    }

    try {
      await options.publisher.publish(event);
      const published = await options.store.markPublished({
        outboxId: event.outboxId,
        workerId: options.workerId,
        publishedAt: clock()
      });
      publishedCount += published ? 1 : 0;
      staleClaimCount += published ? 0 : 1;
    } catch (error: unknown) {
      const released = await recordRetryableFailure(
        options.store,
        event,
        options.workerId,
        retryDelayMs,
        clock,
        error
      );
      failedCount += released ? 1 : 0;
      staleClaimCount += released ? 0 : 1;
    }
  }

  return {
    claimedCount: claimedEvents.length,
    publishedCount,
    failedCount,
    deferredCount,
    staleClaimCount
  };
}

/** Runs the single-pass CLI and returns the process exit code the caller should use. */
export async function runEventWorkerCli(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  io: EventWorkerCliIo = {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message)
  },
  dependencies: EventWorkerCliDependencies = {}
): Promise<number> {
  let store: EventWorkerOutboxStore | undefined;
  const ownsStore = dependencies.store === undefined;

  try {
    const parsed = parseCliOptions(args);
    if (parsed.help) {
      io.stdout(formatUsage());
      return 0;
    }

    const databaseUrl = resolveDatabaseUrl(parsed, env);
    const workerId = parsed.workerId ?? defaultWorkerId();
    const publisher = parsed.publishNoop
      ? new NoopOutboxPublisher()
      : dependencies.publisher;
    store =
      dependencies.store ??
      new PostgresOutboxStore({
        databaseUrl,
        poolConfig: { allowExitOnIdle: true }
      });

    const summary = await runEventWorkerOnce({
      store,
      workerId,
      batchSize: parsed.batchSize,
      retryDelayMs: parsed.retryDelayMs,
      ...(publisher ? { publisher } : {})
    });
    io.stdout(formatSummary(summary, publisher ? "configured" : "not_configured"));
    return 0;
  } catch (error: unknown) {
    const message =
      error instanceof EventWorkerCliError
        ? error.sanitizedMessage
        : "event worker failed";
    io.stderr(
      [
        "event worker failed",
        `errorType=${classifyWorkerError(error)}`,
        `message=${quoteCliValue(message)}`
      ].join(" ")
    );
    return 1;
  } finally {
    if (ownsStore && store?.close) {
      await store.close().catch(() => undefined);
    }
  }
}

interface ParsedCliOptions {
  readonly local: boolean;
  readonly databaseUrl?: string;
  readonly workerId?: string;
  readonly batchSize: number;
  readonly retryDelayMs: number;
  readonly publishNoop: boolean;
  readonly help: boolean;
}

/** Releases a claimed row with a caller-controlled backoff timestamp. */
async function recordRetryableFailure(
  store: EventWorkerOutboxStore,
  event: ClaimedOutboxEvent,
  workerId: string,
  retryDelayMs: number,
  clock: () => Date,
  error: unknown
): Promise<boolean> {
  return store.recordFailure({
    outboxId: event.outboxId,
    workerId,
    retryAt: new Date(clock().getTime() + retryDelayMs),
    error
  });
}

/** Converts CLI flags into one-pass worker options without exposing connection details. */
function parseCliOptions(args: readonly string[]): ParsedCliOptions {
  const options: {
    local: boolean;
    databaseUrl?: string;
    workerId?: string;
    batchSize: number;
    retryDelayMs: number;
    publishNoop: boolean;
    help: boolean;
  } = {
    local: false,
    batchSize: defaultBatchSize,
    retryDelayMs: defaultRetryDelayMs,
    publishNoop: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--" || arg === "--once") {
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
      options.databaseUrl = readRequiredFlagValue(args, index, "--database-url");
      index += 1;
      continue;
    }
    if (arg === "--worker-id") {
      options.workerId = readRequiredFlagValue(args, index, "--worker-id");
      index += 1;
      continue;
    }
    if (arg === "--batch-size") {
      options.batchSize = parsePositiveInteger(
        readRequiredFlagValue(args, index, "--batch-size"),
        "--batch-size"
      );
      index += 1;
      continue;
    }
    if (arg === "--retry-delay-ms") {
      options.retryDelayMs = parsePositiveInteger(
        readRequiredFlagValue(args, index, "--retry-delay-ms"),
        "--retry-delay-ms"
      );
      index += 1;
      continue;
    }
    if (arg === "--publish-noop") {
      options.publishNoop = true;
      continue;
    }
    throw new EventWorkerCliError("unknown event worker argument");
  }

  if (options.local && options.databaseUrl) {
    throw new EventWorkerCliError("use either --local or --database-url, not both");
  }
  if (options.workerId !== undefined && options.workerId.trim().length === 0) {
    throw new EventWorkerCliError("--worker-id must not be blank");
  }
  return options;
}

/** Reads a flag value while keeping bad user input out of raw stack traces. */
function readRequiredFlagValue(
  args: readonly string[],
  index: number,
  flagName: string
): string {
  const value = args[index + 1];
  if (!value) {
    throw new EventWorkerCliError(`${flagName} requires a value`);
  }
  return value;
}

/** Resolves the worker database target from flags or the shared persistence env var. */
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
  const databaseUrl = env["FLEET_PERSISTENCE_DATABASE_URL"] ?? env["DATABASE_URL"];
  if (!databaseUrl || databaseUrl.trim().length === 0) {
    throw new EventWorkerCliError(
      "event worker Postgres database is not configured"
    );
  }
  return databaseUrl;
}

/** Parses positive integer flags used for worker limits and retry backoff. */
function parsePositiveInteger(value: string, flagName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new EventWorkerCliError(`${flagName} must be a positive integer`);
  }
  return parsed;
}

/** Gives local worker locks a useful but non-secret default owner label. */
function defaultWorkerId(): string {
  return `${eventWorkerApp}:${hostname()}:${process.pid}`;
}

/** Formats one portable CLI summary line without including database connection data. */
function formatSummary(
  summary: EventWorkerRunSummary,
  publication: "configured" | "not_configured"
): string {
  return [
    "event worker pass complete",
    `claimed=${summary.claimedCount}`,
    `published=${summary.publishedCount}`,
    `failed=${summary.failedCount}`,
    `deferred=${summary.deferredCount}`,
    `staleClaims=${summary.staleClaimCount}`,
    `publication=${publication}`
  ].join(" ");
}

/** Prints terse usage for manual one-pass outbox processing. */
function formatUsage(): string {
  return [
    "Usage: pnpm --filter @roboops/event-worker once -- [options]",
    "",
    "Options:",
    "  --local                 Use the local Docker Compose database URL.",
    "  --database-url <url>    Use an explicit Postgres connection string.",
    "  --worker-id <id>        Override the durable outbox lock owner.",
    "  --batch-size <count>    Limit rows claimed in one pass.",
    "  --retry-delay-ms <ms>   Delay failed rows before they are claimable again.",
    "  --publish-noop         Mark rows published through an explicit no-op publisher.",
    "  --help                  Show this help text."
  ].join("\n");
}

/** Classifies failures without exposing driver messages or connection strings. */
function classifyWorkerError(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(error.name)) {
    return error.name;
  }
  return typeof error;
}

/** Quotes one CLI value while stripping control characters from console output. */
function quoteCliValue(value: string): string {
  return JSON.stringify(value.replaceAll(/[\r\n\t]/g, " "));
}

/** Error class for CLI failures whose messages are safe to print. */
class EventWorkerCliError extends Error {
  constructor(readonly sanitizedMessage: string) {
    super(sanitizedMessage);
    this.name = "EventWorkerCliError";
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runEventWorkerCli();
}
