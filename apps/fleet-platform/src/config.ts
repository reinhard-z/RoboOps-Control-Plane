import type {
  FleetPersistenceConfig,
  FleetPersistenceMode,
  FleetPlatformConfig
} from "./types.js";

/** Converts environment variables into a typed server configuration. */
export function loadFleetPlatformConfig(
  env: NodeJS.ProcessEnv = process.env
): FleetPlatformConfig {
  return {
    host: env["HOST"] ?? "127.0.0.1",
    port: parsePort(env["PORT"], 4010),
    demoMode: env["DEMO_MODE"] === "true",
    ...(env["DEMO_ADMIN_TOKEN"]
      ? { demoAdminToken: env["DEMO_ADMIN_TOKEN"] }
      : {}),
    demoRobotId: env["DEMO_ROBOT_ID"] ?? "robot-a",
    corsAllowOrigin: env["CORS_ALLOW_ORIGIN"] ?? "*",
    defaultCommandTtlMs: parsePositiveInteger(
      env["DEFAULT_COMMAND_TTL_MS"],
      10_000
    ),
    telemetryFreshnessSweepMs: parsePositiveInteger(
      env["TELEMETRY_FRESHNESS_SWEEP_MS"],
      1_000
    ),
    persistence: parsePersistenceConfig(env)
  };
}

/** Parses TCP ports defensively so bad env input fails back to a local default. */
function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) {
    return parsed;
  }
  return fallback;
}

/** Parses positive millisecond configuration with a conservative fallback. */
function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

/** Converts persistence env vars into an explicit repository adapter choice. */
function parsePersistenceConfig(env: NodeJS.ProcessEnv): FleetPersistenceConfig {
  const mode = parsePersistenceMode(env["FLEET_PERSISTENCE_MODE"]);
  if (mode === "in-memory") {
    return { mode };
  }

  const databaseUrl = parseOptionalText(env["FLEET_PERSISTENCE_DATABASE_URL"]);
  if (!databaseUrl) {
    throw new Error(
      "FLEET_PERSISTENCE_DATABASE_URL is required when FLEET_PERSISTENCE_MODE=postgres"
    );
  }
  return { mode, databaseUrl };
}

/** Defaults to the local in-memory adapter unless Postgres is explicitly selected. */
function parsePersistenceMode(value: string | undefined): FleetPersistenceMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "in-memory") {
    return "in-memory";
  }
  if (normalized === "postgres") {
    return "postgres";
  }
  throw new Error(
    `Unsupported FLEET_PERSISTENCE_MODE "${value}". Use "in-memory" or "postgres".`
  );
}

/** Treats blank env vars as absent while preserving the caller's actual value. */
function parseOptionalText(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  return value;
}
