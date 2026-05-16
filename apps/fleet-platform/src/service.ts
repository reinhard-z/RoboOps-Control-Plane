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
import type { DomainStateRepository } from "@roboops/fleet-persistence";

import { PlatformEventHub } from "./event-hub.js";
import { createPlatformId, isoPlus } from "./ids.js";
import type { StructuredLogger } from "./logging.js";
import type { FleetPlatformMetrics } from "./metrics.js";
import { createSeededDomainState } from "./repository.js";
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

/** Coordinates HTTP/edge requests with the pure domain reducers and repository boundary. */
export class FleetPlatformService {
  private edgeTransport: EdgeCommandTransport | undefined;

  constructor(
    private readonly repository: DomainStateRepository,
    private readonly eventHub: PlatformEventHub,
    private readonly logger: StructuredLogger,
    private readonly config: FleetPlatformConfig,
    private readonly metrics: FleetPlatformMetrics
  ) {}

  setEdgeTransport(edgeTransport: EdgeCommandTransport): void {
    this.edgeTransport = edgeTransport;
  }

  async createMission(
    request: CreateMissionRequest,
    context: RequestContext
  ): Promise<MissionCommandServiceResult> {
    await this.evaluateKnownRobotFreshness(request.robotId, context);

    const input = this.toDispatchInput(request, context);
    this.logger.info("mission command requested", {
      correlationId: context.correlationId,
      causationId: context.causationId,
      missionId: input.missionId,
      commandId: input.commandId,
      robotId: input.robotId,
      commandType: input.type,
      safetyClass: input.safetyClass
    });
    const transition = await this.applyTransition((state) =>
      dispatchMissionCommand(state, input)
    );

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

  async cancelMission(
    missionId: string,
    request: CancelMissionRequest,
    context: RequestContext
  ): Promise<MissionCommandServiceResult | undefined> {
    const commandId = request.commandId ?? createPlatformId("cmd");
    const idempotencyKey =
      request.idempotencyKey ?? `operator:cancel:${missionId}:${context.correlationId}`;
    const expiresAt = isoPlus(
      context.now,
      request.expiresInMs ?? this.config.defaultCommandTtlMs
    );
    this.logger.info("mission command requested", {
      correlationId: context.correlationId,
      causationId: context.causationId,
      missionId,
      commandId,
      commandType: "CANCEL_MISSION"
    });
    const transition = await this.repository.update((state) => {
      const mission = getMission(state, missionId);
      if (!mission) {
        return { state, result: undefined };
      }
      const cancellation = requestMissionCancellation(state, {
        commandId,
        missionId,
        idempotencyKey,
        issuedAt: context.now,
        expiresAt,
        correlationId: context.correlationId,
        causationId: context.causationId,
        reason: request.reason,
        now: context.now
      });
      return { state: cancellation.state, result: cancellation };
    });

    if (!transition) {
      return undefined;
    }
    this.publishTransitionRecords(transition);

    const deliveryCount =
      transition.result.status === "ACCEPTED"
        ? this.edgeTransport?.sendCommand(transition.result.command) ?? 0
        : 0;

    this.logger.info("mission cancellation request handled", {
      correlationId: context.correlationId,
      missionId,
      robotId: transition.result.mission?.robotId,
      resultStatus: transition.result.status,
      deliveryCount
    });

    return { result: transition.result, deliveryCount };
  }

  async evaluateAllRobotFreshness(context: RequestContext): Promise<readonly unknown[]> {
    const robotIds = Object.keys((await this.repository.read()).robots);
    const results: unknown[] = [];
    for (const robotId of robotIds) {
      results.push(await this.evaluateKnownRobotFreshness(robotId, context));
    }
    return results;
  }

  async evaluateKnownRobotFreshness(
    robotId: RobotId,
    context: RequestContext
  ): Promise<unknown> {
    const robot = getRobot(await this.repository.read(), robotId);
    if (!robot) {
      return { status: "UNKNOWN_ROBOT" };
    }

    return this.evaluateRobotFreshness(robotId, context);
  }

  async handleEdgeConnected(
    robotId: RobotId,
    hello: EdgeHelloPayload | undefined,
    context: RequestContext
  ): Promise<void> {
    await this.repository.update((state) => {
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

      return {
        state: upsertRobotSnapshot(state, nextRobot),
        result: undefined
      };
    });
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
    await this.deliverPendingCommands(robotId);
  }

  async handleEdgeDisconnected(robotId: RobotId, context: RequestContext): Promise<void> {
    await this.applyTransition((state) =>
      beginReconnect(state, {
        robotId,
        now: context.now,
        correlationId: context.correlationId
      })
    );
    this.eventHub.publish(
      "platform",
      { eventType: "edge.disconnected", robotId },
      context.now
    );
  }

  async handleEdgeMessage(
    robotId: RobotId,
    message: EdgeWireMessage,
    context: RequestContext
  ): Promise<void> {
    if (message.type === "edge.hello") {
      await this.handleEdgeConnected(robotId, message.payload, context);
      return;
    }

    if (message.type === "edge.command_ack") {
      const transition = await this.applyTransition((state) =>
        applyCommandAck(state, message.payload)
      );
      this.logger.info("command ack processed", {
        correlationId: context.correlationId,
        causationId: context.causationId,
        ackId: message.payload.ackId,
        commandId: message.payload.commandId,
        missionId: message.payload.missionId,
        robotId: message.payload.robotId,
        ackStatus: message.payload.status,
        resultStatus: transition.result.status
      });
      return;
    }

    if (message.type === "edge.telemetry") {
      await this.applyTransition((state) => ingestRobotTelemetry(state, message.payload));
      return;
    }

    const robot = getRobot(await this.repository.read(), message.payload.robotId);
    if (robot && robot.connectionState !== "RECONNECTING") {
      await this.applyTransition((state) =>
        beginReconnect(state, {
          robotId: message.payload.robotId,
          now: context.now,
          correlationId: context.correlationId
        })
      );
    }
    await this.applyTransition((state) =>
      processReconnectHandshake(state, message.payload, {
        now: context.now,
        correlationId: context.correlationId
      })
    );
  }

  async evaluateRobotFreshness(
    robotId: RobotId,
    context: RequestContext
  ): Promise<unknown> {
    const transition = await this.applyTransition((state) =>
      evaluateTelemetryFreshness(state, {
        robotId,
        now: context.now,
        correlationId: context.correlationId
      })
    );
    if (
      transition.result.status === "UPDATED" &&
      transition.result.robot.connectionState !== "ONLINE"
    ) {
      this.metrics.recordTelemetryFreshnessDegradation({
        previousConnectionState: transition.result.previousConnectionState,
        connectionState: transition.result.robot.connectionState
      });
      this.logger.warn("telemetry freshness degraded", {
        correlationId: context.correlationId,
        robotId,
        missionId: transition.result.robot.activeMissionId,
        previousConnectionState: transition.result.previousConnectionState,
        connectionState: transition.result.robot.connectionState
      });
    }
    return transition.result;
  }

  async resetDemo(context: RequestContext): Promise<DomainState> {
    const nextState = createSeededDomainState(this.config.demoRobotId, context.now);
    await this.repository.reset(nextState);
    this.eventHub.publish(
      "platform",
      { eventType: "demo.reset", robotId: this.config.demoRobotId },
      context.now
    );
    return nextState;
  }

  startIncident(context: RequestContext): Promise<MissionCommandServiceResult> {
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

  async disconnectDemoRobot(context: RequestContext): Promise<unknown> {
    const staleAt = new Date(Date.parse(context.now) - 11_000).toISOString();
    await this.repository.update((state) => {
      const robot = state.robots[this.config.demoRobotId];
      if (!robot) {
        return { state, result: undefined };
      }
      return {
        state: upsertRobotSnapshot(state, {
          ...robot,
          connectionState: "ONLINE",
          lastTelemetryObservedAt: staleAt,
          lastTelemetryReceivedAt: staleAt
        }),
        result: undefined
      };
    });
    return this.evaluateRobotFreshness(this.config.demoRobotId, context);
  }

  async reconnectDemoRobot(context: RequestContext): Promise<unknown> {
    const state = await this.repository.read();
    const robot = state.robots[this.config.demoRobotId];
    if (!robot) {
      return { status: "UNKNOWN_ROBOT" };
    }

    const reconnectStart = await this.applyTransition((currentState) =>
      beginReconnect(currentState, {
        robotId: robot.robotId,
        now: context.now,
        correlationId: context.correlationId
      })
    );

    const nextState = await this.repository.read();
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
    const reconciled = await this.applyTransition((currentState) =>
      processReconnectHandshake(currentState, handshake, {
        now: context.now,
        correlationId: context.correlationId
      })
    );
    return reconciled.result;
  }

  duplicateDemoCommand(context: RequestContext): Promise<MissionCommandServiceResult> {
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

  async lowBatteryDemo(context: RequestContext): Promise<MissionCommandServiceResult> {
    await this.repository.update((state) => {
      const robot = state.robots[this.config.demoRobotId];
      if (!robot) {
        return { state, result: undefined };
      }
      return {
        state: upsertRobotSnapshot(state, {
          ...robot,
          batteryPercent: 10,
          updatedAt: context.now
        }),
        result: undefined
      };
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

  getState(): Promise<DomainState> {
    return this.repository.read();
  }

  async listMissions(): Promise<readonly unknown[]> {
    return Object.values((await this.repository.read()).missions);
  }

  async getMission(missionId: string): Promise<unknown | undefined> {
    return (await this.repository.read()).missions[missionId];
  }

  async listRobots(): Promise<readonly unknown[]> {
    return Object.values((await this.repository.read()).robots);
  }

  async getRobot(robotId: string): Promise<unknown | undefined> {
    return (await this.repository.read()).robots[robotId];
  }

  async listEvents(filters: {
    readonly missionId?: string;
    readonly robotId?: string;
  }): Promise<readonly EventEnvelopeV1[]> {
    return (await this.repository.read()).domainEvents.filter((event) =>
      matchesEventFilters(event, filters)
    );
  }

  async listAuditEvents(filters: {
    readonly missionId?: string;
    readonly robotId?: string;
  }): Promise<readonly AuditEventV1[]> {
    return (await this.repository.read()).auditEvents.filter((event) =>
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

  /** Applies a reducer transition through the repository update callback. */
  private async applyTransition<TResult>(
    reducer: (state: DomainState) => DomainTransition<TResult>
  ): Promise<DomainTransition<TResult>> {
    const transition = await this.repository.update((state) => {
      const nextTransition = reducer(state);
      return { state: nextTransition.state, result: nextTransition };
    });

    this.publishTransitionRecords(transition);
    return transition;
  }

  /** Streams reducer-produced event records after state has been persisted. */
  private publishTransitionRecords<TResult>(
    transition: DomainTransition<TResult>
  ): void {
    for (const event of transition.domainEvents) {
      this.eventHub.publish("domain", event, event.receivedAt);
      this.metrics.recordDomainEvent(event.eventType);
      this.logIncidentDomainTransition(event);
      this.logger.info("domain event emitted", {
        eventType: event.eventType,
        correlationId: event.correlationId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId
      });
    }
    for (const event of transition.auditEvents) {
      this.eventHub.publish("audit", event, event.occurredAt);
      this.metrics.recordAuditEvent(event.action);
      this.logger.info("audit event emitted", {
        action: event.action,
        correlationId: event.correlationId,
        missionId: event.missionId,
        commandId: event.commandId,
        robotId: event.robotId
      });
    }
  }

  /** Emits concise incident-story logs for important reducer-produced transitions. */
  private logIncidentDomainTransition(event: EventEnvelopeV1): void {
    if (event.eventType === "mission.command.dispatched") {
      this.logger.info("mission command accepted", {
        eventType: event.eventType,
        correlationId: event.correlationId,
        causationId: event.causationId,
        missionId: event.aggregateId,
        commandId: readPayloadString(event.payload, "commandId"),
        robotId: readPayloadString(event.payload, "robotId")
      });
      return;
    }

    if (event.eventType === "mission.command.rejected") {
      this.logger.warn("mission command rejected", {
        eventType: event.eventType,
        correlationId: event.correlationId,
        causationId: event.causationId,
        missionId: event.aggregateId,
        reason: readPayloadString(event.payload, "reason")
      });
      return;
    }

    if (event.eventType === "mission.cancel.requested") {
      this.logger.info("mission command accepted", {
        eventType: event.eventType,
        correlationId: event.correlationId,
        causationId: event.causationId,
        missionId: event.aggregateId,
        commandId: readPayloadString(event.payload, "commandId"),
        robotId: readPayloadString(event.payload, "robotId"),
        commandType: "CANCEL_MISSION"
      });
      return;
    }

    if (event.eventType === "mission.cancel.rejected") {
      this.logger.warn("mission command rejected", {
        eventType: event.eventType,
        correlationId: event.correlationId,
        causationId: event.causationId,
        missionId: event.aggregateId,
        reason: readPayloadString(event.payload, "reason"),
        commandType: "CANCEL_MISSION"
      });
      return;
    }

    if (event.eventType === "robot.reconnect.started") {
      this.logger.warn("reconnect started", {
        eventType: event.eventType,
        correlationId: event.correlationId,
        robotId: event.aggregateId,
        previousConnectionState: readPayloadString(
          event.payload,
          "previousConnectionState"
        )
      });
      return;
    }

    if (event.eventType === "mission.reconciliation.completed") {
      const outcome = readPayloadString(event.payload, "outcome");
      this.logger[outcome === "MANUAL_REVIEW" ? "warn" : "info"](
        outcome === "MANUAL_REVIEW"
          ? "reconnect manual review required"
          : "reconnect resolved",
        {
          eventType: event.eventType,
          correlationId: event.correlationId,
          causationId: event.causationId,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          outcome,
          robotId: readPayloadString(event.payload, "robotId"),
          reportedMissionId: readPayloadString(event.payload, "reportedMissionId")
        }
      );
    }
  }

  /** Redelivers still-dispatched commands when an edge reconnects after the HTTP request. */
  private async deliverPendingCommands(robotId: RobotId): Promise<void> {
    const state = await this.repository.read();
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

/** Reads string-like event payload fields without copying whole payloads into logs. */
function readPayloadString(
  payload: Readonly<Record<string, unknown>>,
  key: string
): string | undefined {
  const value = payload[key];
  if (typeof value === "string") {
    return value;
  }
  return value === null || value === undefined ? undefined : String(value);
}
