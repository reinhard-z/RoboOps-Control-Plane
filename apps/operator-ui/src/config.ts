const defaultApiBaseUrl = "http://127.0.0.1:4010";
const defaultHost = "127.0.0.1";
const defaultPort = 4020;
const defaultRobotId = "robot-a";

/** Runtime configuration shared by the server and injected browser app. */
export interface OperatorUiConfig {
  readonly host: string;
  readonly port: number;
  readonly apiBaseUrl: string;
  readonly robotId: string;
  readonly pollIntervalMs: number;
  readonly demoMode: boolean;
  readonly demoAdminToken?: string;
}

/** Converts environment variables into a typed Operator UI configuration. */
export function loadOperatorUiConfig(
  env: NodeJS.ProcessEnv = process.env
): OperatorUiConfig {
  const demoAdminToken =
    env["OPERATOR_DEMO_ADMIN_TOKEN"] ?? env["DEMO_ADMIN_TOKEN"];
  return {
    host: env["OPERATOR_UI_HOST"] ?? env["HOST"] ?? defaultHost,
    port: parsePort(env["OPERATOR_UI_PORT"] ?? env["PORT"], defaultPort),
    apiBaseUrl: normalizeBaseUrl(
      env["OPERATOR_API_BASE_URL"] ??
        env["FLEET_PLATFORM_URL"] ??
        defaultApiBaseUrl
    ),
    robotId: env["OPERATOR_ROBOT_ID"] ?? env["ROBOT_ID"] ?? defaultRobotId,
    pollIntervalMs: parsePositiveInteger(env["OPERATOR_POLL_INTERVAL_MS"], 2_000),
    demoMode: env["OPERATOR_DEMO_MODE"] === "true",
    ...(demoAdminToken ? { demoAdminToken } : {})
  };
}

/** Parses a TCP port while keeping local demos tolerant of bad env input. */
function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) {
    return parsed;
  }
  return fallback;
}

/** Parses positive millisecond values with a stable browser polling fallback. */
function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

/** Normalizes API base URLs so browser request joins are deterministic. */
function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}
