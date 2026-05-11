import type { FleetPlatformConfig } from "./types.js";

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
    )
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
