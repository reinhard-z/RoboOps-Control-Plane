import { describe, expect, it } from "vitest";

import { FleetPlatformApiClient } from "../src/api-client.js";
import type { MissionCommandResponse } from "../src/types.js";

describe("operator UI API client", () => {
  it("returns non-2xx create mission rejections so UI state can use the body", async () => {
    const rejection = rejectedMissionResponse();
    let requestUrl = "";
    let requestBody: unknown;
    const api = new FleetPlatformApiClient({
      apiBaseUrl: "http://fleet.test",
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body)) as unknown;
        return jsonResponse(rejection, 409);
      }
    });

    const result = await api.createGoToPoseMission("robot-a", {
      x: 2,
      y: 4.5,
      theta: 1.57
    });

    expect(requestUrl).toBe("http://fleet.test/missions");
    expect(requestBody).toMatchObject({
      robotId: "robot-a",
      type: "GO_TO_POSE",
      safetyClass: "NORMAL"
    });
    expect(result).toEqual(rejection);
  });

  it("returns non-2xx cancel rejections so UI state can use the body", async () => {
    const rejection = rejectedCancelResponse();
    let requestUrl = "";
    let requestBody: unknown;
    const api = new FleetPlatformApiClient({
      apiBaseUrl: "http://fleet.test",
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body)) as unknown;
        return jsonResponse(rejection, 422);
      }
    });

    const result = await api.cancelMission(
      "mission-old",
      "operator requested cancel from UI"
    );

    expect(requestUrl).toBe("http://fleet.test/missions/mission-old/cancel");
    expect(requestBody).toEqual({
      reason: "operator requested cancel from UI"
    });
    expect(result).toEqual(rejection);
  });

  it("throws concise structured errors for ordinary non-2xx API failures", async () => {
    const api = new FleetPlatformApiClient({
      apiBaseUrl: "http://fleet.test",
      fetchImpl: async () =>
        jsonResponse(
          {
            error: {
              code: "ROBOT_NOT_FOUND",
              message: "robot not found",
              correlationId: "corr-test"
            }
          },
          404
        )
    });

    await expect(api.getRobot("robot-a")).rejects.toThrow(
      "ROBOT_NOT_FOUND: robot not found"
    );
  });

  it("requires demo admin config before calling protected demo endpoints", async () => {
    const api = new FleetPlatformApiClient({
      apiBaseUrl: "http://fleet.test",
      fetchImpl: async () => jsonResponse({})
    });

    await expect(api.resetDemoState()).rejects.toThrow(
      "demo controls are not configured"
    );
  });

  it("sends the demo admin token when configured", async () => {
    let requestHeaders: HeadersInit | undefined;
    const api = new FleetPlatformApiClient({
      apiBaseUrl: "http://fleet.test",
      demoAdminToken: "local-demo-token",
      fetchImpl: async (_input, init) => {
        requestHeaders = init?.headers;
        return jsonResponse({});
      }
    });

    await api.markDemoTelemetryStale();

    expect(requestHeaders).toMatchObject({
      "X-Demo-Admin-Token": "local-demo-token"
    });
  });
});

/** Creates a Response with the JSON shape returned by Fleet Platform tests. */
function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

/** Builds a rejected dispatch body with the mission snapshot the UI should select. */
function rejectedMissionResponse(): MissionCommandResponse {
  return {
    result: {
      status: "REJECTED",
      reason: "ROBOT_ALREADY_ASSIGNED",
      mission: {
        missionId: "mission-rejected",
        robotId: "robot-a",
        lifecycleState: "SAFETY_BLOCKED",
        operationalStatus: "DEGRADED",
        createdAt: "2026-05-15T12:00:00.000Z",
        updatedAt: "2026-05-15T12:00:00.000Z",
        failureReason: "ROBOT_ALREADY_ASSIGNED"
      }
    },
    deliveryCount: 0,
    correlationId: "corr-test"
  };
}

/** Builds a rejected cancel body returned when the selected mission is stale. */
function rejectedCancelResponse(): MissionCommandResponse {
  return {
    result: {
      status: "REJECTED",
      reason: "MISSION_NOT_ACTIVE",
      mission: {
        missionId: "mission-old",
        robotId: "robot-a",
        lifecycleState: "CANCELLED",
        operationalStatus: "NOMINAL",
        createdAt: "2026-05-15T12:00:00.000Z",
        updatedAt: "2026-05-15T12:01:00.000Z"
      }
    },
    deliveryCount: 0,
    correlationId: "corr-test"
  };
}
