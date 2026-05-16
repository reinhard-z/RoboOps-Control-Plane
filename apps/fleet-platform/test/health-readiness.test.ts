import { type AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type FleetPlatformRuntime,
  type StructuredLogger,
  createFleetPlatformRuntime,
  listenFleetPlatform
} from "../src/index.js";
import type { LogFields } from "../src/logging.js";

describe("fleet platform health readiness", () => {
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

  it("reports the default in-memory repository as ready", async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: "ready",
      persistence: {
        mode: "in-memory"
      },
      sseSubscribers: 0
    });
  });

  it("reports an unhealthy readiness response when the repository read fails", async () => {
    runtime.repository.read = async () => {
      throw new Error(
        "raw driver failure for postgres://user:password@127.0.0.1:55432/db"
      );
    };

    const response = await fetch(`${baseUrl}/health/ready`, {
      headers: { "X-Correlation-Id": "corr-readiness-failure" }
    });
    const body = await response.json();
    const serializedBody = JSON.stringify(body);
    const serializedLogs = JSON.stringify(logger.entries);

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: {
        code: "PERSISTENCE_NOT_READY",
        message: "persistence backend is not ready",
        correlationId: "corr-readiness-failure",
        details: {
          persistenceMode: "in-memory",
          check: "repository.read"
        }
      }
    });
    expect(serializedBody).not.toContain("postgres://");
    expect(serializedBody).not.toContain("password");
    expect(serializedLogs).not.toContain("postgres://");
    expect(serializedLogs).not.toContain("password");
    expect(logger.entries).toContainEqual({
      level: "warn",
      message: "persistence readiness check failed",
      fields: {
        correlationId: "corr-readiness-failure",
        persistenceMode: "in-memory",
        check: "repository.read",
        errorType: "Error"
      }
    });
  });

  it("times out a stuck repository readiness read with a sanitized response", async () => {
    runtime.repository.read = () => new Promise(() => undefined);

    const startedAt = Date.now();
    const response = await fetch(`${baseUrl}/health/ready`, {
      headers: { "X-Correlation-Id": "corr-readiness-timeout" }
    });
    const elapsedMs = Date.now() - startedAt;
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(elapsedMs).toBeLessThan(3_000);
    expect(body).toEqual({
      error: {
        code: "PERSISTENCE_NOT_READY",
        message: "persistence backend is not ready",
        correlationId: "corr-readiness-timeout",
        details: {
          persistenceMode: "in-memory",
          check: "repository.read"
        }
      }
    });
    expect(logger.entries).toContainEqual({
      level: "warn",
      message: "persistence readiness check failed",
      fields: {
        correlationId: "corr-readiness-timeout",
        persistenceMode: "in-memory",
        check: "repository.read",
        errorType: "ReadinessTimeoutError"
      }
    });
  });
});

/** Captures structured logs so diagnostics can be asserted without console noise. */
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

/** Stops the runtime internals before closing the bound HTTP server. */
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
