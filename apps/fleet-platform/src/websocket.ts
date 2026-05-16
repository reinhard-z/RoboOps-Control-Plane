import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import type { CommandEnvelopeV1, RobotId } from "@roboops/fleet-protocol";

import { createPlatformId, nowIso } from "./ids.js";
import type { StructuredLogger } from "./logging.js";
import type { FleetPlatformService } from "./service.js";
import type { EdgeWireMessage, PlatformWireMessage, RequestContext } from "./types.js";
import { parseEdgeWireMessage } from "./validation.js";

const webSocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const maxFrameBytes = 1024 * 1024;

/** Minimal WebSocket peer that supports JSON text frames for the edge gateway. */
class WebSocketPeer {
  private buffer = Buffer.alloc(0);
  private closed = false;
  private notifiedClosed = false;

  constructor(
    private readonly socket: Socket,
    private readonly onTextMessage: (message: string) => void,
    private readonly onClosed: () => void
  ) {
    this.socket.on("data", (chunk) => this.receiveData(chunk));
    this.socket.on("close", () => this.markClosed());
    this.socket.on("error", () => this.markClosed());
  }

  sendJson(message: PlatformWireMessage): void {
    this.sendText(JSON.stringify(message));
  }

  sendText(message: string): void {
    if (this.closed) {
      return;
    }
    this.socket.write(encodeServerTextFrame(message));
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.end(Buffer.from([0x88, 0x00]));
    this.notifyClosed();
  }

  receiveInitialBytes(head: Buffer): void {
    if (head.length > 0) {
      this.receiveData(head);
    }
  }

  /** Parses all complete frames currently buffered from the TCP socket. */
  private receiveData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length > 0) {
      const parsed = tryParseClientFrame(this.buffer);
      if (parsed.status === "incomplete") {
        return;
      }
      if (parsed.status === "invalid") {
        this.close();
        return;
      }

      this.buffer = this.buffer.subarray(parsed.frameBytes);
      if (parsed.opcode === 0x8) {
        this.close();
        return;
      }
      if (parsed.opcode === 0x9) {
        this.socket.write(encodeControlFrame(0xA, parsed.payload));
        continue;
      }
      if (parsed.opcode === 0x1) {
        this.onTextMessage(parsed.payload.toString("utf8"));
      }
    }
  }

  /** Ensures the close callback runs only once regardless of socket event order. */
  private markClosed(): void {
    if (this.closed) {
      this.notifyClosed();
      return;
    }
    this.closed = true;
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
  private closing = false;

  constructor(
    private readonly service: FleetPlatformService,
    private readonly logger: StructuredLogger
  ) {}

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

    socket.write(createUpgradeResponse(key));
    let peer: WebSocketPeer;
    peer = new WebSocketPeer(
      socket,
      (message) => {
        this.enqueueRobotTask(robotId, peer, () =>
          this.handlePeerMessage(robotId, peer, message)
        );
      },
      () => this.removePeer(robotId, peer)
    );
    this.addPeer(robotId, peer);
    peer.receiveInitialBytes(head);

    this.logger.info("edge websocket connected", { robotId });
    return true;
  }

  sendCommand(command: CommandEnvelopeV1): number {
    return this.sendPlatformMessage(command.robotId, {
      type: "platform.command",
      payload: command
    });
  }

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
    this.logger.info("edge websocket message sent", {
      robotId,
      messageType: message.type,
      peerCount: peers.size
    });
    return peers.size;
  }

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
          error: error instanceof Error ? error.message : String(error)
        });
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
      peer.sendJson({
        type: "platform.error",
        payload: { code: "EDGE_MESSAGE_INVALID_JSON", message: parsedJson.message }
      });
      return;
    }

    const parsedMessage = parseEdgeWireMessage(parsedJson.value);
    if (!parsedMessage.ok) {
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
      peer.sendJson({
        type: "platform.error",
        payload: {
          code: "EDGE_ROBOT_MISMATCH",
          message: "edge message robotId does not match the connected robot"
        }
      });
      return;
    }

    await this.service.handleEdgeMessage(
      robotId,
      parsedMessage.value,
      createEdgeContextFromMessage(parsedMessage.value)
    );
  }
}

/** Creates the HTTP 101 response for a WebSocket upgrade. */
function createUpgradeResponse(key: string): string {
  const accept = createHash("sha1")
    .update(`${key}${webSocketGuid}`)
    .digest("base64");
  return [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n"
  ].join("\r\n");
}

/** Encodes a server-to-client text frame; server frames are intentionally unmasked. */
function encodeServerTextFrame(message: string): Buffer {
  return encodeControlFrame(0x1, Buffer.from(message, "utf8"));
}

/** Encodes a single unmasked server frame for text, pong, or close responses. */
function encodeControlFrame(opcode: number, payload: Buffer): Buffer {
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
  }

  if (payload.length <= 65_535) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

type ParsedFrame =
  | { readonly status: "incomplete" }
  | { readonly status: "invalid" }
  | {
      readonly status: "complete";
      readonly opcode: number;
      readonly payload: Buffer;
      readonly frameBytes: number;
    };

/** Parses one complete masked client frame when enough bytes are available. */
function tryParseClientFrame(buffer: Buffer): ParsedFrame {
  if (buffer.length < 2) {
    return { status: "incomplete" };
  }

  const firstByte = buffer[0]!;
  const secondByte = buffer[1]!;
  const opcode = firstByte & 0x0f;
  const masked = (secondByte & 0x80) === 0x80;
  let payloadLength = secondByte & 0x7f;
  let offset = 2;

  if (!masked) {
    return { status: "invalid" };
  }

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) {
      return { status: "incomplete" };
    }
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) {
      return { status: "incomplete" };
    }
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      return { status: "invalid" };
    }
    payloadLength = Number(bigLength);
    offset += 8;
  }

  if (payloadLength > maxFrameBytes) {
    return { status: "invalid" };
  }

  const maskOffset = offset;
  const payloadOffset = maskOffset + 4;
  const frameBytes = payloadOffset + payloadLength;
  if (buffer.length < frameBytes) {
    return { status: "incomplete" };
  }

  const mask = buffer.subarray(maskOffset, payloadOffset);
  const payload = Buffer.from(buffer.subarray(payloadOffset, frameBytes));
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = payload[index]! ^ mask[index % 4]!;
  }

  return { status: "complete", opcode, payload, frameBytes };
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
