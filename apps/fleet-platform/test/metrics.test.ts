import { type AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type FleetPlatformRuntime,
  type StructuredLogger,
  createFleetPlatformRuntime,
  listenFleetPlatform
} from "../src/index.js";
import type { LogFields } from "../src/logging.js";

describe("fleet platform observability", () => {
  let runtime: FleetPlatformRuntime;
  let baseUrl: string;
  let logger: CapturingStructuredLogger;

  beforeEach(async () => {
    logger = new CapturingStructuredLogger();
    runtime = createFleetPlatformRuntime({
      config: {
        host: "127.0.0.1",
        port: 0,
        demoMode: false,
        demoRobotId: "robot-a",
        corsAllowOrigin: "*",
        defaultCommandTtlMs: 10_000,
        telemetryFreshnessSweepMs: 60_000
      },
      logger
    });
    await listenFleetPlatform(runtime);
    const address = runtime.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await closeRuntime(runtime);
  });

  it("serves Prometheus text metrics with HTTP request counters", async () => {
    await fetch(`${baseUrl}/health/live`);
    await fetch(`${baseUrl}/missions/m_live_metric_id`);

    const response = await fetch(`${baseUrl}/metrics`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "text/plain; version=0.0.4"
    );
    expect(text).toContain(
      'roboops_fleet_platform_http_requests_total{method="GET",route="/health/live",status_class="2xx"} 1'
    );
    expect(text).toContain(
      'roboops_fleet_platform_http_requests_total{method="GET",route="/missions/:missionId",status_class="4xx"} 1'
    );
    expect(text).not.toContain("m_live_metric_id");
  });

  it("records readiness failure metrics without raw error text", async () => {
    runtime.repository.read = async () => {
      const error = new Error(
        "raw driver failure for postgres://user:password@127.0.0.1:55432/db"
      );
      error.name = "DriverConnectionError";
      throw error;
    };

    const readiness = await fetch(`${baseUrl}/health/ready`, {
      headers: { "X-Correlation-Id": "corr-readiness-metric" }
    });
    expect(readiness.status).toBe(503);

    const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
    expect(metrics).toContain(
      'roboops_fleet_platform_readiness_failures_total{persistence_mode="in-memory",check="repository.read",error_type="DriverConnectionError"} 1'
    );
    expect(metrics).not.toContain("postgres://");
    expect(metrics).not.toContain("password");
    expect(metrics).not.toContain("raw driver failure");
  });

  it("emits safe structured incident logs for command decisions", async () => {
    const accepted = await postJson(`${baseUrl}/missions`, {
      robotId: "robot-a",
      type: "GO_TO_POSE",
      commandId: "cmd-observable-001",
      idempotencyKey: "operator:test:observability:one",
      payload: { target: { x: 2, y: 4.5, theta: 1.57 } }
    });
    expect(accepted.status).toBe(202);

    const rejected = await postJson(`${baseUrl}/missions`, {
      robotId: "robot-a",
      type: "GO_TO_POSE",
      commandId: "cmd-observable-001",
      idempotencyKey: "operator:test:observability:two",
      payload: { target: { x: 2, y: 4.5, theta: 1.57 } }
    });
    expect(rejected.status).toBe(409);

    expect(logger.entries).toContainEqual({
      level: "info",
      message: "mission command requested",
      fields: expect.objectContaining({
        missionId: expect.any(String),
        commandId: "cmd-observable-001",
        robotId: "robot-a",
        commandType: "GO_TO_POSE",
        correlationId: expect.any(String)
      }) as LogFields
    });
    expect(logger.entries).toContainEqual({
      level: "info",
      message: "mission command accepted",
      fields: expect.objectContaining({
        eventType: "mission.command.dispatched",
        commandId: "cmd-observable-001",
        robotId: "robot-a",
        correlationId: expect.any(String)
      }) as LogFields
    });
    expect(logger.entries).toContainEqual({
      level: "warn",
      message: "mission command rejected",
      fields: expect.objectContaining({
        eventType: "mission.command.rejected",
        reason: "DUPLICATE_COMMAND_ID",
        correlationId: expect.any(String)
      }) as LogFields
    });

    const serializedLogs = JSON.stringify(logger.entries);
    expect(serializedLogs).not.toContain("payload");
    expect(serializedLogs).not.toContain("target");
    expect(serializedLogs).not.toContain("postgres://");
  });
});

/** Captures structured logs so observability tests can inspect safe fields. */
class CapturingStructuredLogger implements StructuredLogger {
  readonly entries: Array<{
    readonly level: "info" | "warn" | "error";
    readonly message: string;
    readonly fields: LogFields;
  }> = [];

  info(message: string, fields: LogFields = {}): void {
    this.entries.push({ level: "info", message, fields });
  }

  warn(message: string, fields: LogFields = {}): void {
    this.entries.push({ level: "warn", message, fields });
  }

  error(message: string, fields: LogFields = {}): void {
    this.entries.push({ level: "error", message, fields });
  }
}

/** Posts JSON and returns both status and parsed response body. */
async function postJson(
  url: string,
  body: unknown
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

/** Stops runtime internals before closing the bound HTTP listener. */
async function closeRuntime(runtime: FleetPlatformRuntime): Promise<void> {
  await runtime.stop();
  await new Promise<void>((resolve, reject) => {
    runtime.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
