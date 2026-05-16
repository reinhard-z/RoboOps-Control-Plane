import { describe, expect, it } from "vitest";

import type { MissionSnapshot, RobotSnapshot } from "../src/types.js";
import {
  apiStatusSummary,
  emptyEventFeedText,
  emptyMissionListText,
  formatCancelRejectionMessage,
  formatCommandRejectionMessage,
  formatMissionFailureReason,
  formatRelativeTime,
  missionCreationAvailability,
  missionStateKind,
  missionStateSummary,
  parsePoseNumber,
  robotConnectionSummary,
  selectDefaultMission,
  statusToneForMission,
  statusToneForConnection,
  summarizeStreamEvent,
  telemetryAgeMs
} from "../src/view-model.js";

const now = Date.parse("2026-05-15T12:00:00.000Z");

describe("operator UI view model", () => {
  it("summarizes API availability without transport internals", () => {
    expect(apiStatusSummary("CHECKING")).toMatchObject({
      label: "API checking",
      tone: "neutral"
    });
    expect(apiStatusSummary("AVAILABLE")).toMatchObject({
      label: "API available",
      tone: "online"
    });
    expect(apiStatusSummary("UNAVAILABLE")).toMatchObject({
      label: "API unavailable",
      detail: "Check Fleet Platform, the API URL, and CORS settings",
      tone: "danger"
    });
  });

  it("maps robot connection states to distinct tones", () => {
    expect(statusToneForConnection("ONLINE")).toBe("online");
    expect(statusToneForConnection("STALE")).toBe("stale");
    expect(statusToneForConnection("DEGRADED")).toBe("degraded");
    expect(statusToneForConnection("OFFLINE")).toBe("offline");
    expect(statusToneForConnection("RECONNECTING")).toBe("reconnecting");
  });

  it("summarizes simulator connection states for operator copy", () => {
    expect(robotConnectionSummary(undefined, now)).toMatchObject({
      label: "UNKNOWN",
      detail: "No robot snapshot from Fleet Platform yet",
      tone: "neutral"
    });
    expect(
      robotConnectionSummary(
        {
          robotId: "robot-a",
          connectionState: "DEGRADED",
          updatedAt: "2026-05-15T12:00:00.000Z",
          lastTelemetryReceivedAt: "2026-05-15T11:59:49.000Z",
          lastSeenCommandSequence: 1
        },
        now
      )
    ).toMatchObject({
      label: "DEGRADED",
      detail: "Simulator disconnected or telemetry stalled",
      tone: "degraded"
    });
    expect(
      robotConnectionSummary(
        {
          robotId: "robot-a",
          connectionState: "RECONNECTING",
          updatedAt: "2026-05-15T12:00:00.000Z",
          lastSeenCommandSequence: 1
        },
        now
      )
    ).toMatchObject({
      detail: "Reconnect reconciliation in progress",
      tone: "reconnecting"
    });
  });

  it("uses explicit empty states for mission and event panels", () => {
    expect(emptyMissionListText()).toBe("No missions yet");
    expect(emptyEventFeedText()).toBe("No events yet");
  });

  it("keeps selected mission stable before falling back to active robot mission", () => {
    const missions = [
      mission("mission-new", "2026-05-15T11:59:00.000Z"),
      mission("mission-active", "2026-05-15T11:58:00.000Z")
    ];
    const robot: RobotSnapshot = {
      robotId: "robot-a",
      connectionState: "ONLINE",
      updatedAt: "2026-05-15T12:00:00.000Z",
      activeMissionId: "mission-active",
      lastSeenCommandSequence: 1
    };

    expect(selectDefaultMission(missions, robot, "mission-new")?.missionId).toBe(
      "mission-new"
    );
    expect(selectDefaultMission(missions, robot, undefined)?.missionId).toBe(
      "mission-active"
    );
  });

  it("blocks create mission controls when the robot already owns active work", () => {
    const robot: RobotSnapshot = {
      robotId: "robot-a",
      connectionState: "ONLINE",
      updatedAt: "2026-05-15T12:00:00.000Z",
      activeMissionId: "mission-active",
      lastSeenCommandSequence: 1
    };

    const availability = missionCreationAvailability(
      [mission("mission-active", "2026-05-15T11:58:00.000Z")],
      robot
    );

    expect(availability.canCreate).toBe(false);
    expect(availability.buttonLabel).toBe("Active Mission In Progress");
    expect(availability.blockingMissionId).toBe("mission-active");
    expect(availability.message).toContain("mission-active");
  });

  it("allows new missions when the recorded active mission is already terminal", () => {
    const robot: RobotSnapshot = {
      robotId: "robot-a",
      connectionState: "ONLINE",
      updatedAt: "2026-05-15T12:00:00.000Z",
      activeMissionId: "mission-old",
      lastSeenCommandSequence: 1
    };

    const availability = missionCreationAvailability(
      [
        mission("mission-old", "2026-05-15T11:58:00.000Z", {
          lifecycleState: "SUCCEEDED"
        })
      ],
      robot
    );

    expect(availability.canCreate).toBe(true);
    expect(availability.buttonLabel).toBe("Create Mission");
  });

  it("converts dispatch rejection reasons into operator-facing copy", () => {
    expect(formatCommandRejectionMessage("ROBOT_ALREADY_ASSIGNED")).toBe(
      "The robot already has an active mission. Cancel or finish the active mission before creating another GO_TO_POSE."
    );
    expect(formatCommandRejectionMessage("LOW_BATTERY")).toBe(
      "Mission request rejected: The robot battery is below the safety threshold."
    );
  });

  it("converts cancel rejection reasons into operator-facing copy", () => {
    expect(formatCancelRejectionMessage("MISSION_NOT_ACTIVE")).toBe(
      "The selected mission is no longer active. Refreshing mission state may show the terminal outcome."
    );
    expect(formatCancelRejectionMessage("IDEMPOTENCY_KEY_REUSE_CONFLICT")).toBe(
      "Cancel request rejected: The cancel request was retried with different mission details."
    );
  });

  it("classifies selected mission states for detail views", () => {
    const active = mission("mission-active", "2026-05-15T11:58:00.000Z", {
      lifecycleState: "CANCEL_REQUESTED",
      operationalStatus: "RECONNECTING"
    });
    const blocked = mission("mission-blocked", "2026-05-15T11:58:00.000Z", {
      lifecycleState: "SAFETY_BLOCKED"
    });
    const review = mission("mission-review", "2026-05-15T11:58:00.000Z", {
      lifecycleState: "MANUAL_REVIEW"
    });
    const terminal = mission("mission-cancelled", "2026-05-15T11:58:00.000Z", {
      lifecycleState: "CANCELLED"
    });

    expect(missionStateKind(active.lifecycleState)).toBe("active");
    expect(missionStateSummary(active)).toMatchObject({
      label: "ACTIVE",
      detail: "Cancel requested; waiting for edge acknowledgement",
      tone: "reconnecting"
    });
    expect(missionStateSummary(blocked)).toMatchObject({
      kind: "blocked",
      label: "BLOCKED"
    });
    expect(missionStateSummary(review)).toMatchObject({
      kind: "manual-review",
      label: "MANUAL REVIEW"
    });
    expect(missionStateSummary(terminal)).toMatchObject({
      kind: "terminal",
      label: "TERMINAL"
    });
    expect(statusToneForMission(terminal)).toBe("offline");
  });

  it("explains blocked and rejected mission reasons when rows expose them", () => {
    expect(
      formatMissionFailureReason(
        mission("mission-blocked", "2026-05-15T11:58:00.000Z", {
          lifecycleState: "SAFETY_BLOCKED",
          failureReason: "ROBOT_TELEMETRY_STALE"
        })
      )
    ).toBe("The robot telemetry is stale");

    expect(
      formatMissionFailureReason(
        mission("mission-blocked", "2026-05-15T11:58:00.000Z", {
          lifecycleState: "SAFETY_BLOCKED"
        })
      )
    ).toBe("Blocked by platform safety policy");
  });

  it("formats relative timestamps and telemetry age for live freshness", () => {
    expect(formatRelativeTime("2026-05-15T11:59:50.000Z", now)).toBe("10s ago");
    expect(formatRelativeTime("2026-05-15T11:57:00.000Z", now)).toBe("3m ago");
    expect(
      telemetryAgeMs(
        {
          robotId: "robot-a",
          connectionState: "ONLINE",
          updatedAt: "2026-05-15T12:00:00.000Z",
          lastTelemetryReceivedAt: "2026-05-15T11:59:55.000Z",
          lastSeenCommandSequence: 1
        },
        now
      )
    ).toBe(5_000);
  });

  it("falls back for blank or invalid pose input without coercing blanks to zero", () => {
    expect(parsePoseNumber("", 1.57)).toBe(1.57);
    expect(parsePoseNumber("   ", 2)).toBe(2);
    expect(parsePoseNumber("not-a-number", 4.5)).toBe(4.5);
    expect(parsePoseNumber("0", 4.5)).toBe(0);
  });

  it("summarizes mission command progress into operator feed rows", () => {
    const created = summarizeStreamEvent({
      streamEventId: "stream-created",
      type: "audit",
      occurredAt: "2026-05-15T12:00:00.000Z",
      data: {
        action: "mission.command.created",
        missionId: "mission-a",
        robotId: "robot-a",
        commandId: "cmd-a",
        details: { commandType: "GO_TO_POSE", sequence: 1 }
      }
    });
    const dispatched = summarizeStreamEvent({
      streamEventId: "stream-dispatched",
      type: "domain",
      occurredAt: "2026-05-15T12:00:01.000Z",
      data: {
        eventType: "mission.command.dispatched",
        aggregateType: "mission",
        aggregateId: "mission-a",
        payload: { robotId: "robot-a", commandId: "cmd-a", sequence: 1 }
      }
    });
    const acked = summarizeStreamEvent({
      streamEventId: "stream-acked",
      type: "audit",
      occurredAt: "2026-05-15T12:00:02.000Z",
      data: {
        action: "mission.command.acked",
        missionId: "mission-a",
        robotId: "robot-a",
        commandId: "cmd-a",
        details: {
          commandType: "GO_TO_POSE",
          lifecycleState: "RUNNING",
          status: "ACCEPTED",
          sequence: 1
        }
      }
    });
    const running = summarizeStreamEvent({
      streamEventId: "stream-running",
      type: "domain",
      occurredAt: "2026-05-15T12:00:03.000Z",
      data: {
        eventType: "mission.running",
        aggregateType: "mission",
        aggregateId: "mission-a",
        payload: { robotId: "robot-a" }
      }
    });

    expect(created).toMatchObject({
      title: "Mission command created",
      detail: "Created · Go To Pose · mission mission-a · robot robot-a · command cmd-a · seq 1",
      tone: "neutral"
    });
    expect(dispatched).toMatchObject({
      title: "Mission command dispatched",
      detail: "Sent to edge · mission mission-a · robot robot-a · command cmd-a · seq 1",
      tone: "online"
    });
    expect(acked).toMatchObject({
      title: "Mission running",
      detail: "Edge accepted command · Go To Pose · mission mission-a · robot robot-a · command cmd-a · seq 1",
      tone: "online"
    });
    expect(running).toMatchObject({
      title: "Mission running",
      detail: "Telemetry confirms active work · mission mission-a · robot robot-a",
      tone: "online"
    });
  });

  it("summarizes cancel and safety-block events with operator reasons", () => {
    const cancelRequested = summarizeStreamEvent({
      streamEventId: "stream-cancel",
      type: "audit",
      occurredAt: "2026-05-15T12:00:00.000Z",
      data: {
        action: "mission.cancel.requested",
        missionId: "mission-a",
        robotId: "robot-a",
        commandId: "cmd-cancel",
        details: { reason: "operator requested cancel from UI", sequence: 2 }
      }
    });
    const cancelRejected = summarizeStreamEvent({
      streamEventId: "stream-cancel-rejected",
      type: "domain",
      occurredAt: "2026-05-15T12:00:01.000Z",
      data: {
        eventType: "mission.cancel.rejected",
        aggregateType: "mission",
        aggregateId: "mission-a",
        payload: { reason: "MISSION_NOT_ACTIVE" }
      }
    });
    const cancelAcked = summarizeStreamEvent({
      streamEventId: "stream-cancel-acked",
      type: "audit",
      occurredAt: "2026-05-15T12:00:02.000Z",
      data: {
        action: "mission.command.acked",
        missionId: "mission-a",
        robotId: "robot-a",
        commandId: "cmd-cancel",
        details: {
          commandType: "CANCEL_MISSION",
          lifecycleState: "CANCELLED",
          status: "ACCEPTED",
          sequence: 2
        }
      }
    });
    const safetyBlocked = summarizeStreamEvent({
      streamEventId: "stream-blocked",
      type: "domain",
      occurredAt: "2026-05-15T12:00:02.000Z",
      data: {
        eventType: "mission.command.rejected",
        aggregateType: "mission",
        aggregateId: "mission-blocked",
        payload: {
          robotId: "robot-a",
          reason: "ROBOT_TELEMETRY_STALE"
        }
      }
    });

    expect(cancelRequested).toMatchObject({
      title: "Mission cancel requested",
      detail: "Cancel sent to edge · mission mission-a · robot robot-a · command cmd-cancel · seq 2",
      tone: "reconnecting"
    });
    expect(cancelRejected.title).toBe("Mission cancel rejected");
    expect(cancelRejected.detail).toContain(
      "reason: The selected mission is no longer active"
    );
    expect(cancelRejected.tone).toBe("danger");
    expect(cancelAcked).toMatchObject({
      title: "Mission cancelled",
      detail: "Cancellation accepted by edge · Cancel Mission · mission mission-a · robot robot-a · command cmd-cancel · seq 2",
      tone: "offline"
    });
    expect(safetyBlocked).toMatchObject({
      title: "Mission safety blocked",
      detail: "Blocked before dispatch · mission mission-blocked · robot robot-a · reason: The robot telemetry is stale",
      tone: "degraded"
    });
  });

  it("summarizes telemetry, edge, and reconnect reconciliation events", () => {
    const telemetry = summarizeStreamEvent({
      streamEventId: "stream-telemetry",
      type: "domain",
      occurredAt: "2026-05-15T12:00:00.000Z",
      data: {
        eventType: "robot.telemetry.received",
        aggregateType: "robot",
        aggregateId: "robot-a",
        payload: {
          batteryPercent: 74.4,
          connectionState: "ONLINE",
          currentMissionId: "mission-a"
        },
        details: { health: "OK" }
      }
    });
    const degraded = summarizeStreamEvent({
      streamEventId: "stream-1",
      type: "domain",
      occurredAt: "2026-05-15T12:00:00.000Z",
      data: {
        eventType: "robot.connection.freshness_changed",
        aggregateId: "robot-a",
        payload: {
          previousConnectionState: "STALE",
          connectionState: "DEGRADED"
        }
      }
    });
    const edgeDisconnected = summarizeStreamEvent({
      streamEventId: "stream-edge",
      type: "platform",
      occurredAt: "2026-05-15T12:00:01.000Z",
      data: {
        eventType: "edge.disconnected",
        robotId: "robot-a"
      }
    });
    const reconnectStarted = summarizeStreamEvent({
      streamEventId: "stream-reconnect",
      type: "audit",
      occurredAt: "2026-05-15T12:00:02.000Z",
      data: {
        action: "robot.reconnect.started",
        missionId: "mission-a",
        robotId: "robot-a",
        details: { previousConnectionState: "DEGRADED" }
      }
    });
    const recovered = summarizeStreamEvent({
      streamEventId: "stream-recovered",
      type: "domain",
      occurredAt: "2026-05-15T12:00:03.000Z",
      data: {
        eventType: "mission.reconciliation.completed",
        aggregateType: "mission",
        aggregateId: "mission-a",
        payload: {
          outcome: "RESUME_RUNNING",
          reason: "cloud and robot mission state match",
          robotId: "robot-a"
        }
      }
    });
    const manualReview = summarizeStreamEvent({
      streamEventId: "stream-review",
      type: "audit",
      occurredAt: "2026-05-15T12:00:04.000Z",
      data: {
        action: "mission.reconciliation.completed",
        missionId: "mission-a",
        robotId: "robot-a",
        details: {
          outcome: "MANUAL_REVIEW",
          reason: "reconnect handshake has an unexplained command sequence gap",
          lastSeenCommandSequence: 7
        }
      }
    });

    expect(telemetry).toMatchObject({
      title: "Robot telemetry received",
      detail: "robot robot-a · ONLINE · health OK · battery 74% · mission mission-a",
      tone: "online"
    });
    expect(degraded).toMatchObject({
      title: "Robot telemetry degraded",
      detail: "robot robot-a · STALE -> DEGRADED",
      tone: "degraded"
    });
    expect(edgeDisconnected).toMatchObject({
      title: "Edge disconnected",
      detail: "Reconnect reconciliation will start · robot robot-a",
      tone: "reconnecting"
    });
    expect(reconnectStarted).toMatchObject({
      title: "Reconnect reconciliation started",
      detail: "Cloud is comparing robot and mission state · robot robot-a · mission mission-a · previous DEGRADED",
      tone: "reconnecting"
    });
    expect(recovered.title).toBe("Reconnect reconciled, mission recovered");
    expect(recovered.detail).toContain(
      "reason: cloud and robot mission state match"
    );
    expect(manualReview).toMatchObject({
      title: "Reconnect needs manual review",
      tone: "danger"
    });
    expect(manualReview.detail).toContain("Manual review required");
    expect(manualReview.detail).toContain("seq 7");
  });

  it("summarizes demo events and keeps unknown events compact", () => {
    const reset = summarizeStreamEvent({
      streamEventId: "stream-reset",
      type: "platform",
      occurredAt: "2026-05-15T12:00:00.000Z",
      data: {
        eventType: "demo.reset",
        robotId: "robot-a"
      }
    });
    const fault = summarizeStreamEvent({
      streamEventId: "stream-fault",
      type: "platform",
      occurredAt: "2026-05-15T12:00:01.000Z",
      data: {
        eventType: "demo.fault.reconnect",
        robotId: "robot-a"
      }
    });
    const unknown = summarizeStreamEvent({
      streamEventId: "stream-unknown",
      type: "domain",
      occurredAt: "2026-05-15T12:00:02.000Z",
      data: {
        eventType: "vendor.custom_event",
        aggregateType: "mission",
        aggregateId: "mission-with-a-very-long-id-that-should-wrap",
        payload: {
          reason:
            "operator visible reason that should be summarized without exposing nested raw payloads",
          nested: { thisShouldNotRenderAsJson: true }
        }
      }
    });

    expect(reset).toMatchObject({
      title: "Demo state reset",
      detail: "Demo baseline restored · robot robot-a",
      tone: "neutral"
    });
    expect(fault).toMatchObject({
      title: "Demo fault: reconnect",
      detail: "Reconnect path injected · robot robot-a",
      tone: "reconnecting"
    });
    expect(unknown.title).toBe("Vendor custom event");
    expect(unknown.detail).toContain(
      "mission mission-with-a-very-long-id-that-should-wrap"
    );
    expect(unknown.detail).toContain("reason: operator visible reason");
    expect(unknown.detail).not.toContain("{");
    expect(unknown.detail).not.toContain("thisShouldNotRenderAsJson");
  });
});

/** Overrides for the mission snapshot fields that individual tests care about. */
interface MissionOptions {
  readonly lifecycleState?: MissionSnapshot["lifecycleState"];
  readonly operationalStatus?: MissionSnapshot["operationalStatus"];
  readonly failureReason?: string;
}

/** Creates a minimal mission snapshot for selection tests. */
function mission(
  missionId: string,
  updatedAt: string,
  options: MissionOptions = {}
): MissionSnapshot {
  return {
    missionId,
    robotId: "robot-a",
    lifecycleState: options.lifecycleState ?? "RUNNING",
    operationalStatus: options.operationalStatus ?? "NOMINAL",
    createdAt: updatedAt,
    updatedAt,
    ...(options.failureReason ? { failureReason: options.failureReason } : {})
  };
}
