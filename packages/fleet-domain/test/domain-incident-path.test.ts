import { describe, expect, it } from "vitest";

import {
  type CommandAckV1,
  type CommandEnvelopeV1,
  type CommandPayload,
  type MissionId,
  type RobotTelemetryEventV1,
  protocolSchemaVersions
} from "@roboops/fleet-protocol";
import { FakeClock, isoPlus } from "../../test-support/src/index.js";
import {
  type DispatchMissionCommandInput,
  type DomainState,
  applyCommandAck,
  applyMissionTimeout,
  beginReconnect,
  createInitialDomainState,
  dispatchMissionCommand,
  evaluateTelemetryFreshness,
  getMission,
  getRobot,
  ingestRobotTelemetry,
  processReconnectHandshake,
  requestMissionCancellation,
  upsertRobotSnapshot
} from "../src/index.js";

describe("domain incident path", () => {
  it("runs the normal command -> ack -> running path without API or storage", () => {
    const clock = new FakeClock();
    let state = seedOnlineRobot(createInitialDomainState(), clock);

    const dispatch = dispatchMissionCommand(state, missionRequest(clock));
    expect(dispatch.result.status).toBe("ACCEPTED");
    if (dispatch.result.status !== "ACCEPTED") {
      throw new Error("expected accepted dispatch");
    }

    state = dispatch.state;
    expect(dispatch.result.command.sequence).toBe(1);
    expect(dispatch.result.mission.lifecycleState).toBe("DISPATCHED");
    expect(dispatch.result.mission.targetPose).toEqual({
      x: 2,
      y: 4.5,
      theta: 1.57
    });

    const ack = applyCommandAck(
      state,
      commandAck(dispatch.result.command, clock.advanceSeconds(1))
    );
    expect(ack.result.status).toBe("PROCESSED");
    if (ack.result.status !== "PROCESSED") {
      throw new Error("expected processed ack");
    }

    expect(ack.result.mission.lifecycleState).toBe("RUNNING");
    expect(ack.result.mission.operationalStatus).toBe("NOMINAL");
    expect(ack.state.auditEvents.map((event) => event.action)).toContain(
      "mission.command.acked"
    );
  });

  it("degrades operational status for stale telemetry without failing lifecycle", () => {
    const { clock, command, state } = runningMission();

    const stale = evaluateTelemetryFreshness(state, {
      robotId: command.robotId,
      now: clock.advanceSeconds(11),
      correlationId: "corr-stale"
    });

    expect(stale.result.status).toBe("UPDATED");
    const mission = getMission(stale.state, command.missionId);
    const robot = getRobot(stale.state, command.robotId);
    expect(robot?.connectionState).toBe("DEGRADED");
    expect(mission?.lifecycleState).toBe("RUNNING");
    expect(mission?.operationalStatus).toBe("DEGRADED");

    const blocked = dispatchMissionCommand(
      stale.state,
      missionRequest(clock, {
        commandId: "cmd-risky-002",
        missionId: "mission-risky-002",
        idempotencyKey: "operator:test:mission-risky-002:create",
        now: clock.now(),
        issuedAt: clock.now(),
        expiresAt: isoPlus(clock.now(), 10_000)
      })
    );
    expect(blocked.result.status).toBe("REJECTED");
    if (blocked.result.status !== "REJECTED") {
      throw new Error("expected blocked command");
    }
    expect(blocked.result.reason).toBe("ROBOT_TELEMETRY_STALE");
    expect(blocked.result.mission?.lifecycleState).toBe("SAFETY_BLOCKED");
  });

  it("records command type and resulting lifecycle on cancel acknowledgements", () => {
    const { clock, command, state } = runningMission();
    const issuedAt = clock.advanceSeconds(1);
    const cancel = requestMissionCancellation(state, {
      commandId: "cmd-cancel-001",
      missionId: command.missionId,
      idempotencyKey: "operator:test:mission-test-001:cancel",
      issuedAt,
      expiresAt: isoPlus(issuedAt, 10_000),
      correlationId: "corr-cancel-001",
      causationId: "evt-cancel-001",
      reason: "operator test cancel",
      now: issuedAt
    });
    expect(cancel.result.status).toBe("ACCEPTED");
    if (cancel.result.status !== "ACCEPTED") {
      throw new Error("expected accepted cancel");
    }

    const ack = applyCommandAck(
      cancel.state,
      commandAck(cancel.result.command, clock.advanceSeconds(1))
    );
    expect(ack.result.status).toBe("PROCESSED");
    if (ack.result.status !== "PROCESSED") {
      throw new Error("expected processed cancel ack");
    }

    const ackEvent = ack.domainEvents.find(
      (event) => event.eventType === "mission.command.acked"
    );
    const ackAudit = ack.auditEvents.find(
      (event) => event.action === "mission.command.acked"
    );
    expect(ack.result.mission.lifecycleState).toBe("CANCELLED");
    expect(ackEvent?.payload).toMatchObject({
      commandType: "CANCEL_MISSION",
      lifecycleState: "CANCELLED"
    });
    expect(ackAudit?.details).toMatchObject({
      commandType: "CANCEL_MISSION",
      lifecycleState: "CANCELLED"
    });
  });

  it("handles duplicate operator requests deterministically", () => {
    const clock = new FakeClock();
    let state = seedOnlineRobot(createInitialDomainState(), clock);
    const request = missionRequest(clock);

    const first = dispatchMissionCommand(state, request);
    expect(first.result.status).toBe("ACCEPTED");
    if (first.result.status !== "ACCEPTED") {
      throw new Error("expected accepted dispatch");
    }
    state = first.state;

    const replay = dispatchMissionCommand(state, {
      ...request,
      commandId: "cmd-duplicate-replay"
    });
    expect(replay.result.status).toBe("IDEMPOTENT_REPLAY");
    if (replay.result.status !== "IDEMPOTENT_REPLAY") {
      throw new Error("expected idempotent replay");
    }
    expect(replay.result.command.commandId).toBe(first.result.command.commandId);
    expect(Object.keys(replay.state.commands)).toHaveLength(1);

    const conflict = dispatchMissionCommand(state, {
      ...request,
      commandId: "cmd-duplicate-conflict",
      payload: { target: { x: 9, y: 4.5, theta: 1.57 } }
    });
    expect(conflict.result.status).toBe("REJECTED");
    if (conflict.result.status !== "REJECTED") {
      throw new Error("expected idempotency conflict");
    }
    expect(conflict.result.reason).toBe("IDEMPOTENCY_KEY_REUSE_CONFLICT");
  });

  it("ignores duplicate edge events by event id", () => {
    const clock = new FakeClock();
    const state = createInitialDomainState();
    const telemetry = telemetryEvent(clock);

    const first = ingestRobotTelemetry(state, telemetry);
    expect(first.result.status).toBe("PROCESSED");
    if (first.result.status !== "PROCESSED") {
      throw new Error("expected telemetry to be processed");
    }
    expect(first.result.robot.pose).toEqual(telemetry.pose);

    const duplicate = ingestRobotTelemetry(first.state, telemetry);
    expect(duplicate.result.status).toBe("DUPLICATE_IGNORED");
    expect(duplicate.state.processedEventIds).toEqual([telemetry.eventId]);
    expect(duplicate.state.domainEvents).toHaveLength(first.state.domainEvents.length);
  });

  it("times out dispatched commands that expire before acknowledgement", () => {
    const clock = new FakeClock();
    let state = seedOnlineRobot(createInitialDomainState(), clock);
    const dispatch = dispatchMissionCommand(state, missionRequest(clock));
    expect(dispatch.result.status).toBe("ACCEPTED");
    if (dispatch.result.status !== "ACCEPTED") {
      throw new Error("expected accepted dispatch");
    }

    state = dispatch.state;
    const timeout = applyMissionTimeout(state, {
      missionId: dispatch.result.mission.missionId,
      now: clock.advanceSeconds(11),
      correlationId: "corr-timeout"
    });

    expect(timeout.result.status).toBe("TIMED_OUT");
    if (timeout.result.status !== "TIMED_OUT") {
      throw new Error("expected timeout");
    }
    expect(timeout.result.mission.lifecycleState).toBe("TIMED_OUT");
  });

  it("rejects already expired commands before dispatch", () => {
    const clock = new FakeClock();
    const state = seedOnlineRobot(createInitialDomainState(), clock);

    const rejected = dispatchMissionCommand(
      state,
      missionRequest(clock, {
        expiresAt: clock.now()
      })
    );

    expect(rejected.result.status).toBe("REJECTED");
    if (rejected.result.status !== "REJECTED") {
      throw new Error("expected expired command rejection");
    }
    expect(rejected.result.reason).toBe("COMMAND_EXPIRED");
    expect(rejected.result.mission?.lifecycleState).toBe("REJECTED");
  });

  it("blocks risky motion commands when battery is below threshold", () => {
    const clock = new FakeClock();
    const state = seedOnlineRobot(createInitialDomainState(), clock, {
      batteryPercent: 10
    });

    const blocked = dispatchMissionCommand(state, missionRequest(clock));
    expect(blocked.result.status).toBe("REJECTED");
    if (blocked.result.status !== "REJECTED") {
      throw new Error("expected low battery rejection");
    }
    expect(blocked.result.reason).toBe("LOW_BATTERY");
    expect(blocked.result.mission?.lifecycleState).toBe("SAFETY_BLOCKED");
  });

  it("reconciles a reconnect when cloud and edge agree on the running mission", () => {
    const { clock, command, state } = runningMission();

    const reconnecting = beginReconnect(state, {
      robotId: command.robotId,
      now: clock.advanceSeconds(4),
      correlationId: "corr-reconnect-start"
    });
    expect(reconnecting.result.status).toBe("PROCESSED");
    const reconnectingMission = getMission(reconnecting.state, command.missionId);
    expect(reconnectingMission?.operationalStatus).toBe("RECONNECTING");

    const reconciled = processReconnectHandshake(
      reconnecting.state,
      {
        schemaVersion: protocolSchemaVersions.reconnectHandshake,
        robotId: command.robotId,
        edgeSessionId: "edge-session-ok",
        connectedAt: clock.advanceSeconds(1),
        lastSeenCommandSequence: command.sequence,
        lastAcknowledgedCommandId: command.commandId,
        reportedMissionId: command.missionId,
        reportedMissionLifecycleState: "RUNNING",
        lastTelemetryObservedAt: clock.now(),
        edgeAgentVersion: "0.1.0"
      },
      { correlationId: "corr-reconnect-ok" }
    );

    expect(reconciled.result.status).toBe("PROCESSED");
    if (reconciled.result.status !== "PROCESSED") {
      throw new Error("expected processed handshake");
    }
    expect(reconciled.result.reconciliation.outcome).toBe("RESUME_RUNNING");
    expect(reconciled.result.mission?.lifecycleState).toBe("RUNNING");
    expect(reconciled.result.mission?.operationalStatus).toBe("RECOVERED");
    expect(getRobot(reconciled.state, command.robotId)?.connectionState).toBe("ONLINE");
  });

  it("moves to manual review when reconnect reports a conflicting mission", () => {
    const { clock, command, state } = runningMission();
    const reconnecting = beginReconnect(state, {
      robotId: command.robotId,
      now: clock.advanceSeconds(4),
      correlationId: "corr-conflict-start"
    });

    const conflicted = processReconnectHandshake(
      reconnecting.state,
      {
        schemaVersion: protocolSchemaVersions.reconnectHandshake,
        robotId: command.robotId,
        edgeSessionId: "edge-session-conflict",
        connectedAt: clock.advanceSeconds(1),
        lastSeenCommandSequence: command.sequence,
        lastAcknowledgedCommandId: command.commandId,
        reportedMissionId: "mission-unknown",
        reportedMissionLifecycleState: "RUNNING",
        lastTelemetryObservedAt: clock.now(),
        edgeAgentVersion: "0.1.0"
      },
      { correlationId: "corr-reconnect-conflict" }
    );

    expect(conflicted.result.status).toBe("PROCESSED");
    if (conflicted.result.status !== "PROCESSED") {
      throw new Error("expected processed handshake");
    }
    expect(conflicted.result.reconciliation.outcome).toBe("MANUAL_REVIEW");
    expect(conflicted.result.mission?.lifecycleState).toBe("MANUAL_REVIEW");
    expect(getRobot(conflicted.state, command.robotId)?.connectionState).toBe(
      "DEGRADED"
    );
  });
});

function runningMission(): {
  readonly clock: FakeClock;
  readonly command: CommandEnvelopeV1;
  readonly state: DomainState;
} {
  const clock = new FakeClock();
  let state = seedOnlineRobot(createInitialDomainState(), clock);
  const dispatch = dispatchMissionCommand(state, missionRequest(clock));
  if (dispatch.result.status !== "ACCEPTED") {
    throw new Error("expected accepted dispatch");
  }
  state = dispatch.state;

  const ack = applyCommandAck(
    state,
    commandAck(dispatch.result.command, clock.advanceSeconds(1))
  );
  if (ack.result.status !== "PROCESSED") {
    throw new Error("expected processed ack");
  }

  return { clock, command: dispatch.result.command, state: ack.state };
}

function seedOnlineRobot(
  state: DomainState,
  clock: FakeClock,
  overrides: Partial<{
    readonly batteryPercent: number;
  }> = {}
): DomainState {
  return upsertRobotSnapshot(state, {
    robotId: "robot-a",
    connectionState: "ONLINE",
    updatedAt: clock.now(),
    health: "OK",
    batteryPercent: overrides.batteryPercent ?? 80,
    lastTelemetryObservedAt: clock.now(),
    lastTelemetryReceivedAt: clock.now(),
    lastSeenCommandSequence: 0,
    edgeAgentVersion: "0.1.0"
  });
}

function missionRequest(
  clock: FakeClock,
  overrides: Partial<DispatchMissionCommandInput> = {}
): DispatchMissionCommandInput {
  const issuedAt = overrides.issuedAt ?? clock.now();
  return {
    commandId: "cmd-test-001",
    missionId: "mission-test-001",
    robotId: "robot-a",
    type: "GO_TO_POSE",
    idempotencyKey: "operator:test:mission-test-001:create",
    issuedAt,
    expiresAt: overrides.expiresAt ?? isoPlus(issuedAt, 10_000),
    correlationId: "corr-test-001",
    causationId: "evt-test-001",
    payload: overrides.payload ?? goToPosePayload(),
    now: overrides.now ?? clock.now(),
    requiresAck: overrides.requiresAck,
    safetyClass: overrides.safetyClass,
    ...overrides
  };
}

function commandAck(command: CommandEnvelopeV1, receivedAt: string): CommandAckV1 {
  return {
    schemaVersion: protocolSchemaVersions.commandAck,
    ackId: `ack-${command.commandId}`,
    commandId: command.commandId,
    missionId: command.missionId,
    robotId: command.robotId,
    status: "ACCEPTED",
    receivedAt,
    lastSeenCommandSequence: command.sequence,
    correlationId: command.correlationId,
    causationId: command.commandId
  };
}

function telemetryEvent(clock: FakeClock): RobotTelemetryEventV1 {
  return {
    schemaVersion: protocolSchemaVersions.robotTelemetry,
    eventId: "evt-telemetry-001",
    robotId: "robot-a",
    observedAt: clock.now(),
    receivedAt: clock.now(),
    pose: { x: 1, y: 2, theta: 0.5 },
    batteryPercent: 80,
    health: "OK",
    connectionState: "ONLINE",
    lastSeenCommandSequence: 0,
    edgeAgentVersion: "0.1.0"
  };
}

function goToPosePayload(): CommandPayload {
  return {
    target: {
      x: 2,
      y: 4.5,
      theta: 1.57
    }
  };
}
