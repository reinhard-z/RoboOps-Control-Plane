import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import type { CommandEnvelopeV1, RobotId } from "@roboops/fleet-protocol";
import { classifyErrorType } from "@roboops/observability";
import WebSocket, { type RawData, WebSocketServer } from "ws";

import { createPlatformId, nowIso } from "./ids.js";
import type { StructuredLogger } from "./logging.js";
import type { FleetPlatformMetrics } from "./metrics.js";
import type { FleetPlatformService } from "./service.js";
import type { EdgeWireMessage, PlatformWireMessage, RequestContext } from "./types.js";
import { parseEdgeWireMessage } from "./validation.js";

const maxMessageBytes = 1024 * 1024;
const shutdownCloseCode = 1001;

/** Small wrapper around one edge WebSocket so gateway logic does not depend on ws events. */
class WebSocketPeer {
  private notifiedClosed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly onTextMessage: (message: string) => void,
    private readonly onClosed: () => void
  ) {
    this.socket.on("message", (data, isBinary) => this.receiveMessage(data, isBinary));
    this.socket.on("close", () => this.markClosed());
    this.socket.on("error", () => this.markClosed());
  }

  /** Sends one JSON platform message when the socket is still open. */
  sendJson(message: PlatformWireMessage): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  /** Closes the underlying socket and immediately runs gateway cleanup once. */
  close(): void {
    if (
      this.socket.readyState !== WebSocket.CLOSED &&
      this.socket.readyState !== WebSocket.CLOSING
    ) {
      this.socket.close(shutdownCloseCode, "fleet platform shutdown");
    }
    this.notifyClosed();
  }

  /** Converts text WebSocket payloads into strings before protocol validation. */
  private receiveMessage(data: RawData, isBinary: boolean): void {
    const message = textMessageFromRawData(data, isBinary);
    if (message !== undefined) {
      this.onTextMessage(message);
    }
  }

  /** Ensures the close callback runs only once regardless of socket event order. */
  private markClosed(): void {
    this.notifyClosed();
  }

  /** Runs the gateway close hook once even when several socket events fire. */
  private notifyClosed(): void {
    if (this.notifiedClosed) {
      return;
    }
    this.notifiedClosed = true;
    this.onClosed();
  }
}

/** Accepts edge WebSocket upgrades and routes edge messages into FleetPlatformService. */
export class EdgeWebSocketGateway {
  private readonly connectionsByRobot = new Map<RobotId, Set<WebSocketPeer>>();
  private readonly processingByRobot = new Map<RobotId, Promise<void>>();
  private readonly websocketServer = new WebSocketServer({
    maxPayload: maxMessageBytes,
    noServer: true
  });
  private closing = false;

  constructor(
    private readonly service: FleetPlatformService,
    private readonly logger: StructuredLogger,
    private readonly metrics: FleetPlatformMetrics
  ) {}

  /** Accepts only the edge WebSocket route and lets ws perform the protocol upgrade. */
  handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): boolean {
    const url = parseRequestUrl(request);
    if (!url || url.pathname !== "/edge/connect") {
      return false;
    }

    if (this.closing) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return true;
    }

    const robotId = url.searchParams.get("robotId");
    const key = request.headers["sec-websocket-key"];
    if (!robotId || typeof key !== "string") {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return true;
    }

    try {
      this.websocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.acceptPeer(robotId, webSocket);
      });
    } catch (error: unknown) {
      this.logger.warn("edge websocket upgrade failed", {
        robotId,
        errorType: classifyErrorType(error)
      });
      socket.destroy();
    }
    return true;
  }

  /** Registers an upgraded edge socket after ws has completed the handshake. */
  private acceptPeer(robotId: RobotId, webSocket: WebSocket): void {
    let peer: WebSocketPeer;
    peer = new WebSocketPeer(
      webSocket,
      (message) => {
        this.enqueueRobotTask(robotId, peer, () =>
          this.handlePeerMessage(robotId, peer, message)
        );
      },
      () => this.removePeer(robotId, peer)
    );
    this.addPeer(robotId, peer);

    this.logger.info("edge websocket connected", { robotId });
    this.metrics.recordEdgeConnection("opened");
  }

  /** Sends one queued platform command to every open socket for the command robot. */
  sendCommand(command: CommandEnvelopeV1): number {
    return this.sendPlatformMessage(command.robotId, {
      type: "platform.command",
      payload: command
    });
  }

  /** Sends a typed platform message to all currently connected peers for one robot. */
  sendPlatformMessage(robotId: RobotId, message: PlatformWireMessage): number {
    if (this.closing) {
      return 0;
    }

    const peers = this.connectionsByRobot.get(robotId);
    if (!peers || peers.size === 0) {
      this.logger.warn("edge websocket message dropped with no connected peers", {
        robotId,
        messageType: message.type
      });
      return 0;
    }

    for (const peer of peers) {
      peer.sendJson(message);
    }
    this.metrics.recordEdgeMessageSent(message.type);
    this.logger.info("edge websocket message sent", {
      robotId,
      messageType: message.type,
      peerCount: peers.size
    });
    return peers.size;
  }

  /** Stops accepting upgrades, closes all peers, and waits for in-flight handlers. */
  async closeAll(): Promise<void> {
    this.closing = true;
    const pendingTasks = [...this.processingByRobot.values()];
    const peersToClose = [...this.connectionsByRobot.values()].flatMap((peers) => {
      return [...peers];
    });
    for (const peer of peersToClose) {
      peer.close();
    }
    this.connectionsByRobot.clear();
    this.websocketServer.close();
    await Promise.allSettled(pendingTasks);
    this.processingByRobot.clear();
  }

  /** Adds a new peer to the robot connection set. */
  private addPeer(robotId: RobotId, peer: WebSocketPeer): void {
    const peers = this.connectionsByRobot.get(robotId) ?? new Set<WebSocketPeer>();
    peers.add(peer);
    this.connectionsByRobot.set(robotId, peers);
  }

  /** Removes a peer and starts reconnect handling when the last socket drops. */
  private removePeer(robotId: RobotId, peer: WebSocketPeer): void {
    const peers = this.connectionsByRobot.get(robotId);
    if (!peers) {
      return;
    }

    peers.delete(peer);
    this.metrics.recordEdgeConnection("closed");
    if (peers.size > 0) {
      return;
    }

    this.connectionsByRobot.delete(robotId);
    if (this.closing) {
      return;
    }

    const context = {
      correlationId: createPlatformId("corr_edge_disconnect"),
      causationId: createPlatformId("edge_disconnect"),
      now: nowIso()
    };
    this.enqueueRobotTask(robotId, undefined, async () => {
      await this.service.handleEdgeDisconnected(robotId, context);
      this.logger.warn("edge websocket disconnected", { robotId });
    });
  }

  /** Serializes async state changes per robot so edge frames keep wire order. */
  private enqueueRobotTask(
    robotId: RobotId,
    peer: WebSocketPeer | undefined,
    task: () => Promise<void>
  ): void {
    if (this.closing) {
      return;
    }

    const previous = this.processingByRobot.get(robotId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .catch((error: unknown) => {
        this.logger.error("edge websocket task failed", {
          robotId,
          errorType: classifyErrorType(error)
        });
        if (peer) {
          this.metrics.recordEdgeMessageSent("platform.error");
        }
        peer?.sendJson({
          type: "platform.error",
          payload: {
            code: "EDGE_MESSAGE_INTERNAL_ERROR",
            message: "edge message handling failed"
          }
        });
      });

    this.processingByRobot.set(robotId, next);
    void next.finally(() => {
      if (this.processingByRobot.get(robotId) === next) {
        this.processingByRobot.delete(robotId);
      }
    });
  }

  /** Parses one edge JSON message and forwards valid protocol payloads to the service. */
  private async handlePeerMessage(
    robotId: RobotId,
    peer: WebSocketPeer,
    messageText: string
  ): Promise<void> {
    const parsedJson = parseJson(messageText);
    if (!parsedJson.ok) {
      this.metrics.recordEdgeMessageSent("platform.error");
      peer.sendJson({
        type: "platform.error",
        payload: { code: "EDGE_MESSAGE_INVALID_JSON", message: parsedJson.message }
      });
      return;
    }

    const parsedMessage = parseEdgeWireMessage(parsedJson.value);
    if (!parsedMessage.ok) {
      this.metrics.recordEdgeMessageSent("platform.error");
      peer.sendJson({
        type: "platform.error",
        payload: {
          code: "EDGE_MESSAGE_VALIDATION_FAILED",
          message: "edge message validation failed"
        }
      });
      return;
    }

    if (!messageMatchesRobot(robotId, parsedMessage.value)) {
      this.metrics.recordEdgeMessageSent("platform.error");
      peer.sendJson({
        type: "platform.error",
        payload: {
          code: "EDGE_ROBOT_MISMATCH",
          message: "edge message robotId does not match the connected robot"
        }
      });
      return;
    }

    this.metrics.recordEdgeMessageReceived(parsedMessage.value.type);
    await this.service.handleEdgeMessage(
      robotId,
      parsedMessage.value,
      createEdgeContextFromMessage(parsedMessage.value)
    );
  }
}

/** Decodes non-binary ws payloads into the JSON text expected from edge runtimes. */
function textMessageFromRawData(data: RawData, isBinary: boolean): string | undefined {
  if (isBinary) {
    return undefined;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

/** Parses the incoming request URL without trusting the Host header for routing. */
function parseRequestUrl(request: IncomingMessage): URL | undefined {
  if (!request.url) {
    return undefined;
  }
  return new URL(request.url, "http://localhost");
}

/** Parses JSON into an unknown value without throwing through socket handlers. */
function parseJson(text: string):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, message: "message must be valid JSON" };
  }
}

/** Ensures edge payload robot ids cannot cross socket identity boundaries. */
function messageMatchesRobot(robotId: RobotId, message: EdgeWireMessage): boolean {
  if (message.type === "edge.hello") {
    return true;
  }
  return message.payload.robotId === robotId;
}

/** Creates request context from an edge protocol message where possible. */
function createEdgeContextFromMessage(message: EdgeWireMessage): RequestContext {
  if (message.type === "edge.command_ack") {
    return {
      correlationId: message.payload.correlationId,
      causationId: message.payload.ackId,
      now: message.payload.receivedAt
    };
  }
  if (message.type === "edge.telemetry") {
    return {
      correlationId: `corr_${message.payload.eventId}`,
      causationId: message.payload.eventId,
      now: message.payload.receivedAt
    };
  }
  if (message.type === "edge.reconnect_handshake") {
    return {
      correlationId: createPlatformId("corr_reconnect"),
      causationId: message.payload.edgeSessionId,
      now: message.payload.connectedAt
    };
  }
  return {
    correlationId: createPlatformId("corr_edge"),
    causationId: message.payload.edgeSessionId ?? createPlatformId("edge_hello"),
    now: nowIso()
  };
}
