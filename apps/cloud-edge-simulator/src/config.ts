import { simulatorScenarios, type CloudEdgeSimulatorConfig } from "./types.js";

const defaultFleetPlatformUrl = "http://127.0.0.1:4010";

/** Converts environment variables into simulator runtime configuration. */
export function loadCloudEdgeSimulatorConfig(
  env: NodeJS.ProcessEnv = process.env
): CloudEdgeSimulatorConfig {
  return {
    fleetPlatformUrl: normalizeBaseUrl(
      env["FLEET_PLATFORM_URL"] ?? defaultFleetPlatformUrl
    ),
    robotId: env["ROBOT_ID"] ?? "robot-a",
    edgeAgentVersion: env["EDGE_AGENT_VERSION"] ?? "sim-0.1.0",
    scenario: parseScenario(env["SIM_SCENARIO"]),
    heartbeatIntervalMs: parsePositiveInteger(env["SIM_HEARTBEAT_MS"], 1_000),
    reconnectDelayMs: parsePositiveInteger(env["SIM_RECONNECT_DELAY_MS"], 1_000)
  };
}

/** Builds the exact WebSocket URL accepted by apps/fleet-platform. */
export function createEdgeConnectUrl(config: CloudEdgeSimulatorConfig): string {
  const url = new URL(config.fleetPlatformUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/edge/connect";
  url.search = "";
  url.searchParams.set("robotId", config.robotId);
  return url.toString();
}

/** Parses the scenario enum defensively so bad env values do not crash demos. */
function parseScenario(value: string | undefined): CloudEdgeSimulatorConfig["scenario"] {
  if (value && simulatorScenarios.includes(value as CloudEdgeSimulatorConfig["scenario"])) {
    return value as CloudEdgeSimulatorConfig["scenario"];
  }
  return "normal";
}

/** Parses positive millisecond env values with a stable local-demo fallback. */
function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

/** Normalizes URL input once so later URL joins do not depend on env formatting. */
function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

