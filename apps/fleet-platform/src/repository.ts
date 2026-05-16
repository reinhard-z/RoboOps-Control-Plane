import {
  type DomainState,
  type RobotSnapshot,
  createInitialDomainState,
  upsertRobotSnapshot
} from "@roboops/fleet-domain";

import { nowIso } from "./ids.js";

/** Builds the local demo state with one online robot so HTTP mission creation works immediately. */
export function createSeededDomainState(
  robotId: string,
  timestamp: string = nowIso()
): DomainState {
  return upsertRobotSnapshot(createInitialDomainState(), createDemoRobot(robotId, timestamp));
}

/** Creates the default demo robot snapshot used before a real edge sends telemetry. */
function createDemoRobot(robotId: string, timestamp: string): RobotSnapshot {
  return {
    robotId,
    connectionState: "ONLINE",
    updatedAt: timestamp,
    pose: { x: 0, y: 0, theta: 0 },
    health: "OK",
    batteryPercent: 80,
    lastTelemetryObservedAt: timestamp,
    lastTelemetryReceivedAt: timestamp,
    lastSeenCommandSequence: 0,
    edgeAgentVersion: "0.1.0"
  };
}
