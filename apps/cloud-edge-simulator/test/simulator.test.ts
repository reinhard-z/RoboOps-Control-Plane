import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type CommandEnvelopeV1,
  commandEnvelopeFixture,
  protocolSchemaVersions
} from "@roboops/fleet-protocol";

import {
  type CloudEdgeSimulatorConfig,
  type CloudEdgeSimulatorRuntimeOptions,
  createEdgeConnectUrl,
  createHelloMessage,
  createInitialSimulatorState,
  createReconnectHandshakeMessage,
  createTelemetryMessage,
  handlePlatformMessage,
  parsePlatformMessage,
  runCloudEdgeSimulator
} from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("cloud edge simulator message handling", () => {
  it("creates the Fleet Platform edge WebSocket URL from HTTP config", () => {
    const config = createConfig({
      fleetPlatformUrl: "http://127.0.0.1:3000/base/path"
    });

    expect(createEdgeConnectUrl(config)).toBe(
      "ws://127.0.0.1:3000/edge/connect?robotId=robot-a"
    );
  });

  it("sends edge hello with session, version, and last seen sequence", () => {
    const state = createInitialSimulatorState(createConfig(), "2026-05-10T12:00:00.000Z");
    const hello = createHelloMessage(state);

    expect(hello).toEqual({
      type: "edge.hello",
      payload: {
        edgeSessionId: state.edgeSessionId,
        edgeAgentVersion: "sim-test",
        lastSeenCommandSequence: 0
      }
    });
  });

  it("acks GO_TO_POSE and starts telemetry in normal mode", () => {
    const state = createInitialSimulatorState(createConfig());
    const command = createGoToPoseCommand();
    const step = handlePlatformMessage(
      state,
      { type: "platform.command", payload: command },
      "2026-05-10T12:00:04.000Z"
    );

    const ack = step.outbound[0];
    expect(ack?.type).toBe("edge.command_ack");
    expect(ack?.payload).toMatchObject({
      schemaVersion: protocolSchemaVersions.commandAck,
      commandId: command.commandId,
      missionId: command.missionId,
      robotId: command.robotId,
      status: "ACCEPTED",
      lastSeenCommandSequence: command.sequence,
      correlationId: command.correlationId,
      causationId: command.commandId
    });
    expect(step.actions).toEqual([{ kind: "start_telemetry" }]);
    expect(step.state.currentMissionId).toBe(command.missionId);

    const heartbeat = createTelemetryMessage(
      step.state,
      "2026-05-10T12:00:05.000Z"
    );
    expect(heartbeat.outbound[0]?.payload).toMatchObject({
      schemaVersion: protocolSchemaVersions.robotTelemetry,
      robotId: command.robotId,
      currentMissionId: command.missionId,
      lastAcknowledgedCommandId: command.commandId,
      lastSeenCommandSequence: command.sequence,
      edgeAgentVersion: "sim-test",
      connectionState: "ONLINE",
      health: "OK"
    });
  });

  it("acks GO_TO_POSE but stops telemetry in stale telemetry mode", () => {
    const state = createInitialSimulatorState(
      createConfig({ scenario: "stale-telemetry" })
    );
    const step = handlePlatformMessage(state, {
      type: "platform.command",
      payload: createGoToPoseCommand()
    });

    expect(step.outbound[0]?.type).toBe("edge.command_ack");
    expect(step.actions).toEqual([{ kind: "stop_telemetry" }]);
  });

  it("acks GO_TO_POSE and prepares reconnect handshake in reconnect mode", () => {
    const state = createInitialSimulatorState(createConfig({ scenario: "reconnect" }));
    const command = createGoToPoseCommand();
    const commandStep = handlePlatformMessage(state, {
      type: "platform.command",
      payload: command
    });

    expect(commandStep.actions).toEqual([
      { kind: "stop_telemetry" },
      { kind: "disconnect_for_reconnect" }
    ]);

    const reconnectStep = createReconnectHandshakeMessage(
      commandStep.state,
      "2026-05-10T12:01:30.000Z"
    );
    expect(reconnectStep.outbound[0]).toMatchObject({
      type: "edge.reconnect_handshake",
      payload: {
        schemaVersion: protocolSchemaVersions.reconnectHandshake,
        robotId: command.robotId,
        lastSeenCommandSequence: command.sequence,
        lastAcknowledgedCommandId: command.commandId,
        reportedMissionId: command.missionId,
        reportedMissionLifecycleState: "RUNNING",
        edgeAgentVersion: "sim-test"
      }
    });
    expect(reconnectStep.actions).toEqual([{ kind: "start_telemetry" }]);
  });

  it("acks CANCEL_MISSION as accepted and clears the active mission", () => {
    const state = createInitialSimulatorState(createConfig());
    const goStep = handlePlatformMessage(state, {
      type: "platform.command",
      payload: createGoToPoseCommand()
    });
    const cancelCommand = createCancelCommand();
    const cancelStep = handlePlatformMessage(goStep.state, {
      type: "platform.command",
      payload: cancelCommand
    });

    expect(cancelStep.outbound[0]?.payload).toMatchObject({
      schemaVersion: protocolSchemaVersions.commandAck,
      commandId: cancelCommand.commandId,
      missionId: cancelCommand.missionId,
      robotId: cancelCommand.robotId,
      status: "ACCEPTED",
      lastSeenCommandSequence: cancelCommand.sequence
    });
    expect(cancelStep.state.currentMissionId).toBeUndefined();
    expect(cancelStep.state.targetPose).toBeUndefined();
  });

  it("rejects unsupported platform commands with an explicit ack", () => {
    const state = createInitialSimulatorState(createConfig());
    const command = createPauseCommand();
    const step = handlePlatformMessage(state, {
      type: "platform.command",
      payload: command
    });

    expect(step.outbound[0]?.payload).toMatchObject({
      schemaVersion: protocolSchemaVersions.commandAck,
      commandId: command.commandId,
      robotId: command.robotId,
      status: "REJECTED",
      reason: "unsupported simulator command type: PAUSE_MISSION"
    });
    expect(step.actions).toEqual([
      { kind: "log", message: "ignoring unsupported command PAUSE_MISSION" }
    ]);

    const heartbeat = createTelemetryMessage(step.state);
    expect(heartbeat.outbound[0]?.payload).toMatchObject({
      robotId: "robot-a",
      lastSeenCommandSequence: command.sequence
    });
  });

  it("rejects commands for a different robot without mutating simulator state", () => {
    const state = createInitialSimulatorState(createConfig());
    const command = createGoToPoseCommand({ robotId: "robot-b" });
    const step = handlePlatformMessage(state, {
      type: "platform.command",
      payload: command
    });

    expect(step.outbound[0]?.payload).toMatchObject({
      schemaVersion: protocolSchemaVersions.commandAck,
      commandId: command.commandId,
      robotId: "robot-b",
      status: "REJECTED",
      reason: "command robotId robot-b does not match simulator robotId robot-a"
    });
    expect(step.state).toBe(state);
    expect(step.actions).toEqual([
      {
        kind: "log",
        message: "rejecting command for robot robot-b on simulator robot robot-a"
      }
    ]);
  });

  it("rejects malformed platform command messages before handling", () => {
    const parsed = parsePlatformMessage({
      type: "platform.command",
      payload: { type: "GO_TO_POSE" }
    });

    expect(parsed.ok).toBe(false);
  });
});

describe("cloud edge simulator runtime", () => {
  it("retries when the first WebSocket connection emits error without close", async () => {
    vi.useFakeTimers();
    const webSockets = createFakeWebSocketRegistry();
    const runtime = runCloudEdgeSimulator(createConfig(), {
      webSocketConstructor: webSockets.constructor,
      logger: noopLogger
    });

    expect(webSockets.instances).toHaveLength(1);
    webSockets.instances[0]?.emit("error");

    await vi.advanceTimersByTimeAsync(100);

    expect(webSockets.instances).toHaveLength(2);
    runtime.stop();
  });

  it("sends hello, idle telemetry, and command ack over the runtime socket", () => {
    vi.useFakeTimers();
    const webSockets = createFakeWebSocketRegistry();
    const runtime = runCloudEdgeSimulator(createConfig(), {
      webSocketConstructor: webSockets.constructor,
      logger: noopLogger
    });
    const socket = readFakeSocket(webSockets, 0);

    socket.emit("open");
    socket.emit("message", platformCommandMessage(createGoToPoseCommand()));

    expect(sentTypes(socket)).toEqual([
      "edge.hello",
      "edge.telemetry",
      "edge.command_ack"
    ]);
    runtime.stop();
  });

  it("disconnects and sends a reconnect handshake in reconnect mode", async () => {
    vi.useFakeTimers();
    const webSockets = createFakeWebSocketRegistry();
    const runtime = runCloudEdgeSimulator(
      createConfig({ scenario: "reconnect", heartbeatIntervalMs: 10_000 }),
      {
        webSocketConstructor: webSockets.constructor,
        logger: noopLogger
      }
    );
    const firstSocket = readFakeSocket(webSockets, 0);

    firstSocket.emit("open");
    firstSocket.emit("message", platformCommandMessage(createGoToPoseCommand()));
    await vi.advanceTimersByTimeAsync(150);

    const secondSocket = readFakeSocket(webSockets, 1);
    secondSocket.emit("open");

    expect(sentTypes(secondSocket)).toEqual([
      "edge.hello",
      "edge.reconnect_handshake",
      "edge.telemetry"
    ]);
    runtime.stop();
  });

  it("clears a pending reconnect fault timer when stopped", () => {
    vi.useFakeTimers();
    const webSockets = createFakeWebSocketRegistry();
    const runtime = runCloudEdgeSimulator(
      createConfig({ scenario: "reconnect", heartbeatIntervalMs: 10_000 }),
      {
        webSocketConstructor: webSockets.constructor,
        logger: noopLogger
      }
    );
    const socket = readFakeSocket(webSockets, 0);

    socket.emit("open");
    socket.emit("message", platformCommandMessage(createGoToPoseCommand()));
    expect(vi.getTimerCount()).toBe(1);

    runtime.stop();

    expect(vi.getTimerCount()).toBe(0);
  });
});

/** Creates a full simulator config with test-friendly defaults. */
function createConfig(
  overrides: Partial<CloudEdgeSimulatorConfig> = {}
): CloudEdgeSimulatorConfig {
  return {
    fleetPlatformUrl: "http://127.0.0.1:4010",
    robotId: "robot-a",
    edgeAgentVersion: "sim-test",
    scenario: "normal",
    heartbeatIntervalMs: 1_000,
    reconnectDelayMs: 100,
    ...overrides
  };
}

/** Returns a valid platform motion command fixture for simulator tests. */
function createGoToPoseCommand(
  overrides: Partial<CommandEnvelopeV1> = {}
): CommandEnvelopeV1 {
  return {
    ...commandEnvelopeFixture,
    robotId: "robot-a",
    ...overrides
  };
}

/** Returns a valid cancel command for the same mission as the motion fixture. */
function createCancelCommand(): CommandEnvelopeV1 {
  return {
    ...commandEnvelopeFixture,
    commandId: "cmd_cancel_test",
    type: "CANCEL_MISSION",
    sequence: commandEnvelopeFixture.sequence + 1,
    payload: { reason: "operator test cancel" }
  };
}

/** Returns an unsupported command the simulator should reject explicitly. */
function createPauseCommand(): CommandEnvelopeV1 {
  return {
    ...commandEnvelopeFixture,
    commandId: "cmd_pause_test",
    type: "PAUSE_MISSION",
    payload: {},
    sequence: commandEnvelopeFixture.sequence + 2
  };
}

interface FakeWebSocketRegistry {
  readonly instances: FakeWebSocket[];
  readonly constructor: NonNullable<
    CloudEdgeSimulatorRuntimeOptions["webSocketConstructor"]
  >;
}

/** Creates a fake WebSocket constructor that records every runtime connection. */
function createFakeWebSocketRegistry(): FakeWebSocketRegistry {
  const instances: FakeWebSocket[] = [];
  const constructor = class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      instances.push(this);
    }
  };

  return { instances, constructor };
}

type FakeWebSocketEventType = "open" | "message" | "error" | "close";

/** Minimal evented WebSocket test double for runtime tests. */
class FakeWebSocket {
  readonly sent: string[] = [];
  readonly url: string;
  readyState = 0;

  private readonly listeners = new Map<
    FakeWebSocketEventType,
    Array<{
      readonly listener: (event: { readonly data?: unknown }) => void;
      readonly once: boolean;
    }>
  >();

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.emit("close");
  }

  addEventListener(
    type: FakeWebSocketEventType,
    listener: (event: { readonly data?: unknown }) => void,
    options?: { readonly once?: boolean }
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, once: options?.once ?? false });
    this.listeners.set(type, listeners);
  }

  /** Emits a WebSocket event to the runtime under test. */
  emit(type: FakeWebSocketEventType, data?: unknown): void {
    if (type === "open") {
      this.readyState = 1;
    }
    if (type === "error") {
      this.readyState = 3;
    }

    const listeners = [...(this.listeners.get(type) ?? [])];
    for (const entry of listeners) {
      entry.listener({ data });
    }
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => !entry.once)
    );
  }
}

/** Reads one fake socket and fails clearly if the runtime did not create it. */
function readFakeSocket(
  registry: FakeWebSocketRegistry,
  index: number
): FakeWebSocket {
  const socket = registry.instances[index];
  if (!socket) {
    throw new Error(`expected fake websocket ${index}`);
  }
  return socket;
}

/** Builds a serialized platform command message for fake socket delivery. */
function platformCommandMessage(command: CommandEnvelopeV1): string {
  return JSON.stringify({
    type: "platform.command",
    payload: command
  });
}

/** Returns the edge message types written to one fake WebSocket. */
function sentTypes(socket: FakeWebSocket): string[] {
  return socket.sent.map((message) => {
    const parsed = JSON.parse(message) as { readonly type: string };
    return parsed.type;
  });
}

/** Test logger that preserves runtime behavior without printing during tests. */
function noopLogger(): void {
  return undefined;
}
