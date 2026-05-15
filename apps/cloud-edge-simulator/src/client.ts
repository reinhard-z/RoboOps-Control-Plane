import { createEdgeConnectUrl } from "./config.js";
import {
  createHelloMessage,
  createInitialSimulatorState,
  createReconnectHandshakeMessage,
  createTelemetryMessage,
  handlePlatformMessage,
  parsePlatformMessage
} from "./messages.js";
import type {
  CloudEdgeSimulatorConfig,
  SimulatorAction,
  SimulatorEdgeMessage,
  SimulatorState,
  SimulatorStep
} from "./types.js";

interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { readonly data?: unknown }) => void,
    options?: { readonly once?: boolean }
  ): void;
}

type WebSocketConstructor = new (url: string) => WebSocketLike;
type LogSink = (
  level: "info" | "warn" | "error",
  message: string,
  fields?: Record<string, unknown>
) => void;

const webSocketOpenState = 1;

/** Running simulator process with an explicit stop hook for CLI signal handling and tests. */
export interface CloudEdgeSimulatorRuntime {
  stop(): void;
}

/** Optional runtime seams used by tests without changing production behavior. */
export interface CloudEdgeSimulatorRuntimeOptions {
  readonly webSocketConstructor?: WebSocketConstructor;
  readonly logger?: LogSink;
}

/** Starts the local edge simulator and keeps reconnecting until stopped. */
export function runCloudEdgeSimulator(
  config: CloudEdgeSimulatorConfig,
  options: CloudEdgeSimulatorRuntimeOptions = {}
): CloudEdgeSimulatorRuntime {
  const WebSocketCtor = options.webSocketConstructor ?? readWebSocketConstructor();
  const emitLog = options.logger ?? log;
  const url = createEdgeConnectUrl(config);
  let state = createInitialSimulatorState(config);
  let socket: WebSocketLike | undefined;
  let stopped = false;
  let telemetryTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let scenarioReconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (stopped) {
      return;
    }

    emitLog("info", "connecting to fleet platform", {
      url,
      robotId: config.robotId,
      scenario: config.scenario
    });
    socket = new WebSocketCtor(url);
    socket.addEventListener("open", () => {
      if (
        config.scenario === "reconnect" &&
        !state.reconnectHandshakeSent &&
        state.currentMissionId
      ) {
        const reconnectStep = createReconnectHandshakeMessage(state);
        state = reconnectStep.state;
        sendMessage(createHelloMessage(state));
        for (const message of reconnectStep.outbound) {
          sendMessage(message);
        }
        for (const action of reconnectStep.actions) {
          applyAction(action);
        }
      } else {
        sendMessage(createHelloMessage(state));
        if (shouldStartTelemetryOnOpen()) {
          startTelemetry();
        }
      }
      emitLog("info", "edge websocket connected", { robotId: config.robotId });
    });
    socket.addEventListener("message", (event) => {
      handleSocketMessage(event.data);
    });
    socket.addEventListener("error", () => {
      emitLog("warn", "edge websocket error", { robotId: config.robotId });
      stopTelemetry();
      socket = undefined;
      scheduleReconnect();
    });
    socket.addEventListener("close", () => {
      stopTelemetry();
      socket = undefined;
      if (!stopped) {
        scheduleReconnect();
      }
    });
  };

  const handleSocketMessage = (data: unknown) => {
    const parsedJson = parseSocketJson(data);
    if (!parsedJson.ok) {
      emitLog("warn", "ignoring invalid platform json", {
        reason: parsedJson.reason
      });
      return;
    }

    const parsedMessage = parsePlatformMessage(parsedJson.value);
    if (!parsedMessage.ok) {
      emitLog("warn", "ignoring invalid platform message", {
        reason: parsedMessage.reason
      });
      return;
    }

    applyStep(handlePlatformMessage(state, parsedMessage.value));
  };

  const applyStep = (step: SimulatorStep) => {
    state = step.state;
    for (const message of step.outbound) {
      sendMessage(message);
    }
    for (const action of step.actions) {
      applyAction(action);
    }
  };

  const applyAction = (action: SimulatorAction) => {
    if (action.kind === "start_telemetry") {
      startTelemetry();
      return;
    }
    if (action.kind === "stop_telemetry") {
      stopTelemetry();
      return;
    }
    if (action.kind === "disconnect_for_reconnect") {
      scheduleScenarioReconnect();
      return;
    }
    if (action.message) {
      emitLog("info", action.message, { robotId: config.robotId });
    }
  };

  const startTelemetry = () => {
    if (telemetryTimer) {
      return;
    }
    applyStep(createTelemetryMessage(state));
    telemetryTimer = setInterval(() => {
      applyStep(createTelemetryMessage(state));
    }, config.heartbeatIntervalMs);
    unrefTimer(telemetryTimer);
  };

  const shouldStartTelemetryOnOpen = () => {
    if (config.scenario === "normal") {
      return true;
    }
    return !state.currentMissionId;
  };

  const stopTelemetry = () => {
    if (!telemetryTimer) {
      return;
    }
    clearInterval(telemetryTimer);
    telemetryTimer = undefined;
  };

  const scheduleScenarioReconnect = () => {
    if (scenarioReconnectTimer) {
      return;
    }
    scenarioReconnectTimer = setTimeout(() => {
      scenarioReconnectTimer = undefined;
      if (socket?.readyState === webSocketOpenState) {
        socket.close();
      }
    }, 50);
    unrefTimer(scenarioReconnectTimer);
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, config.reconnectDelayMs);
  };

  const sendMessage = (message: SimulatorEdgeMessage) => {
    if (!socket || socket.readyState !== webSocketOpenState) {
      emitLog("warn", "edge message dropped because socket is not open", {
        messageType: message.type
      });
      return;
    }
    socket.send(JSON.stringify(message));
  };

  connect();

  return {
    stop(): void {
      stopped = true;
      stopTelemetry();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      if (scenarioReconnectTimer) {
        clearTimeout(scenarioReconnectTimer);
        scenarioReconnectTimer = undefined;
      }
      socket?.close();
    }
  };
}

/** Allows long-running timers to avoid keeping Node alive while preserving fake-timer tests. */
function unrefTimer(
  timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>
): void {
  if (typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }
}

/** Reads Node's built-in WebSocket constructor without requiring DOM TypeScript libs. */
function readWebSocketConstructor(): WebSocketConstructor {
  const WebSocketCtor = (
    globalThis as unknown as { readonly WebSocket?: WebSocketConstructor }
  ).WebSocket;
  if (!WebSocketCtor) {
    throw new Error(
      "global WebSocket is not available; run the simulator on Node 22 or newer"
    );
  }
  return WebSocketCtor;
}

/** Converts browser or Node WebSocket event data into JSON without throwing through handlers. */
function parseSocketJson(data: unknown):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string } {
  const text =
    typeof data === "string"
      ? data
      : Buffer.isBuffer(data)
        ? data.toString("utf8")
        : String(data);
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "message must be valid JSON" };
  }
}

/** Emits structured JSON logs compatible with the other local apps. */
function log(
  level: "info" | "warn" | "error",
  message: string,
  fields: Record<string, unknown> = {}
): void {
  console.log(
    JSON.stringify({
      level,
      message,
      time: new Date().toISOString(),
      ...fields
    })
  );
}
