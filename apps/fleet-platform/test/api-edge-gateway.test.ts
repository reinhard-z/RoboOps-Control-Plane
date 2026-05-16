import { type AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CommandEnvelopeV1,
  protocolSchemaVersions
} from "@roboops/fleet-protocol";
import {
  type FleetPlatformRuntime,
  SilentStructuredLogger,
  createFleetPlatformRuntime,
  createSeededDomainState,
  listenFleetPlatform
} from "../src/index.js";

interface TestWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { readonly data?: unknown }) => void,
    options?: { readonly once?: boolean }
  ): void;
  removeEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { readonly data?: unknown }) => void
  ): void;
}

describe("fleet platform API and edge gateway", () => {
  let runtime: FleetPlatformRuntime;
  let baseUrl: string;
  let edgeUrl: string;

  beforeEach(async () => {
    runtime = createFleetPlatformRuntime({
      config: {
        host: "127.0.0.1",
        port: 0,
        demoMode: false,
        demoRobotId: "robot-a",
        corsAllowOrigin: "*",
        defaultCommandTtlMs: 10_000,
        telemetryFreshnessSweepMs: 50
      },
      logger: new SilentStructuredLogger()
    });
    await listenFleetPlatform(runtime);
    const address = runtime.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    edgeUrl = `ws://127.0.0.1:${address.port}/edge/connect?robotId=robot-a`;
  });

  afterEach(async () => {
    await closeRuntime(runtime);
  });

  it("creates a mission over HTTP, delivers the command over WebSocket, and applies an edge ack", async () => {
    const edge = await openWebSocket(edgeUrl);
    const commandMessagePromise = nextWebSocketMessageOfType(edge, "platform.command");

    const createResponse = await postJson(`${baseUrl}/missions`, {
      robotId: "robot-a",
      type: "GO_TO_POSE",
      idempotencyKey: "operator:test:api-edge:create",
      payload: { target: { x: 2, y: 4.5, theta: 1.57 } }
    });
    expect(createResponse.status).toBe(202);
    expect((createResponse.body as { readonly deliveryCount: number }).deliveryCount).toBe(
      1
    );

    const commandMessage = await commandMessagePromise;
    const command = commandMessage["payload"] as CommandEnvelopeV1;
    expect(command.robotId).toBe("robot-a");
    expect(command.sequence).toBe(1);

    edge.send(
      JSON.stringify({
        type: "edge.command_ack",
        payload: {
          schemaVersion: protocolSchemaVersions.commandAck,
          ackId: "ack-api-edge-001",
          commandId: command.commandId,
          missionId: command.missionId,
          robotId: command.robotId,
          status: "ACCEPTED",
          receivedAt: new Date().toISOString(),
          lastSeenCommandSequence: command.sequence,
          correlationId: command.correlationId,
          causationId: command.commandId
        }
      })
    );

    await eventually(async () => {
      const missionResponse = await fetch(`${baseUrl}/missions/${command.missionId}`);
      const missionBody = (await missionResponse.json()) as {
        readonly mission: { readonly lifecycleState: string };
      };
      expect(missionBody.mission.lifecycleState).toBe("RUNNING");
    });

    const auditResponse = await fetch(
      `${baseUrl}/audit-events?missionId=${command.missionId}`
    );
    const auditBody = (await auditResponse.json()) as {
      readonly auditEvents: readonly { readonly action: string }[];
    };
    expect(auditBody.auditEvents.map((event) => event.action)).toContain(
      "mission.command.acked"
    );

    const cancelMessagePromise = nextWebSocketMessageOfType(edge, "platform.command");
    const cancelResponse = await postJson(
      `${baseUrl}/missions/${command.missionId}/cancel`,
      { reason: "operator test cancel" }
    );
    expect(cancelResponse.status).toBe(202);

    const cancelMessage = await cancelMessagePromise;
    const cancelCommand = cancelMessage["payload"] as CommandEnvelopeV1;
    expect(cancelCommand.type).toBe("CANCEL_MISSION");
    expect(cancelCommand.missionId).toBe(command.missionId);

    const cancelRequestedResponse = await fetch(
      `${baseUrl}/missions/${command.missionId}`
    );
    const cancelRequestedBody = (await cancelRequestedResponse.json()) as {
      readonly mission: { readonly lifecycleState: string };
    };
    expect(cancelRequestedBody.mission.lifecycleState).toBe("CANCEL_REQUESTED");

    edge.send(
      JSON.stringify({
        type: "edge.command_ack",
        payload: {
          schemaVersion: protocolSchemaVersions.commandAck,
          ackId: "ack-api-edge-cancel-001",
          commandId: cancelCommand.commandId,
          missionId: cancelCommand.missionId,
          robotId: cancelCommand.robotId,
          status: "ACCEPTED",
          receivedAt: new Date().toISOString(),
          lastSeenCommandSequence: cancelCommand.sequence,
          correlationId: cancelCommand.correlationId,
          causationId: cancelCommand.commandId
        }
      })
    );

    await eventually(async () => {
      const missionResponse = await fetch(`${baseUrl}/missions/${command.missionId}`);
      const missionBody = (await missionResponse.json()) as {
        readonly mission: { readonly lifecycleState: string };
      };
      expect(missionBody.mission.lifecycleState).toBe("CANCELLED");
    });

    const cancelAuditResponse = await fetch(
      `${baseUrl}/audit-events?missionId=${command.missionId}`
    );
    const cancelAuditBody = (await cancelAuditResponse.json()) as {
      readonly auditEvents: readonly {
        readonly action: string;
        readonly commandId?: string;
        readonly details: Record<string, unknown>;
      }[];
    };
    const cancelAckAudit = cancelAuditBody.auditEvents.find(
      (event) =>
        event.action === "mission.command.acked" &&
        event.commandId === cancelCommand.commandId
    );
    expect(cancelAckAudit?.details).toMatchObject({
      commandType: "CANCEL_MISSION",
      lifecycleState: "CANCELLED"
    });

    edge.close();
  });

  it("delivers a queued command only once when the edge sends hello after connecting", async () => {
    const createResponse = await postJson(`${baseUrl}/missions`, {
      robotId: "robot-a",
      type: "GO_TO_POSE",
      idempotencyKey: "operator:test:queued:create",
      payload: { target: { x: 3, y: 4, theta: 0.25 } }
    });
    expect(createResponse.status).toBe(202);
    expect((createResponse.body as { readonly deliveryCount: number }).deliveryCount).toBe(
      0
    );

    const edge = await openWebSocket(edgeUrl);
    const messagesPromise = collectWebSocketMessages(edge, 150);
    edge.send(
      JSON.stringify({
        type: "edge.hello",
        payload: {
          edgeSessionId: "edge-session-api-edge-hello",
          edgeAgentVersion: "0.1.0",
          lastSeenCommandSequence: 0
        }
      })
    );

    const messages = await messagesPromise;
    const commandMessages = messages.filter(
      (message) => message["type"] === "platform.command"
    );
    expect(commandMessages).toHaveLength(1);
    edge.close();
  });

  it("streams reducer-produced events to SSE clients", async () => {
    const controller = new AbortController();
    const streamResponse = await fetch(`${baseUrl}/stream/events`, {
      signal: controller.signal
    });
    expect(streamResponse.status).toBe(200);
    if (!streamResponse.body) {
      throw new Error("expected SSE response body");
    }

    const reader = streamResponse.body.getReader();
    const eventPromise = readStreamUntil(reader, "mission.command.dispatched");
    const createResponse = await postJson(`${baseUrl}/missions`, {
      robotId: "robot-a",
      type: "GO_TO_POSE",
      idempotencyKey: "operator:test:sse:create",
      payload: { target: { x: 1, y: 2, theta: 0.5 } }
    });

    expect(createResponse.status).toBe(202);
    expect(await eventPromise).toContain("mission.command.dispatched");
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });

  it("keeps demo endpoints disabled unless demo mode is explicitly enabled", async () => {
    const response = await postJson(`${baseUrl}/demo/scenarios/reset`, {});
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: "DEMO_ENDPOINT_DISABLED",
        message: "demo endpoints are disabled",
        correlationId: expect.any(String)
      }
    });
  });

  it("requires the demo admin token and resets in-memory demo state", async () => {
    await closeRuntime(runtime);

    runtime = createFleetPlatformRuntime({
      config: {
        host: "127.0.0.1",
        port: 0,
        demoMode: true,
        demoAdminToken: "local-demo-token",
        demoRobotId: "robot-a",
        corsAllowOrigin: "*",
        defaultCommandTtlMs: 10_000,
        telemetryFreshnessSweepMs: 50
      },
      logger: new SilentStructuredLogger()
    });
    await listenFleetPlatform(runtime);
    const address = runtime.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    edgeUrl = `ws://127.0.0.1:${address.port}/edge/connect?robotId=robot-a`;

    const missingToken = await postJson(`${baseUrl}/demo/scenarios/reset`, {});
    expect(missingToken.status).toBe(401);

    const wrongToken = await postJson(
      `${baseUrl}/demo/scenarios/reset`,
      {},
      { "X-Demo-Admin-Token": "wrong-token" }
    );
    expect(wrongToken.status).toBe(401);

    const incident = await postJson(
      `${baseUrl}/demo/scenarios/incident/start`,
      {},
      { "X-Demo-Admin-Token": "local-demo-token" }
    );
    expect(incident.status).toBe(202);

    const missionsBeforeReset = await fetch(`${baseUrl}/missions`);
    const missionsBeforeResetBody = (await missionsBeforeReset.json()) as {
      readonly missions: readonly unknown[];
    };
    expect(missionsBeforeResetBody.missions).toHaveLength(1);

    const repeatedIncident = await postJson(
      `${baseUrl}/demo/scenarios/incident/start`,
      {},
      { "X-Demo-Admin-Token": "local-demo-token" }
    );
    expect(repeatedIncident.status).toBe(202);

    const missionsAfterRepeatedStart = await fetch(`${baseUrl}/missions`);
    const missionsAfterRepeatedStartBody = (await missionsAfterRepeatedStart.json()) as {
      readonly missions: readonly unknown[];
    };
    expect(missionsAfterRepeatedStartBody.missions).toHaveLength(1);

    const reset = await postJson(
      `${baseUrl}/demo/scenarios/reset`,
      {},
      { "X-Demo-Admin-Token": "local-demo-token" }
    );
    expect(reset.status).toBe(200);

    const missionsAfterReset = await fetch(`${baseUrl}/missions`);
    const missionsAfterResetBody = (await missionsAfterReset.json()) as {
      readonly missions: readonly unknown[];
    };
    expect(missionsAfterResetBody.missions).toEqual([]);

    const robotResponse = await fetch(`${baseUrl}/robots/robot-a`);
    const robotBody = (await robotResponse.json()) as {
      readonly robot: {
        readonly connectionState: string;
        readonly activeMissionId?: string;
      };
    };
    expect(robotBody.robot.connectionState).toBe("ONLINE");
    expect(robotBody.robot.activeMissionId).toBeUndefined();
  });

  it("drives demo stale and reconnect faults without leaving residual reconnect state", async () => {
    await closeRuntime(runtime);

    runtime = createFleetPlatformRuntime({
      config: {
        host: "127.0.0.1",
        port: 0,
        demoMode: true,
        demoAdminToken: "local-demo-token",
        demoRobotId: "robot-a",
        corsAllowOrigin: "*",
        defaultCommandTtlMs: 10_000,
        telemetryFreshnessSweepMs: 50
      },
      logger: new SilentStructuredLogger()
    });
    await listenFleetPlatform(runtime);
    const address = runtime.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const headers = { "X-Demo-Admin-Token": "local-demo-token" };
    const start = await postJson(
      `${baseUrl}/demo/scenarios/incident/start`,
      {},
      headers
    );
    expect(start.status).toBe(202);

    const stale = await postJson(`${baseUrl}/demo/faults/disconnect`, {}, headers);
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({
      result: {
        status: "UPDATED",
        robot: { connectionState: "DEGRADED" }
      }
    });

    const reconnect = await postJson(`${baseUrl}/demo/faults/reconnect`, {}, headers);
    expect(reconnect.status).toBe(200);
    expect(reconnect.body).toMatchObject({
      result: {
        status: "PROCESSED",
        reconciliation: { outcome: "RESUME_RUNNING" },
        mission: {
          lifecycleState: "RUNNING",
          operationalStatus: "RECOVERED"
        }
      }
    });

    const robotAfterReconnect = await fetch(`${baseUrl}/robots/robot-a`);
    const robotAfterReconnectBody = (await robotAfterReconnect.json()) as {
      readonly robot: { readonly connectionState: string };
    };
    expect(robotAfterReconnectBody.robot.connectionState).toBe("ONLINE");

    const reset = await postJson(`${baseUrl}/demo/scenarios/reset`, {}, headers);
    expect(reset.status).toBe(200);

    const noActiveMissionReconnect = await postJson(
      `${baseUrl}/demo/faults/reconnect`,
      {},
      headers
    );
    expect(noActiveMissionReconnect.status).toBe(200);
    expect(noActiveMissionReconnect.body).toEqual({
      result: { status: "NO_ACTIVE_MISSION" }
    });

    const robotAfterNoopReconnect = await fetch(`${baseUrl}/robots/robot-a`);
    const robotAfterNoopReconnectBody = (await robotAfterNoopReconnect.json()) as {
      readonly robot: { readonly connectionState: string };
    };
    expect(robotAfterNoopReconnectBody.robot.connectionState).toBe("ONLINE");
  });

  it("periodically marks robots degraded when telemetry becomes stale", async () => {
    await closeRuntime(runtime);

    const staleTimestamp = new Date(Date.now() - 11_000).toISOString();
    runtime = createFleetPlatformRuntime({
      config: {
        host: "127.0.0.1",
        port: 0,
        demoMode: false,
        demoRobotId: "robot-a",
        corsAllowOrigin: "*",
        defaultCommandTtlMs: 10_000,
        telemetryFreshnessSweepMs: 20
      },
      initialState: createSeededDomainState("robot-a", staleTimestamp),
      logger: new SilentStructuredLogger()
    });
    await listenFleetPlatform(runtime);
    const address = runtime.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    edgeUrl = `ws://127.0.0.1:${address.port}/edge/connect?robotId=robot-a`;

    await eventually(async () => {
      const robotResponse = await fetch(`${baseUrl}/robots/robot-a`);
      const robotBody = (await robotResponse.json()) as {
        readonly robot: { readonly connectionState: string };
      };
      expect(robotBody.robot.connectionState).toBe("DEGRADED");
    });
  });
});

/** Starts a browser-compatible WebSocket using Node's built-in WebSocket client. */
async function openWebSocket(url: string): Promise<TestWebSocket> {
  const WebSocketCtor = (
    globalThis as unknown as {
      readonly WebSocket?: new (url: string) => TestWebSocket;
    }
  ).WebSocket;
  if (!WebSocketCtor) {
    throw new Error("global WebSocket is not available in this Node runtime");
  }

  const socket = new WebSocketCtor(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket error")), {
      once: true
    });
  });
  return socket;
}

/** Reads WebSocket JSON messages until the requested message type arrives. */
async function nextWebSocketMessageOfType(
  socket: TestWebSocket,
  type: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${type}`));
    }, 2_000);

    const onMessage = (event: { readonly data?: unknown }) => {
      const parsed = parseSocketJson(event.data);
      if (parsed["type"] !== type) {
        return;
      }
      cleanup();
      resolve(parsed);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
    };

    socket.addEventListener("message", onMessage);
  });
}

/** Collects WebSocket JSON messages for a short observation window. */
async function collectWebSocketMessages(
  socket: TestWebSocket,
  milliseconds: number
): Promise<readonly Record<string, unknown>[]> {
  const messages: Record<string, unknown>[] = [];
  const onMessage = (event: { readonly data?: unknown }) => {
    messages.push(parseSocketJson(event.data));
  };

  socket.addEventListener("message", onMessage);
  await delay(milliseconds);
  socket.removeEventListener("message", onMessage);
  return messages;
}

/** Converts browser or Node WebSocket event data into a JSON object. */
function parseSocketJson(data: unknown): Record<string, unknown> {
  const text =
    typeof data === "string"
      ? data
      : Buffer.isBuffer(data)
        ? data.toString("utf8")
        : String(data);
  return JSON.parse(text) as Record<string, unknown>;
}

/** Posts JSON and returns both status and parsed JSON body. */
async function postJson(
  url: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = {}
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

/** Retries an async assertion briefly while socket and HTTP updates settle. */
async function eventually(assertion: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await delay(25);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("eventually failed");
}

/** Reads a streaming response until the expected fragment appears. */
async function readStreamUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  fragment: string
): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + 2_000;
  let text = "";

  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      delay(250).then(() => undefined)
    ]);
    if (!result) {
      continue;
    }
    if (result.done) {
      break;
    }
    text += decoder.decode(result.value, { stream: true });
    if (text.includes(fragment)) {
      return text;
    }
  }

  throw new Error(`timed out waiting for stream fragment ${fragment}`);
}

/** Closes the test HTTP server. */
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

/** Promise-based timeout helper for polling tests. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
