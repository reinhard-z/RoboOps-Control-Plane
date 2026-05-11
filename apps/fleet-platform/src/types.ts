import type { IncomingHttpHeaders } from "node:http";

import type {
  CommandAckV1,
  CommandEnvelopeV1,
  CommandPayload,
  CommandType,
  ReconnectHandshakeV1,
  RobotTelemetryEventV1,
  SafetyClass
} from "@roboops/fleet-protocol";

/** Runtime configuration for the Phase 2 Fleet Platform process. */
export interface FleetPlatformConfig {
  readonly host: string;
  readonly port: number;
  readonly demoMode: boolean;
  readonly demoAdminToken?: string;
  readonly demoRobotId: string;
  readonly corsAllowOrigin: string;
  readonly defaultCommandTtlMs: number;
  readonly telemetryFreshnessSweepMs: number;
}

/** Per-request context propagated into domain commands, logs, and responses. */
export interface RequestContext {
  readonly correlationId: string;
  readonly causationId: string;
  readonly now: string;
  readonly headers?: IncomingHttpHeaders;
}

/** Operator request body for creating a mission command. */
export interface CreateMissionRequest {
  readonly robotId: string;
  readonly type: CommandType;
  readonly payload: CommandPayload;
  readonly missionId?: string;
  readonly commandId?: string;
  readonly idempotencyKey?: string;
  readonly expiresInMs?: number;
  readonly requiresAck?: boolean;
  readonly safetyClass?: SafetyClass;
}

/** Operator request body for asking the edge to cancel a mission. */
export interface CancelMissionRequest {
  readonly reason: string;
  readonly commandId?: string;
  readonly idempotencyKey?: string;
  readonly expiresInMs?: number;
}

/** Lightweight edge session metadata sent when the edge socket opens. */
export interface EdgeHelloPayload {
  readonly edgeSessionId?: string;
  readonly edgeAgentVersion?: string;
  readonly lastSeenCommandSequence?: number;
}

/** Messages accepted from an edge runtime over the outbound WebSocket channel. */
export type EdgeWireMessage =
  | { readonly type: "edge.hello"; readonly payload: EdgeHelloPayload }
  | { readonly type: "edge.telemetry"; readonly payload: RobotTelemetryEventV1 }
  | { readonly type: "edge.command_ack"; readonly payload: CommandAckV1 }
  | {
      readonly type: "edge.reconnect_handshake";
      readonly payload: ReconnectHandshakeV1;
    };

/** Messages the platform sends to an edge runtime over the WebSocket channel. */
export type PlatformWireMessage =
  | { readonly type: "platform.command"; readonly payload: CommandEnvelopeV1 }
  | { readonly type: "platform.ping"; readonly payload: { readonly sentAt: string } }
  | {
      readonly type: "platform.error";
      readonly payload: {
        readonly code: string;
        readonly message: string;
        readonly correlationId?: string;
      };
    };

/** Standard structured error body returned by every HTTP handler. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly correlationId: string;
    readonly details?: unknown;
  };
}

/** Validation issue shape shared by HTTP and WebSocket parsing. */
export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** Small result type used by request and edge-message validators. */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };
