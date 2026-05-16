import type { MissionSnapshot, Pose2D, RobotSnapshot } from "./types.js";
import { statusToneForConnection, type StatusTone } from "./view-model.js";

const defaultMapBounds = {
  minX: -1,
  maxX: 6,
  minY: -1,
  maxY: 6
};

const maxTrailPoints = 20;
const duplicatePoseToleranceMeters = 0.02;

/** SVG-space point used by the virtual map renderer. */
export interface MapPoint {
  readonly x: number;
  readonly y: number;
}

/** Browser-ready map state derived from robot telemetry and selected mission target. */
export interface RobotMapModel {
  readonly statusLabel: string;
  readonly statusTone: StatusTone;
  readonly poseLabel: string;
  readonly targetLabel: string;
  readonly trailPoints: string;
  readonly robot?: {
    readonly point: MapPoint;
    readonly headingDegrees: number;
  };
  readonly target?: {
    readonly point: MapPoint;
  };
}

/** Appends a telemetry pose to the visual trail while avoiding duplicate points. */
export function appendRobotPoseTrail(
  trail: readonly Pose2D[],
  pose: Pose2D | undefined
): readonly Pose2D[] {
  if (!pose) {
    return trail;
  }

  const lastPose = trail.at(-1);
  if (lastPose && poseDistanceMeters(lastPose, pose) < duplicatePoseToleranceMeters) {
    return trail;
  }

  return [...trail, pose].slice(-maxTrailPoints);
}

/** Converts the latest robot and mission snapshots into a stable SVG map model. */
export function createRobotMapModel(
  robot: RobotSnapshot | undefined,
  mission: MissionSnapshot | undefined,
  trail: readonly Pose2D[]
): RobotMapModel {
  const pose = robot?.pose;
  const targetPose = mission?.targetPose;
  const bounds = mapBoundsFor([pose, targetPose, ...trail]);
  const trailPoints = trail
    .map((trailPose) => toMapPoint(trailPose, bounds))
    .map(formatMapPoint)
    .join(" ");

  return {
    statusLabel: robot?.connectionState ?? "WAITING",
    statusTone: statusToneForConnection(robot?.connectionState),
    poseLabel: pose ? formatPose(pose) : "No telemetry pose",
    targetLabel: targetPose ? formatTarget(targetPose) : "No active target",
    trailPoints,
    ...(pose
      ? {
          robot: {
            point: toMapPoint(pose, bounds),
            headingDegrees: radiansToDegrees(pose.theta)
          }
        }
      : {}),
    ...(targetPose
      ? {
          target: {
            point: toMapPoint(targetPose, bounds)
          }
        }
      : {})
  };
}

interface MapBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** Expands the default demo map only when an operator target sits outside it. */
function mapBoundsFor(poses: readonly (Pose2D | undefined)[]): MapBounds {
  let minX = defaultMapBounds.minX;
  let maxX = defaultMapBounds.maxX;
  let minY = defaultMapBounds.minY;
  let maxY = defaultMapBounds.maxY;

  for (const pose of poses) {
    if (!pose) {
      continue;
    }
    minX = Math.min(minX, Math.floor(pose.x) - 0.5);
    maxX = Math.max(maxX, Math.ceil(pose.x) + 0.5);
    minY = Math.min(minY, Math.floor(pose.y) - 0.5);
    maxY = Math.max(maxY, Math.ceil(pose.y) + 0.5);
  }

  return { minX, maxX, minY, maxY };
}

/** Projects world meters into the fixed 100x100 SVG viewport. */
function toMapPoint(pose: Pose2D, bounds: MapBounds): MapPoint {
  const xSpan = Math.max(bounds.maxX - bounds.minX, 1);
  const ySpan = Math.max(bounds.maxY - bounds.minY, 1);
  return {
    x: round(clamp(((pose.x - bounds.minX) / xSpan) * 100, 2, 98)),
    y: round(clamp(100 - ((pose.y - bounds.minY) / ySpan) * 100, 2, 98))
  };
}

/** Formats coordinates for the SVG polyline attribute. */
function formatMapPoint(point: MapPoint): string {
  return `${round(point.x)},${round(point.y)}`;
}

/** Keeps readout text short enough for compact dashboard panels. */
function formatPose(pose: Pose2D): string {
  return `x ${round(pose.x)}, y ${round(pose.y)}, heading ${Math.round(radiansToDegrees(pose.theta))} deg`;
}

/** Keeps target readout aligned with the command form language. */
function formatTarget(pose: Pose2D): string {
  return `target x ${round(pose.x)}, y ${round(pose.y)}`;
}

/** Converts protocol radians into SVG/CSS degrees. */
function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

/** Measures map trail movement in world meters. */
function poseDistanceMeters(left: Pose2D, right: Pose2D): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

/** Rounds visual values without adding noisy trailing decimals. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Prevents malformed telemetry from moving markers outside the visible map. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
