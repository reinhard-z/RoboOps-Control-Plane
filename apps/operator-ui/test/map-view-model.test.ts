import { describe, expect, it } from "vitest";

import {
  appendRobotPoseTrail,
  createRobotMapModel
} from "../src/map-view-model.js";
import type { MissionSnapshot, Pose2D, RobotSnapshot } from "../src/types.js";

describe("operator UI robot map view model", () => {
  it("projects robot pose, target, and trail into SVG map coordinates", () => {
    const robot: RobotSnapshot = {
      robotId: "robot-a",
      connectionState: "ONLINE",
      updatedAt: "2026-05-15T12:00:00.000Z",
      pose: { x: 1, y: 2, theta: Math.PI / 2 },
      lastSeenCommandSequence: 1
    };
    const model = createRobotMapModel(
      robot,
      mission({ targetPose: { x: 3, y: 4, theta: 0 } }),
      [
        { x: 0, y: 0, theta: 0 },
        { x: 1, y: 2, theta: Math.PI / 2 }
      ]
    );

    expect(model.statusLabel).toBe("ONLINE");
    expect(model.statusTone).toBe("online");
    expect(model.poseLabel).toBe("x 1, y 2, heading 90 deg");
    expect(model.targetLabel).toBe("target x 3, y 4");
    expect(model.robot?.point).toEqual({ x: 28.6, y: 57.1 });
    expect(model.robot?.headingDegrees).toBe(90);
    expect(model.target?.point).toEqual({ x: 57.1, y: 28.6 });
    expect(model.trailPoints).toBe("14.3,85.7 28.6,57.1");
  });

  it("deduplicates tiny pose updates and keeps a bounded trail", () => {
    const initialTrail = [{ x: 1, y: 1, theta: 0 }];
    const unchanged = appendRobotPoseTrail(initialTrail, {
      x: 1.01,
      y: 1.01,
      theta: 0
    });

    expect(unchanged).toBe(initialTrail);

    const expanded = Array.from({ length: 24 }, (_, index) =>
      appendRobotPoseTrail(
        [],
        { x: index, y: index, theta: 0 }
      )[0]
    ).filter((pose): pose is NonNullable<typeof pose> => Boolean(pose));
    const bounded = expanded.reduce<readonly Pose2D[]>(
      (trail, pose) => appendRobotPoseTrail(trail, pose),
      []
    );

    expect(bounded).toHaveLength(20);
    expect(bounded[0]?.x).toBe(4);
    expect(bounded.at(-1)?.x).toBe(23);
  });

  it("renders a waiting state before telemetry arrives", () => {
    const model = createRobotMapModel(undefined, undefined, []);

    expect(model.statusLabel).toBe("WAITING");
    expect(model.poseLabel).toBe("No telemetry pose");
    expect(model.targetLabel).toBe("No active target");
    expect(model.robot).toBeUndefined();
    expect(model.target).toBeUndefined();
  });
});

/** Creates a mission snapshot with only map-relevant optional fields varied. */
function mission(
  options: { readonly targetPose?: MissionSnapshot["targetPose"] } = {}
): MissionSnapshot {
  return {
    missionId: "mission-a",
    robotId: "robot-a",
    lifecycleState: "RUNNING",
    operationalStatus: "NOMINAL",
    createdAt: "2026-05-15T12:00:00.000Z",
    updatedAt: "2026-05-15T12:00:00.000Z",
    ...(options.targetPose ? { targetPose: options.targetPose } : {})
  };
}
