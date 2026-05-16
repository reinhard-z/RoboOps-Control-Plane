import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import type { DomainState } from "@roboops/fleet-domain";
import {
  type DomainStateRepository,
  InMemoryDomainStateRepository,
  PostgresDomainStateRepository
} from "@roboops/fleet-persistence";
import {
  classifyErrorType,
  prometheusTextContentType,
  readCorrelationIdHeader
} from "@roboops/observability";

import { loadFleetPlatformConfig } from "./config.js";
import { PlatformEventHub, type PlatformStreamEvent } from "./event-hub.js";
import { createPlatformId, nowIso } from "./ids.js";
import {
  ConsoleStructuredLogger,
  type StructuredLogger
} from "./logging.js";
import {
  type FleetPlatformMetrics,
  createFleetPlatformMetrics,
  routeLabelForRequest
} from "./metrics.js";
import {
  classifyReadinessError,
  readinessRepositoryReadTimeoutMs,
  repositoryReadinessCheckName,
  runRepositoryReadinessCheck
} from "./readiness.js";
import { createSeededDomainState } from "./repository.js";
import { FleetPlatformService } from "./service.js";
import type {
  ApiErrorBody,
  FleetPlatformConfig,
  RequestContext,
  ValidationIssue
} from "./types.js";
import {
  parseCancelMissionRequest,
  parseCreateMissionRequest
} from "./validation.js";
import { EdgeWebSocketGateway } from "./websocket.js";

/** Constructed Fleet Platform runtime used by CLI startup and integration tests. */
export interface FleetPlatformRuntime {
  readonly server: Server;
  readonly service: FleetPlatformService;
  readonly eventHub: PlatformEventHub;
  readonly edgeGateway: EdgeWebSocketGateway;
  readonly config: FleetPlatformConfig;
  readonly repository: DomainStateRepository;
  readonly metrics: FleetPlatformMetrics;
  stop(): Promise<void>;
}

/** Optional dependency overrides for tests or embedded local demos. */
export interface FleetPlatformRuntimeOptions {
  readonly config?: Partial<FleetPlatformConfig>;
  /** Initial state is intentionally limited to the in-memory adapter used by tests and demos. */
  readonly initialState?: DomainState;
  readonly logger?: StructuredLogger;
  readonly metrics?: FleetPlatformMetrics;
}

/** Creates the HTTP/SSE/WebSocket runtime without binding a TCP port. */
export function createFleetPlatformRuntime(
  options: FleetPlatformRuntimeOptions = {}
): FleetPlatformRuntime {
  const config = normalizeFleetPlatformConfig({
    ...loadRuntimeBaseConfig(options.config),
    ...options.config
  });
  const logger = options.logger ?? new ConsoleStructuredLogger();
  logger.info("fleet platform persistence configured", {
    persistenceMode: config.persistence.mode
  });
  const runtimeRepository = createRuntimeRepository(config, options.initialState);
  const eventHub = new PlatformEventHub();
  const metrics = options.metrics ?? createFleetPlatformMetrics();
  const service = new FleetPlatformService(
    runtimeRepository.repository,
    eventHub,
    logger,
    config,
    metrics
  );
  const edgeGateway = new EdgeWebSocketGateway(service, logger, metrics);
  service.setEdgeTransport(edgeGateway);

  const server = createServer((request, response) => {
    handleHttpRequest(request, response, service, eventHub, config, logger, metrics).catch(
      (error: unknown) => {
        logger.error("unhandled http request error", {
          errorType: classifyErrorType(error)
        });
        sendError(response, config, 500, "INTERNAL_ERROR", "internal server error", {
          correlationId: createPlatformId("corr_error")
        });
      }
    );
  });
  server.on("upgrade", (request, socket, head) => {
    if (!edgeGateway.handleUpgrade(request, socket as Socket, head)) {
      socket.destroy();
    }
  });
  const stopFreshnessSweep = startTelemetryFreshnessSweep(service, config, logger);

  return {
    server,
    service,
    eventHub,
    edgeGateway,
    config,
    repository: runtimeRepository.repository,
    metrics,
    async stop(): Promise<void> {
      await stopFreshnessSweep();
      await edgeGateway.closeAll();
      await runtimeRepository.close();
    }
  };
}

/** Loads env defaults while allowing explicit runtime persistence config to win. */
function loadRuntimeBaseConfig(
  configOverride: Partial<FleetPlatformConfig> | undefined
): FleetPlatformConfig {
  if (!configOverride?.persistence) {
    return loadFleetPlatformConfig();
  }
  return loadFleetPlatformConfig({
    ...process.env,
    FLEET_PERSISTENCE_MODE: "in-memory",
    FLEET_PERSISTENCE_DATABASE_URL: undefined
  });
}

/** Builds the configured repository without doing database migrations at server startup. */
function createRuntimeRepository(
  config: FleetPlatformConfig,
  initialState: DomainState | undefined
): {
  readonly repository: DomainStateRepository;
  readonly close: () => Promise<void>;
} {
  if (config.persistence.mode === "postgres") {
    if (initialState) {
      throw new Error("initialState is only supported with in-memory persistence");
    }
    const repository = new PostgresDomainStateRepository({
      databaseUrl: config.persistence.databaseUrl,
      poolConfig: {
        connectionTimeoutMillis: readinessRepositoryReadTimeoutMs
      }
    });
    return {
      repository,
      close: () => repository.close()
    };
  }

  return {
    repository: new InMemoryDomainStateRepository(
      initialState ?? createSeededDomainState(config.demoRobotId)
    ),
    close: async () => undefined
  };
}

/** Revalidates config overrides supplied directly by embedded callers and tests. */
function normalizeFleetPlatformConfig(config: FleetPlatformConfig): FleetPlatformConfig {
  const persistence = config.persistence as {
    readonly mode?: string;
    readonly databaseUrl?: string;
  };
  if (persistence.mode === "in-memory") {
    return config;
  }
  if (persistence.mode === "postgres") {
    if (!persistence.databaseUrl || persistence.databaseUrl.trim().length === 0) {
      throw new Error("persistence.databaseUrl is required for Postgres persistence");
    }
    return config;
  }
  throw new Error(
    `Unsupported persistence.mode "${persistence.mode ?? "unknown"}". ` +
      'Use "in-memory" or "postgres".'
  );
}

/** Starts the Fleet Platform HTTP server and resolves when it is listening. */
export function listenFleetPlatform(runtime: FleetPlatformRuntime): Promise<void> {
  return new Promise((resolve) => {
    runtime.server.listen(runtime.config.port, runtime.config.host, resolve);
  });
}

/** Periodically reevaluates robot heartbeat age so stale telemetry changes state without demo hooks. */
function startTelemetryFreshnessSweep(
  service: FleetPlatformService,
  config: FleetPlatformConfig,
  logger: StructuredLogger
): () => Promise<void> {
  let activeSweep: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (activeSweep) {
      return;
    }

    const now = nowIso();
    activeSweep = service
      .evaluateAllRobotFreshness({
        correlationId: createPlatformId("corr_freshness"),
        causationId: "telemetry-freshness-sweep",
        now
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.error("telemetry freshness sweep failed", {
          errorType: classifyErrorType(error)
        });
      })
      .finally(() => {
        activeSweep = undefined;
      });
  }, config.telemetryFreshnessSweepMs);

  timer.unref();
  return async () => {
    clearInterval(timer);
    await activeSweep;
  };
}

/** Routes one HTTP request across REST, SSE, health, and demo endpoints. */
async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: FleetPlatformService,
  eventHub: PlatformEventHub,
  config: FleetPlatformConfig,
  logger: StructuredLogger,
  metrics: FleetPlatformMetrics
): Promise<void> {
  applyCors(response, config);
  const url = parseRequestUrl(request);
  recordHttpRequestOnFinish(response, metrics, {
    method: request.method,
    route: routeLabelForRequest(request.method, url?.pathname)
  });

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (!url) {
    sendError(response, config, 400, "BAD_REQUEST", "request URL is required", {
      correlationId: createPlatformId("corr_bad_request")
    });
    return;
  }

  const context = createRequestContext(request);
  logger.info("http request received", {
    method: request.method,
    path: url.pathname,
    correlationId: context.correlationId
  });

  if (request.method === "GET" && url.pathname === "/health/live") {
    sendJson(response, config, 200, { status: "ok" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/health/ready") {
    await sendReadinessResponse(
      response,
      service,
      eventHub,
      config,
      context,
      logger,
      metrics
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/metrics") {
    sendMetrics(response, config, metrics);
    return;
  }

  if (request.method === "GET" && url.pathname === "/stream/events") {
    openSseStream(response, eventHub, config);
    return;
  }

  if (url.pathname.startsWith("/demo/")) {
    await handleDemoRequest(request, response, service, config, context, url);
    return;
  }

  if (request.method === "POST" && url.pathname === "/missions") {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendValidationError(response, config, context, body.issues);
      return;
    }
    const parsed = parseCreateMissionRequest(body.value);
    if (!parsed.ok) {
      sendValidationError(response, config, context, parsed.issues);
      return;
    }

    const result = await service.createMission(parsed.value, context);
    sendDispatchResult(response, config, context, result);
    return;
  }

  if (request.method === "GET" && url.pathname === "/missions") {
    sendJson(response, config, 200, { missions: await service.listMissions() });
    return;
  }

  const missionCancelMatch = url.pathname.match(/^\/missions\/([^/]+)\/cancel$/);
  if (request.method === "POST" && missionCancelMatch?.[1]) {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendValidationError(response, config, context, body.issues);
      return;
    }
    const parsed = parseCancelMissionRequest(body.value);
    if (!parsed.ok) {
      sendValidationError(response, config, context, parsed.issues);
      return;
    }

    const result = await service.cancelMission(
      decodeURIComponent(missionCancelMatch[1]),
      parsed.value,
      context
    );
    if (!result) {
      sendError(response, config, 404, "MISSION_NOT_FOUND", "mission not found", context);
      return;
    }
    sendDispatchResult(response, config, context, result);
    return;
  }

  const missionMatch = url.pathname.match(/^\/missions\/([^/]+)$/);
  if (request.method === "GET" && missionMatch?.[1]) {
    const mission = await service.getMission(decodeURIComponent(missionMatch[1]));
    if (!mission) {
      sendError(response, config, 404, "MISSION_NOT_FOUND", "mission not found", context);
      return;
    }
    sendJson(response, config, 200, { mission });
    return;
  }

  if (request.method === "GET" && url.pathname === "/robots") {
    sendJson(response, config, 200, { robots: await service.listRobots() });
    return;
  }

  const robotMatch = url.pathname.match(/^\/robots\/([^/]+)$/);
  if (request.method === "GET" && robotMatch?.[1]) {
    const robot = await service.getRobot(decodeURIComponent(robotMatch[1]));
    if (!robot) {
      sendError(response, config, 404, "ROBOT_NOT_FOUND", "robot not found", context);
      return;
    }
    sendJson(response, config, 200, { robot });
    return;
  }

  if (request.method === "GET" && url.pathname === "/events") {
    sendJson(response, config, 200, {
      events: await service.listEvents(queryFilters(url))
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/audit-events") {
    sendJson(response, config, 200, {
      auditEvents: await service.listAuditEvents(queryFilters(url))
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/edge/connect") {
    sendError(
      response,
      config,
      426,
      "WEBSOCKET_REQUIRED",
      "edge connections must use WebSocket upgrade",
      context
    );
    return;
  }

  sendError(response, config, 404, "NOT_FOUND", "route not found", context);
}

/** Verifies the configured repository can load the current domain aggregate. */
async function sendReadinessResponse(
  response: ServerResponse,
  service: FleetPlatformService,
  eventHub: PlatformEventHub,
  config: FleetPlatformConfig,
  context: RequestContext,
  logger: StructuredLogger,
  metrics: FleetPlatformMetrics
): Promise<void> {
  try {
    await readStateForReadiness(service);
    sendJson(response, config, 200, {
      status: "ready",
      persistence: {
        mode: config.persistence.mode
      },
      sseSubscribers: eventHub.listenerCount()
    });
  } catch (error: unknown) {
    const errorType = classifyReadinessError(error);
    metrics.recordReadinessFailure({
      persistenceMode: config.persistence.mode,
      check: repositoryReadinessCheckName,
      errorType
    });
    logger.warn("persistence readiness check failed", {
      correlationId: context.correlationId,
      persistenceMode: config.persistence.mode,
      check: repositoryReadinessCheckName,
      errorType
    });
    sendError(
      response,
      config,
      503,
      "PERSISTENCE_NOT_READY",
      "persistence backend is not ready",
      context,
      {
        persistenceMode: config.persistence.mode,
        check: repositoryReadinessCheckName
      }
    );
  }
}

/** Bounds the readiness repository check so unavailable backing services fail fast. */
async function readStateForReadiness(service: FleetPlatformService): Promise<void> {
  await runRepositoryReadinessCheck(() => service.getState());
}

/** Handles demo-only fault and scenario endpoints after applying demo auth gates. */
async function handleDemoRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: FleetPlatformService,
  config: FleetPlatformConfig,
  context: RequestContext,
  url: URL
): Promise<void> {
  const gate = validateDemoAccess(request, config);
  if (!gate.ok) {
    sendError(response, config, gate.statusCode, gate.code, gate.message, context);
    return;
  }

  if (request.method === "POST" && url.pathname === "/demo/scenarios/reset") {
    sendJson(response, config, 200, { state: await service.resetDemo(context) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/demo/scenarios/incident/start") {
    sendDispatchResult(response, config, context, await service.startIncident(context));
    return;
  }

  if (request.method === "POST" && url.pathname === "/demo/faults/disconnect") {
    sendJson(response, config, 200, {
      result: await service.disconnectDemoRobot(context)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/demo/faults/reconnect") {
    sendJson(response, config, 200, {
      result: await service.reconnectDemoRobot(context)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/demo/faults/duplicate-command") {
    sendDispatchResult(
      response,
      config,
      context,
      await service.duplicateDemoCommand(context)
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/demo/faults/low-battery") {
    sendDispatchResult(response, config, context, await service.lowBatteryDemo(context));
    return;
  }

  sendError(response, config, 404, "NOT_FOUND", "demo route not found", context);
}

/** Validates that demo endpoints are both enabled and explicitly authenticated. */
function validateDemoAccess(
  request: IncomingMessage,
  config: FleetPlatformConfig
):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly statusCode: number;
      readonly code: string;
      readonly message: string;
    } {
  if (!config.demoMode) {
    return {
      ok: false,
      statusCode: 404,
      code: "DEMO_ENDPOINT_DISABLED",
      message: "demo endpoints are disabled"
    };
  }

  if (
    !config.demoAdminToken ||
    request.headers["x-demo-admin-token"] !== config.demoAdminToken
  ) {
    return {
      ok: false,
      statusCode: 401,
      code: "DEMO_ADMIN_TOKEN_REQUIRED",
      message: "demo admin token is required"
    };
  }

  return { ok: true };
}

/** Opens a server-sent event stream for browser dashboards. */
function openSseStream(
  response: ServerResponse,
  eventHub: PlatformEventHub,
  config: FleetPlatformConfig
): void {
  response.writeHead(200, {
    "Access-Control-Allow-Origin": config.corsAllowOrigin,
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream"
  });
  writeSseEvent(response, {
    streamEventId: createPlatformId("stream"),
    type: "platform",
    occurredAt: nowIso(),
    data: { eventType: "stream.ready" }
  });

  const unsubscribe = eventHub.subscribe((event) => writeSseEvent(response, event));
  const heartbeat = setInterval(() => {
    response.write(`: heartbeat ${nowIso()}\n\n`);
  }, 15_000);

  response.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

/** Writes one SSE event using the event type and JSON payload expected by browsers. */
function writeSseEvent(response: ServerResponse, event: PlatformStreamEvent): void {
  response.write(`id: ${event.streamEventId}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

type BodyReadResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/** Reads and parses a JSON request body with a small size limit for demo safety. */
async function readJsonBody(request: IncomingMessage): Promise<BodyReadResult> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > 1024 * 1024) {
      return {
        ok: false,
        issues: [{ path: "$", message: "request body must be at most 1MiB" }]
      };
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return { ok: true, value: {} };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
    };
  } catch {
    return {
      ok: false,
      issues: [{ path: "$", message: "request body must be valid JSON" }]
    };
  }
}

/** Sends a mission command response with HTTP status mapped from domain outcome. */
function sendDispatchResult(
  response: ServerResponse,
  config: FleetPlatformConfig,
  context: RequestContext,
  body: {
    readonly result: { readonly status: string; readonly reason?: string };
    readonly deliveryCount: number;
  }
): void {
  if (body.result.status === "ACCEPTED") {
    sendJson(response, config, 202, body);
    return;
  }

  if (body.result.status === "IDEMPOTENT_REPLAY") {
    sendJson(response, config, 200, body);
    return;
  }

  sendJson(response, config, statusForRejection(body.result.reason), {
    ...body,
    correlationId: context.correlationId
  });
}

/** Maps domain rejection reasons to stable HTTP status codes. */
function statusForRejection(reason: string | undefined): number {
  if (
    reason === "IDEMPOTENCY_KEY_REUSE_CONFLICT" ||
    reason === "DUPLICATE_COMMAND_ID" ||
    reason === "ROBOT_ALREADY_ASSIGNED"
  ) {
    return 409;
  }
  if (
    reason === "ROBOT_TELEMETRY_STALE" ||
    reason === "LOW_BATTERY" ||
    reason === "RECONCILIATION_IN_PROGRESS"
  ) {
    return 423;
  }
  return 422;
}

/** Sends JSON with common headers. */
function sendJson(
  response: ServerResponse,
  config: FleetPlatformConfig,
  statusCode: number,
  body: unknown
): void {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": config.corsAllowOrigin,
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

/** Sends the current in-process metrics in Prometheus text format. */
function sendMetrics(
  response: ServerResponse,
  config: FleetPlatformConfig,
  metrics: FleetPlatformMetrics
): void {
  response.writeHead(200, {
    "Access-Control-Allow-Origin": config.corsAllowOrigin,
    "Content-Type": prometheusTextContentType
  });
  response.end(metrics.registry.renderPrometheusText());
}

/** Sends a validation failure in the standard error response shape. */
function sendValidationError(
  response: ServerResponse,
  config: FleetPlatformConfig,
  context: RequestContext,
  issues: readonly ValidationIssue[]
): void {
  sendError(response, config, 400, "VALIDATION_FAILED", "request validation failed", context, issues);
}

/** Sends a structured API error body. */
function sendError(
  response: ServerResponse,
  config: FleetPlatformConfig,
  statusCode: number,
  code: string,
  message: string,
  context: Pick<RequestContext, "correlationId">,
  details?: unknown
): void {
  const body: ApiErrorBody = {
    error: {
      code,
      message,
      correlationId: context.correlationId,
      ...(details ? { details } : {})
    }
  };
  sendJson(response, config, statusCode, body);
}

/** Applies permissive local CORS headers for the upcoming operator UI app. */
function applyCors(response: ServerResponse, config: FleetPlatformConfig): void {
  response.setHeader("Access-Control-Allow-Origin", config.corsAllowOrigin);
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Correlation-Id, X-Demo-Admin-Token");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

/** Records the final HTTP status after the response has been written. */
function recordHttpRequestOnFinish(
  response: ServerResponse,
  metrics: FleetPlatformMetrics,
  request: {
    readonly method: string | undefined;
    readonly route: string;
  }
): void {
  response.once("finish", () => {
    metrics.recordHttpRequest({
      method: request.method,
      route: request.route,
      statusCode: response.statusCode
    });
  });
}

/** Builds request context from headers plus local fallback ids. */
function createRequestContext(request: IncomingMessage): RequestContext {
  const correlationId =
    readCorrelationIdHeader(request.headers) ?? createPlatformId("corr_http");
  return {
    correlationId,
    causationId: createPlatformId("http_request"),
    now: nowIso(),
    headers: request.headers
  };
}

/** Parses URL safely for all Node HTTP request paths. */
function parseRequestUrl(request: IncomingMessage): URL | undefined {
  if (!request.url) {
    return undefined;
  }
  return new URL(request.url, "http://localhost");
}

/** Extracts supported event query filters from URLSearchParams. */
function queryFilters(url: URL): { readonly missionId?: string; readonly robotId?: string } {
  const missionId = url.searchParams.get("missionId");
  const robotId = url.searchParams.get("robotId");
  return {
    ...(missionId ? { missionId } : {}),
    ...(robotId ? { robotId } : {})
  };
}
