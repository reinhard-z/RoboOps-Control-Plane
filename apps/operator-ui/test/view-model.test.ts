import { describe, expect, it } from "vitest";

import type { MissionSnapshot, RobotSnapshot } from "../src/types.js";
import {
  formatCommandRejectionMessage,
  formatMissionFailureReason,
  formatRelativeTime,
  missionCreationAvailability,
  parsePoseNumber,
  selectDefaultMission,
  statusToneForConnection,
  summarizeStreamEvent,
  telemetryAgeMs
} from "../src/view-model.js";

const now = Date.parse("2026-05-15T12:00:00.000Z");

describe("operator UI view model", () => {
  it("maps robot connection states to distinct tones", () => {
    expect(statusToneForConnection("ONLINE")).toBe("online");
    expect(statusToneForConnection("STALE")).toBe("stale");
    expect(statusToneForConnection("DEGRADED")).toBe("degraded");
    expect(statusToneForConnection("OFFLINE")).toBe("offline");
    expect(statusToneForConnection("RECONNECTING")).toBe("reconnecting");
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

  it("summarizes SSE records into operator feed rows", () => {
    const summary = summarizeStreamEvent({
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

    expect(summary.title).toBe("robot.connection.freshness_changed");
    expect(summary.detail).toContain("robot-a");
    expect(summary.detail).toContain("DEGRADED");
    expect(summary.tone).toBe("degraded");
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
