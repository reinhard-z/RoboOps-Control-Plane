import type {
  MissionCommandResponse,
  MissionSnapshot,
  PoseTarget,
  RobotSnapshot
} from "./types.js";
import { formatCommandRejectionMessage } from "./view-model.js";

/** Browser API client configuration for Fleet Platform REST calls. */
export interface FleetPlatformApiClientConfig {
  readonly apiBaseUrl: string;
  readonly demoAdminToken?: string;
  readonly fetchImpl?: typeof fetch;
}

/** Request options shared by the low-level JSON transport helper. */
interface RequestJsonOptions {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly acceptCommandRejection?: boolean;
}

/** Small typed wrapper around Fleet Platform's REST surface used by the UI. */
export class FleetPlatformApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: FleetPlatformApiClientConfig) {
    // Native browser fetch can throw if it is called later with this client as `this`.
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Builds the browser URL used to subscribe to Fleet Platform SSE events. */
  eventStreamUrl(): string {
    return this.apiUrl("/stream/events");
  }

  /** Loads the latest snapshot for one robot. */
  async getRobot(robotId: string): Promise<RobotSnapshot> {
    const body = await this.requestJson<{ readonly robot: RobotSnapshot }>(
      `/robots/${encodeURIComponent(robotId)}`
    );
    return body.robot;
  }

  /** Loads all mission snapshots in platform order. */
  async listMissions(): Promise<readonly MissionSnapshot[]> {
    const body = await this.requestJson<{
      readonly missions: readonly MissionSnapshot[];
    }>("/missions");
    return body.missions;
  }

  /** Creates the normal operator GO_TO_POSE command and preserves rejection bodies. */
  createGoToPoseMission(
    robotId: string,
    target: PoseTarget
  ): Promise<MissionCommandResponse> {
    return this.requestJson<MissionCommandResponse>("/missions", {
      method: "POST",
      acceptCommandRejection: true,
      body: {
        robotId,
        type: "GO_TO_POSE",
        safetyClass: "NORMAL",
        payload: { target }
      }
    });
  }

  /** Requests cancellation for a selected active mission. */
  cancelMission(
    missionId: string,
    reason: string
  ): Promise<MissionCommandResponse> {
    return this.requestJson<MissionCommandResponse>(
      `/missions/${encodeURIComponent(missionId)}/cancel`,
      {
        method: "POST",
        acceptCommandRejection: true,
        body: { reason }
      }
    );
  }

  /** Resets in-memory demo state through the protected demo admin endpoint. */
  async resetDemoState(): Promise<void> {
    await this.requestDemoJson("/demo/scenarios/reset");
  }

  /** Starts the protected clean incident demo flow. */
  startIncidentDemo(): Promise<MissionCommandResponse> {
    return this.requestDemoJson<MissionCommandResponse>(
      "/demo/scenarios/incident/start"
    );
  }

  /** Drives the protected demo stale-telemetry fault path. */
  markDemoTelemetryStale(): Promise<unknown> {
    return this.requestDemoJson("/demo/faults/disconnect");
  }

  /** Drives the protected demo reconnect reconciliation path. */
  reconnectDemoRobot(): Promise<unknown> {
    return this.requestDemoJson("/demo/faults/reconnect");
  }

  /** Calls one protected demo endpoint with the configured local admin token. */
  private requestDemoJson<T = unknown>(path: string): Promise<T> {
    const demoAdminToken = this.config.demoAdminToken;
    if (!demoAdminToken) {
      throw new Error("demo controls are not configured");
    }

    return this.requestJson<T>(path, {
      method: "POST",
      headers: { "X-Demo-Admin-Token": demoAdminToken }
    });
  }

  /** Sends and receives JSON from the Fleet Platform API. */
  private async requestJson<T>(
    path: string,
    init: RequestJsonOptions = {}
  ): Promise<T> {
    const requestInit: RequestInit = {
      method: init.method ?? "GET",
      ...(init.headers ? { headers: init.headers } : {})
    };
    if (init.body !== undefined) {
      requestInit.headers = {
        ...init.headers,
        "Content-Type": "application/json"
      };
      requestInit.body = JSON.stringify(init.body);
    }

    const response = await this.sendRequest(path, requestInit);
    const text = await response.text();
    const parsedBody = parseJsonResponseBody(text);
    if (!response.ok) {
      if (
        init.acceptCommandRejection &&
        parsedBody.ok &&
        isRejectedMissionCommandResponse(parsedBody.value)
      ) {
        return parsedBody.value as T;
      }

      const detail = parsedBody.ok
        ? readApiFailureMessage(parsedBody.value)
        : "Fleet Platform returned an unreadable error response.";
      throw new Error(detail ?? "Fleet Platform request failed.");
    }
    if (!parsedBody.ok) {
      throw new Error("Fleet Platform returned an unreadable response.");
    }
    return parsedBody.value as T;
  }

  /** Wraps fetch failures in copy that is safe to show directly in the console. */
  private async sendRequest(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(this.apiUrl(path), init);
    } catch {
      throw new Error(
        "Fleet Platform API unavailable. Check the API URL and CORS settings."
      );
    }
  }

  /** Joins API paths without depending on trailing slash configuration. */
  private apiUrl(path: string): string {
    return `${this.config.apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }
}

/** Parses JSON responses without hiding HTTP status failures behind SyntaxError. */
function parseJsonResponseBody(
  text: string
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string } {
  if (text.length === 0) {
    return { ok: true, value: undefined };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "response body was not valid JSON" };
  }
}

/** Recognizes command rejection bodies that should still update mission UI state. */
function isRejectedMissionCommandResponse(
  value: unknown
): value is MissionCommandResponse {
  if (!isRecord(value) || !isRecord(value["result"])) {
    return false;
  }

  return (
    value["result"]["status"] === "REJECTED" &&
    typeof value["deliveryCount"] === "number"
  );
}

/** Extracts safe operator copy from structured API errors or command rejections. */
function readApiFailureMessage(body: unknown): string | undefined {
  const rejectionMessage = readCommandRejectionMessage(body);
  if (rejectionMessage) {
    return rejectionMessage;
  }

  if (!isRecord(body) || !isRecord(body["error"])) {
    return undefined;
  }
  const error = body["error"];
  const code = typeof error["code"] === "string" ? error["code"] : "API_ERROR";
  return apiErrorMessageForCode(code);
}

/** Maps backend error codes to concise copy without leaking transport details. */
function apiErrorMessageForCode(code: string): string {
  switch (code) {
    case "DEMO_ADMIN_TOKEN_REQUIRED":
      return "Demo admin token missing or invalid.";
    case "DEMO_ENDPOINT_DISABLED":
      return "Demo controls are disabled on Fleet Platform.";
    case "MISSION_NOT_FOUND":
      return "Mission not found in Fleet Platform.";
    case "PERSISTENCE_NOT_READY":
      return "Fleet Platform persistence is not ready.";
    case "ROBOT_NOT_FOUND":
      return "Robot not found in Fleet Platform.";
    case "VALIDATION_FAILED":
      return "Fleet Platform rejected the request body.";
    default:
      return "Fleet Platform request failed.";
  }
}

/** Reads rejected dispatch responses that intentionally use non-2xx HTTP status. */
function readCommandRejectionMessage(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body["result"])) {
    return undefined;
  }

  const result = body["result"];
  if (result["status"] !== "REJECTED") {
    return undefined;
  }

  const reason = typeof result["reason"] === "string" ? result["reason"] : undefined;
  return formatCommandRejectionMessage(reason);
}

/** Checks whether a JSON-like value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
