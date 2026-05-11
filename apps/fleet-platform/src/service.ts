import {
  type DispatchMissionCommandInput,
  type DomainState,
  type DomainTransition,
  type CancelMissionResult,
  type DispatchMissionResult,
  applyCommandAck,
  beginReconnect,
  dispatchMissionCommand,
  evaluateTelemetryFreshness,
  getMission,
  getRobot,
  ingestRobotTelemetry,
  processReconnectHandshake,
  requestMissionCancellation,
  upsertRobotSnapshot
} from "@roboops/fleet-domain";
import {
  type AuditEventV1,
  type CommandEnvelopeV1,
  type EventEnvelopeV1,
  type RobotId,
  protocolSchemaVersions
} from "@roboops/fleet-protocol";

import { PlatformEventHub } from "./event-hub.js";
import { createPlatformId, isoPlus } from "./ids.js";
import type { StructuredLogger } from "./logging.js";
import {
  type DomainStateRepository,
  createSeededDomainState
} from "./repository.js";
import type {
  CancelMissionRequest,
  CreateMissionRequest,
  EdgeHelloPayload,
  EdgeWireMessage,
  FleetPlatformConfig,
  PlatformWireMessage,
  RequestContext
} from "./types.js";

/** Transport boundary used by the service to publish commands to edge sockets. */
export interface EdgeCommandTransport {
  sendCommand(command: CommandEnvelopeV1): number;
  sendPlatformMessage(robotId: RobotId, message: PlatformWireMessage): number;
}

/** Result returned to HTTP handlers after a command-producing request. */
export interface MissionCommandServiceResult {
  readonly result: DispatchMissionResult | CancelMissionResult;
  readonly deliveryCount: number;
}

/** Coordinates HTTP/edge requests with the pure domain reducers and in-memory repository. */
export class FleetPlatformService {
  private edgeTransport: EdgeCommandTransport | undefined;

  constructor(
    private readonly repository: DomainStateRepository,
    private readonly eventHub: PlatformEventHub,
    private readonly logger: StructuredLogger,
    private readonly config: FleetPlatformConfig
  ) {}

  setEdgeTransport(edgeTransport: EdgeCommandTransport): void {
    this.edgeTransport = edgeTransport;
  }

  createMission(
    request: CreateMissionRequest,
    context: RequestContext
  ): MissionCommandServiceResult {
    this.evaluateKnownRobotFreshness(request.robotId, context);

    const input = this.toDispatchInput(request, context);
    const transition = dispatchMissionCommand(this.repository.read(), input);
    this.commitTransition(transition);

    const deliveryCount =
      transition.result.status === "ACCEPTED"
        ? this.edgeTransport?.sendCommand(transition.result.command) ?? 0
        : 0;

    this.logger.info("mission command request handled", {
      correlationId: context.correlationId,
      missionId: input.missionId,
      commandId: input.commandId,
      robotId: input.robotId,
      resultStatus: transition.result.status,
      deliveryCount
    });

    return { result: transition.result, deliveryCount };
  }

  cancelMission(
    missionId: string,
    request: CancelMissionRequest,
    context: RequestContext
  ): MissionCommandServiceResult | undefined {
    const mission = getMission(this.repository.read(), missionId);
    if (!mission) {
      return undefined;
    }

    const issuedAt = context.now;
    const transition = requestMissionCancellation(this.repository.read(), {
      commandId: request.commandId ?? createPlatformId("cmd"),
      missionId,
      idempotencyKey:
        request.idempotencyKey ?? `operator:cancel:${missionId}:${context.correlationId}`,
      issuedAt,
      expiresAt: isoPlus(
        issuedAt,
        request.expiresInMs ?? this.config.defaultCommandTtlMs
      ),
      correlationId: context.correlationId,
      causationId: context.causationId,
      reason: request.reason,
      now: context.now
    });
    this.commitTransition(transition);

    const deliveryCount =
      transition.result.status === "ACCEPTED"
        ? this.edgeTransport?.sendCommand(transition.result.command) ?? 0
        : 0;

    this.logger.info("mission cancellation request handled", {
      correlationId: context.correlationId,
      missionId,
      robotId: mission.robotId,
      resultStatus: transition.result.status,
      deliveryCount
    });

    return { result: transition.result, deliveryCount };
  }

  evaluateAllRobotFreshness(context: RequestContext): readonly unknown[] {
    const robotIds = Object.keys(this.repository.read().robots);
    return robotIds.map((robotId) => this.evaluateKnownRobotFreshness(robotId, context));
  }

  evaluateKnownRobotFreshness(robotId: RobotId, context: RequestContext): unknown {
    const robot = getRobot(this.repository.read(), robotId);
    if (!robot) {
      return { status: "UNKNOWN_ROBOT" };
    }

    return this.evaluateRobotFreshness(robotId, context);
  }

  handleEdgeConnected(
    robotId: RobotId,
    hello: EdgeHelloPayload | undefined,
    context: RequestContext
  ): void {
    const state = this.repository.read();
    const existingRobot = state.robots[robotId];
    const lastSeenCommandSequence = Math.max(
      existingRobot?.lastSeenCommandSequence ?? 0,
      hello?.lastSeenCommandSequence ?? 0
    );
    const nextRobot = existingRobot
      ? {
          ...existingRobot,
          connectionState: "ONLINE" as const,
          updatedAt: context.now,
          lastSeenCommandSequence,
          ...(hello?.edgeAgentVersion
            ? { edgeAgentVersion: hello.edgeAgentVersion }
            : {})
        }
      : {
          robotId,
          connectionState: "ONLINE" as const,
          updatedAt: context.now,
          health: "OK" as const,
          batteryPercent: 80,
          lastTelemetryObservedAt: context.now,
          lastTelemetryReceivedAt: context.now,
          lastSeenCommandSequence,
          edgeAgentVersion: hello?.edgeAgentVersion ?? "0.1.0"
        };

    const nextState = upsertRobotSnapshot(state, nextRobot);
    this.repository.write(nextState);
    this.eventHub.publish(
      "platform",
      {
        eventType: "edge.connected",
        robotId,
        edgeSessionId: hello?.edgeSessionId ?? null
      },
      context.now
    );
    this.edgeTransport?.sendPlatformMessage(robotId, {
      type: "platform.ping",
      payload: { sentAt: context.now }
    });
    this.deliverPendingCommands(robotId);
  }

  handleEdgeDisconnected(robotId: RobotId, context: RequestContext): void {
    const transition = beginReconnect(this.repository.read(), {
      robotId,
      now: context.now,
      correlationId: context.correlationId
    });
    this.commitTransition(transition);
    this.eventHub.publish(
      "platform",
      { eventType: "edge.disconnected", robotId },
      context.now
    );
  }

  handleEdgeMessage(
    robotId: RobotId,
    message: EdgeWireMessage,
    context: RequestContext
  ): void {
    if (message.type === "edge.hello") {
      this.handleEdgeConnected(robotId, message.payload, context);
      return;
    }

    if (message.type === "edge.command_ack") {
      this.commitTransition(applyCommandAck(this.repository.read(), message.payload));
      return;
    }

    if (message.type === "edge.telemetry") {
      this.commitTransition(ingestRobotTelemetry(this.repository.read(), message.payload));
      return;
    }

    const robot = getRobot(this.repository.read(), message.payload.robotId);
    if (robot && robot.connectionState !== "RECONNECTING") {
      this.commitTransition(
        beginReconnect(this.repository.read(), {
          robotId: message.payload.robotId,
          now: context.now,
          correlationId: context.correlationId
        })
      );
    }
    this.commitTransition(
      processReconnectHandshake(this.repository.read(), message.payload, {
        now: context.now,
        correlationId: context.correlationId
      })
    );
  }

  evaluateRobotFreshness(robotId: RobotId, context: RequestContext): unknown {
    const transition = evaluateTelemetryFreshness(this.repository.read(), {
      robotId,
      now: context.now,
      correlationId: context.correlationId
    });
    this.commitTransition(transition);
    return transition.result;
  }

  resetDemo(context: RequestContext): DomainState {
    const nextState = createSeededDomainState(this.config.demoRobotId, context.now);
    this.repository.reset(nextState);
    this.eventHub.publish(
      "platform",
      { eventType: "demo.reset", robotId: this.config.demoRobotId },
      context.now
    );
    return nextState;
  }

  startIncident(context: RequestContext): MissionCommandServiceResult {
    return this.createMission(
      {
        robotId: this.config.demoRobotId,
        type: "GO_TO_POSE",
        idempotencyKey: "demo:incident:create",
        payload: { target: { x: 2, y: 4.5, theta: 1.57 } },
        safetyClass: "NORMAL"
      },
      context
    );
  }

  disconnectDemoRobot(context: RequestContext): unknown {
    const staleAt = new Date(Date.parse(context.now) - 11_000).toISOString();
    this.repository.update((state) => {
      const robot = state.robots[this.config.demoRobotId];
      if (!robot) {
        return state;
      }
      return upsertRobotSnapshot(state, {
        ...robot,
        connectionState: "ONLINE",
        lastTelemetryObservedAt: staleAt,
        lastTelemetryReceivedAt: staleAt
      });
    });
    return this.evaluateRobotFreshness(this.config.demoRobotId, context);
  }

  reconnectDemoRobot(context: RequestContext): unknown {
    const state = this.repository.read();
    const robot = state.robots[this.config.demoRobotId];
    if (!robot) {
      return { status: "UNKNOWN_ROBOT" };
    }

    const reconnectStart = beginReconnect(state, {
      robotId: robot.robotId,
      now: context.now,
      correlationId: context.correlationId
    });
    this.commitTransition(reconnectStart);

    const nextState = this.repository.read();
    const activeMission = robot.activeMissionId
      ? nextState.missions[robot.activeMissionId]
      : undefined;
    const command = activeMission?.currentCommandId
      ? nextState.commands[activeMission.currentCommandId]
      : undefined;
    if (!activeMission || !command) {
      return reconnectStart.result;
    }

    const handshake = {
      schemaVersion: protocolSchemaVersions.reconnectHandshake,
      robotId: robot.robotId,
      edgeSessionId: createPlatformId("edge_session"),
      connectedAt: context.now,
      lastSeenCommandSequence: command.sequence,
      lastAcknowledgedCommandId: command.commandId,
      reportedMissionId: activeMission.missionId,
      reportedMissionLifecycleState: activeMission.lifecycleState,
      lastTelemetryObservedAt: context.now,
      edgeAgentVersion: robot.edgeAgentVersion ?? "0.1.0"
    } as const;
    const reconciled = processReconnectHandshake(this.repository.read(), handshake, {
      now: context.now,
      correlationId: context.correlationId
    });
    this.commitTransition(reconciled);
    return reconciled.result;
  }

  duplicateDemoCommand(context: RequestContext): MissionCommandServiceResult {
    return this.createMission(
      {
        robotId: this.config.demoRobotId,
        type: "GO_TO_POSE",
        idempotencyKey: "demo:incident:create",
        payload: { target: { x: 2, y: 4.5, theta: 1.57 } },
        safetyClass: "NORMAL"
      },
      context
    );
  }

  lowBatteryDemo(context: RequestContext): MissionCommandServiceResult {
    this.repository.update((state) => {
      const robot = state.robots[this.config.demoRobotId];
      if (!robot) {
        return state;
      }
      return upsertRobotSnapshot(state, {
        ...robot,
        batteryPercent: 10,
        updatedAt: context.now
      });
    });
    return this.createMission(
      {
        robotId: this.config.demoRobotId,
        type: "GO_TO_POSE",
        idempotencyKey: `demo:low-battery:${context.correlationId}`,
        payload: { target: { x: 2, y: 4.5, theta: 1.57 } },
        safetyClass: "NORMAL"
      },
      context
    );
  }

  getState(): DomainState {
    return this.repository.read();
  }

  listMissions(): readonly unknown[] {
    return Object.values(this.repository.read().missions);
  }

  getMission(missionId: string): unknown | undefined {
    return this.repository.read().missions[missionId];
  }

  listRobots(): readonly unknown[] {
    return Object.values(this.repository.read().robots);
  }

  getRobot(robotId: string): unknown | undefined {
    return this.repository.read().robots[robotId];
  }

  listEvents(filters: { readonly missionId?: string; readonly robotId?: string }): readonly EventEnvelopeV1[] {
    return this.repository.read().domainEvents.filter((event) =>
      matchesEventFilters(event, filters)
    );
  }

  listAuditEvents(filters: { readonly missionId?: string; readonly robotId?: string }): readonly AuditEventV1[] {
    return this.repository.read().auditEvents.filter((event) =>
      matchesAuditFilters(event, filters)
    );
  }

  /** Converts a validated operator request into the domain reducer input. */
  private toDispatchInput(
    request: CreateMissionRequest,
    context: RequestContext
  ): DispatchMissionCommandInput {
    const missionId = request.missionId ?? createPlatformId("mission");
    const commandId = request.commandId ?? createPlatformId("cmd");
    const issuedAt = context.now;
    const expiresAt = isoPlus(
      issuedAt,
      request.expiresInMs ?? this.config.defaultCommandTtlMs
    );

    return {
      commandId,
      missionId,
      robotId: request.robotId,
      type: request.type,
      idempotencyKey:
        request.idempotencyKey ?? `operator:${missionId}:${request.type}`,
      issuedAt,
      expiresAt,
      correlationId: context.correlationId,
      causationId: context.causationId,
      payload: request.payload,
      now: context.now,
      requiresAck: request.requiresAck ?? true,
      safetyClass: request.safetyClass ?? "NORMAL"
    };
  }

  /** Persists reducer output and streams the reducer-produced event records. */
  private commitTransition<TResult>(transition: DomainTransition<TResult>): void {
    this.repository.write(transition.state);
    for (const event of transition.domainEvents) {
      this.eventHub.publish("domain", event, event.receivedAt);
      this.logger.info("domain event emitted", {
        eventType: event.eventType,
        correlationId: event.correlationId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId
      });
    }
    for (const event of transition.auditEvents) {
      this.eventHub.publish("audit", event, event.occurredAt);
      this.logger.info("audit event emitted", {
        action: event.action,
        correlationId: event.correlationId,
        missionId: event.missionId,
        commandId: event.commandId,
        robotId: event.robotId
      });
    }
  }

  /** Redelivers still-dispatched commands when an edge reconnects after the HTTP request. */
  private deliverPendingCommands(robotId: RobotId): void {
    const state = this.repository.read();
    for (const command of Object.values(state.commands)) {
      if (command.robotId !== robotId) {
        continue;
      }
      const mission = state.missions[command.missionId];
      if (mission?.lifecycleState === "DISPATCHED") {
        this.edgeTransport?.sendCommand(command);
      }
    }
  }
}

/** Applies mission/robot query filters to domain event envelopes. */
function matchesEventFilters(
  event: EventEnvelopeV1,
  filters: { readonly missionId?: string; readonly robotId?: string }
): boolean {
  if (filters.missionId && !matchesValue(event, filters.missionId)) {
    return false;
  }
  if (filters.robotId && !matchesValue(event, filters.robotId)) {
    return false;
  }
  return true;
}

/** Applies mission/robot query filters to audit event records. */
function matchesAuditFilters(
  event: AuditEventV1,
  filters: { readonly missionId?: string; readonly robotId?: string }
): boolean {
  if (filters.missionId && event.missionId !== filters.missionId) {
    return false;
  }
  if (filters.robotId && event.robotId !== filters.robotId) {
    return false;
  }
  return true;
}

/** Checks aggregate id and shallow payload fields for event query matching. */
function matchesValue(event: EventEnvelopeV1, value: string): boolean {
  if (event.aggregateId === value) {
    return true;
  }
  const payload = event.payload;
  return payload["missionId"] === value || payload["robotId"] === value;
}
