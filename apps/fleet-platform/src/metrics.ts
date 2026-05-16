import { MetricsRegistry } from "@roboops/observability";

/** Fleet Platform metric recording surface shared by server, service, and gateway code. */
export interface FleetPlatformMetrics {
  readonly registry: MetricsRegistry;
  recordHttpRequest(input: {
    readonly method: string | undefined;
    readonly route: string;
    readonly statusCode: number;
  }): void;
  recordReadinessFailure(input: {
    readonly persistenceMode: string;
    readonly check: string;
    readonly errorType: string;
  }): void;
  recordDomainEvent(eventType: string): void;
  recordAuditEvent(action: string): void;
  recordEdgeConnection(change: "opened" | "closed"): void;
  recordEdgeMessageReceived(messageType: string): void;
  recordEdgeMessageSent(messageType: string): void;
  recordTelemetryFreshnessDegradation(input: {
    readonly previousConnectionState: string;
    readonly connectionState: string;
  }): void;
}

/** Creates the small in-process metrics set exposed by the local Fleet Platform API. */
export function createFleetPlatformMetrics(
  registry = new MetricsRegistry()
): FleetPlatformMetrics {
  const httpRequests = registry.counter({
    name: "roboops_fleet_platform_http_requests_total",
    help: "HTTP requests handled by Fleet Platform.",
    labelNames: ["method", "route", "status_class"]
  });
  const readinessFailures = registry.counter({
    name: "roboops_fleet_platform_readiness_failures_total",
    help: "Readiness checks that failed with a sanitized error type.",
    labelNames: ["persistence_mode", "check", "error_type"]
  });
  const domainEvents = registry.counter({
    name: "roboops_fleet_platform_domain_events_total",
    help: "Reducer-produced domain events emitted by Fleet Platform.",
    labelNames: ["event_type"]
  });
  const auditEvents = registry.counter({
    name: "roboops_fleet_platform_audit_events_total",
    help: "Reducer-produced audit events emitted by Fleet Platform.",
    labelNames: ["action"]
  });
  const edgeConnections = registry.counter({
    name: "roboops_fleet_platform_edge_websocket_connections_total",
    help: "Edge WebSocket connection lifecycle changes.",
    labelNames: ["change"]
  });
  const edgeMessagesReceived = registry.counter({
    name: "roboops_fleet_platform_edge_messages_received_total",
    help: "Validated edge WebSocket messages received by type.",
    labelNames: ["message_type"]
  });
  const edgeMessagesSent = registry.counter({
    name: "roboops_fleet_platform_edge_messages_sent_total",
    help: "Platform WebSocket messages sent to edge runtimes by type.",
    labelNames: ["message_type"]
  });
  const freshnessDegradations = registry.counter({
    name: "roboops_fleet_platform_telemetry_freshness_degradations_total",
    help: "Telemetry freshness evaluations that degraded robot connection state.",
    labelNames: ["previous_state", "connection_state"]
  });

  return {
    registry,
    recordHttpRequest(input): void {
      httpRequests.increment({
        method: normalizeHttpMethod(input.method),
        route: input.route,
        status_class: statusClass(input.statusCode)
      });
    },
    recordReadinessFailure(input): void {
      readinessFailures.increment({
        persistence_mode: input.persistenceMode,
        check: input.check,
        error_type: input.errorType
      });
    },
    recordDomainEvent(eventType): void {
      domainEvents.increment({ event_type: eventType });
    },
    recordAuditEvent(action): void {
      auditEvents.increment({ action });
    },
    recordEdgeConnection(change): void {
      edgeConnections.increment({ change });
    },
    recordEdgeMessageReceived(messageType): void {
      edgeMessagesReceived.increment({ message_type: messageType });
    },
    recordEdgeMessageSent(messageType): void {
      edgeMessagesSent.increment({ message_type: messageType });
    },
    recordTelemetryFreshnessDegradation(input): void {
      freshnessDegradations.increment({
        previous_state: input.previousConnectionState,
        connection_state: input.connectionState
      });
    }
  };
}

/** Converts concrete request paths into bounded Prometheus route labels. */
export function routeLabelForRequest(
  method: string | undefined,
  pathname: string | undefined
): string {
  if (method === "OPTIONS") {
    return "OPTIONS";
  }
  if (!pathname) {
    return "UNKNOWN";
  }
  if (pathname === "/health/live") {
    return "/health/live";
  }
  if (pathname === "/health/ready") {
    return "/health/ready";
  }
  if (pathname === "/metrics") {
    return "/metrics";
  }
  if (pathname === "/stream/events") {
    return "/stream/events";
  }
  if (pathname === "/missions") {
    return "/missions";
  }
  if (/^\/missions\/[^/]+$/.test(pathname)) {
    return "/missions/:missionId";
  }
  if (/^\/missions\/[^/]+\/cancel$/.test(pathname)) {
    return "/missions/:missionId/cancel";
  }
  if (pathname === "/robots") {
    return "/robots";
  }
  if (/^\/robots\/[^/]+$/.test(pathname)) {
    return "/robots/:robotId";
  }
  if (pathname === "/events") {
    return "/events";
  }
  if (pathname === "/audit-events") {
    return "/audit-events";
  }
  if (pathname === "/edge/connect") {
    return "/edge/connect";
  }
  if (pathname.startsWith("/demo/")) {
    return "/demo/*";
  }
  return "NOT_FOUND";
}

/** Groups response status codes into low-cardinality Prometheus labels. */
function statusClass(statusCode: number): string {
  if (statusCode >= 100 && statusCode <= 599) {
    return `${Math.trunc(statusCode / 100)}xx`;
  }
  return "unknown";
}

/** Keeps odd or missing methods from creating unbounded metric label values. */
function normalizeHttpMethod(method: string | undefined): string {
  if (
    method === "GET" ||
    method === "POST" ||
    method === "OPTIONS" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE"
  ) {
    return method;
  }
  return "OTHER";
}
