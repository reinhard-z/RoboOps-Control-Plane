import type { IncomingHttpHeaders, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";

import cors from "@fastify/cors";
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
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";

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
  readonly app: FastifyInstance;
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

  const app = createFleetPlatformHttpApp({
    service,
    eventHub,
    config,
    logger,
    metrics
  });
  const server = app.server;
  server.on("upgrade", (request, socket, head) => {
    if (!edgeGateway.handleUpgrade(request, socket as Socket, head)) {
      socket.destroy();
    }
  });
  const stopFreshnessSweep = startTelemetryFreshnessSweep(service, config, logger);

  return {
    app,
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
export async function listenFleetPlatform(runtime: FleetPlatformRuntime): Promise<void> {
  await runtime.app.listen({
    host: runtime.config.host,
    port: runtime.config.port
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

/** Dependencies needed by the Fastify HTTP surface. */
interface FleetPlatformHttpAppOptions {
  readonly service: FleetPlatformService;
  readonly eventHub: PlatformEventHub;
  readonly config: FleetPlatformConfig;
  readonly logger: StructuredLogger;
  readonly metrics: FleetPlatformMetrics;
}

/** Builds the Fastify REST/SSE app while leaving WebSocket upgrades on the raw server. */
function createFleetPlatformHttpApp({
  service,
  eventHub,
  config,
  logger,
  metrics
}: FleetPlatformHttpAppOptions): FastifyInstance {
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    logger: false
  });
  const requestContexts = new WeakMap<FastifyRequest, RequestContext>();
  const requestContextFor = (request: FastifyRequest): RequestContext => {
    const existing = requestContexts.get(request);
    if (existing) {
      return existing;
    }
    const context = createRequestContext(request.headers);
    requestContexts.set(request, context);
    return context;
  };

  app.addHook("onRequest", (request, reply, done) => {
    const url = parseFastifyRequestUrl(request);
    const context = requestContextFor(request);
    recordHttpRequestOnFinish(reply.raw, metrics, {
      method: request.method,
      route: routeLabelForRequest(request.method, url.pathname)
    });
    logger.info("http request received", {
      method: request.method,
      path: url.pathname,
      correlationId: context.correlationId
    });
    done();
  });

  app.register(cors, {
    allowedHeaders: ["Content-Type", "X-Correlation-Id", "X-Demo-Admin-Token"],
    methods: ["GET", "POST", "OPTIONS"],
    origin: config.corsAllowOrigin
  });

  app.setErrorHandler((error, request, reply) => {
    const context = requestContextFor(request);
    const validationIssue = fastifyBodyValidationIssue(error);
    if (validationIssue) {
      sendValidationError(reply, context, [validationIssue]);
      return;
    }
    const clientError = fastifyClientError(error);
    if (clientError) {
      sendError(reply, clientError.statusCode, clientError.code, clientError.message, context);
      return;
    }

    logger.error("unhandled http request error", {
      errorType: classifyErrorType(error)
    });
    sendError(reply, 500, "INTERNAL_ERROR", "internal server error", context);
  });

  app.get("/health/live", async (_request, reply) => {
    sendJson(reply, 200, { status: "ok" });
  });

  app.get("/health/ready", async (request, reply) => {
    await sendReadinessResponse(
      reply,
      service,
      eventHub,
      config,
      requestContextFor(request),
      logger,
      metrics
    );
  });

  app.get("/metrics", async (_request, reply) => {
    sendMetrics(reply, metrics);
  });

  app.get("/stream/events", async (_request, reply) => {
    openSseStream(reply, eventHub, config);
  });

  app.post("/missions", async (request, reply) => {
    const context = requestContextFor(request);
    const parsed = parseCreateMissionRequest(request.body ?? {});
    if (!parsed.ok) {
      sendValidationError(reply, context, parsed.issues);
      return;
    }

    const result = await service.createMission(parsed.value, context);
    sendDispatchResult(reply, context, result);
  });

  app.get("/missions", async (_request, reply) => {
    sendJson(reply, 200, { missions: await service.listMissions() });
  });

  app.post<{ Params: { missionId: string } }>(
    "/missions/:missionId/cancel",
    async (request, reply) => {
      const context = requestContextFor(request);
      const parsed = parseCancelMissionRequest(request.body ?? {});
      if (!parsed.ok) {
        sendValidationError(reply, context, parsed.issues);
        return;
      }

      const result = await service.cancelMission(
        request.params.missionId,
        parsed.value,
        context
      );
      if (!result) {
        sendError(reply, 404, "MISSION_NOT_FOUND", "mission not found", context);
        return;
      }
      sendDispatchResult(reply, context, result);
    }
  );

  app.get<{ Params: { missionId: string } }>(
    "/missions/:missionId",
    async (request, reply) => {
      const mission = await service.getMission(request.params.missionId);
      if (!mission) {
        sendError(
          reply,
          404,
          "MISSION_NOT_FOUND",
          "mission not found",
          requestContextFor(request)
        );
        return;
      }
      sendJson(reply, 200, { mission });
    }
  );

  app.get("/robots", async (_request, reply) => {
    sendJson(reply, 200, { robots: await service.listRobots() });
  });

  app.get<{ Params: { robotId: string } }>(
    "/robots/:robotId",
    async (request, reply) => {
      const robot = await service.getRobot(request.params.robotId);
      if (!robot) {
        sendError(
          reply,
          404,
          "ROBOT_NOT_FOUND",
          "robot not found",
          requestContextFor(request)
        );
        return;
      }
      sendJson(reply, 200, { robot });
    }
  );

  app.get("/events", async (request, reply) => {
    sendJson(reply, 200, {
      events: await service.listEvents(queryFilters(parseFastifyRequestUrl(request)))
    });
  });

  app.get("/audit-events", async (request, reply) => {
    sendJson(reply, 200, {
      auditEvents: await service.listAuditEvents(queryFilters(parseFastifyRequestUrl(request)))
    });
  });

  app.get("/edge/connect", async (request, reply) => {
    sendError(
      reply,
      426,
      "WEBSOCKET_REQUIRED",
      "edge connections must use WebSocket upgrade",
      requestContextFor(request)
    );
  });

  app.all("/demo/*", async (request, reply) => {
    await handleDemoRequest(
      request,
      reply,
      service,
      config,
      requestContextFor(request),
      parseFastifyRequestUrl(request)
    );
  });

  app.setNotFoundHandler((request, reply) => {
    sendError(reply, 404, "NOT_FOUND", "route not found", requestContextFor(request));
  });

  return app;
}

/** Verifies the configured repository can load the current domain aggregate. */
async function sendReadinessResponse(
  reply: FastifyReply,
  service: FleetPlatformService,
  eventHub: PlatformEventHub,
  config: FleetPlatformConfig,
  context: RequestContext,
  logger: StructuredLogger,
  metrics: FleetPlatformMetrics
): Promise<void> {
  try {
    await readStateForReadiness(service);
    sendJson(reply, 200, {
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
      reply,
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
  request: FastifyRequest,
  reply: FastifyReply,
  service: FleetPlatformService,
  config: FleetPlatformConfig,
  context: RequestContext,
  url: URL
): Promise<void> {
  const gate = validateDemoAccess(request.headers, config);
  if (!gate.ok) {
    sendError(reply, gate.statusCode, gate.code, gate.message, context);
    return;
  }

  if (request.method === "POST" && url.pathname === "/demo/scenarios/reset") {
    sendJson(reply, 200, { state: await service.resetDemo(context) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/demo/scenarios/incident/start") {
    sendDispatchResult(reply, context, await service.startIncident(context));
    return;
  }

  if (request.method === "POST" && url.pathname === "/demo/faults/disconnect") {
    sendJson(reply, 200, {
      result: await service.disconnectDemoRobot(context)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/demo/faults/reconnect") {
    sendJson(reply, 200, {
      result: await service.reconnectDemoRobot(context)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/demo/faults/duplicate-command") {
    sendDispatchResult(
      reply,
      context,
      await service.duplicateDemoCommand(context)
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/demo/faults/low-battery") {
    sendDispatchResult(reply, context, await service.lowBatteryDemo(context));
    return;
  }

  sendError(reply, 404, "NOT_FOUND", "demo route not found", context);
}

/** Validates that demo endpoints are both enabled and explicitly authenticated. */
function validateDemoAccess(
  headers: IncomingHttpHeaders,
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
    headers["x-demo-admin-token"] !== config.demoAdminToken
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
  reply: FastifyReply,
  eventHub: PlatformEventHub,
  config: FleetPlatformConfig
): void {
  reply.hijack();
  const response = reply.raw;
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

/** Sends a mission command response with HTTP status mapped from domain outcome. */
function sendDispatchResult(
  reply: FastifyReply,
  context: RequestContext,
  body: {
    readonly result: { readonly status: string; readonly reason?: string };
    readonly deliveryCount: number;
  }
): void {
  if (body.result.status === "ACCEPTED") {
    sendJson(reply, 202, body);
    return;
  }

  if (body.result.status === "IDEMPOTENT_REPLAY") {
    sendJson(reply, 200, body);
    return;
  }

  sendJson(reply, statusForRejection(body.result.reason), {
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
  reply: FastifyReply,
  statusCode: number,
  body: unknown
): void {
  reply.code(statusCode).type("application/json; charset=utf-8").send(body);
}

/** Sends the current in-process metrics in Prometheus text format. */
function sendMetrics(
  reply: FastifyReply,
  metrics: FleetPlatformMetrics
): void {
  reply
    .code(200)
    .header("Content-Type", prometheusTextContentType)
    .send(metrics.registry.renderPrometheusText());
}

/** Sends a validation failure in the standard error response shape. */
function sendValidationError(
  reply: FastifyReply,
  context: RequestContext,
  issues: readonly ValidationIssue[]
): void {
  sendError(reply, 400, "VALIDATION_FAILED", "request validation failed", context, issues);
}

/** Sends a structured API error body. */
function sendError(
  reply: FastifyReply,
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
  sendJson(reply, statusCode, body);
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

/** Converts Fastify body parser errors into the API's validation response shape. */
function fastifyBodyValidationIssue(error: unknown): ValidationIssue | undefined {
  const parsed = error as {
    readonly code?: string;
    readonly statusCode?: number;
  };
  if (parsed.code === "FST_ERR_CTP_BODY_TOO_LARGE" || parsed.statusCode === 413) {
    return { path: "$", message: "request body must be at most 1MiB" };
  }
  if (parsed.code === "FST_ERR_CTP_INVALID_JSON_BODY") {
    return { path: "$", message: "request body must be valid JSON" };
  }
  return undefined;
}

/** Maps Fastify parser client failures that should not be reported as internal errors. */
function fastifyClientError(error: unknown):
  | { readonly statusCode: number; readonly code: string; readonly message: string }
  | undefined {
  const parsed = error as {
    readonly code?: string;
    readonly statusCode?: number;
  };
  if (parsed.statusCode === 415 || parsed.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
    return {
      statusCode: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "request content type is not supported"
    };
  }
  if (parsed.statusCode && parsed.statusCode >= 400 && parsed.statusCode < 500) {
    return {
      statusCode: parsed.statusCode,
      code: "BAD_REQUEST",
      message: "request could not be processed"
    };
  }
  return undefined;
}

/** Builds request context from headers plus local fallback ids. */
function createRequestContext(headers: IncomingHttpHeaders): RequestContext {
  const correlationId =
    readCorrelationIdHeader(headers) ?? createPlatformId("corr_http");
  return {
    correlationId,
    causationId: createPlatformId("http_request"),
    now: nowIso(),
    headers
  };
}

/** Parses URL safely for Fastify request paths without trusting Host for routing. */
function parseFastifyRequestUrl(request: FastifyRequest): URL {
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
