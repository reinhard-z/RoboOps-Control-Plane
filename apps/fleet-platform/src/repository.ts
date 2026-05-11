import {
  type DomainState,
  type RobotSnapshot,
  createInitialDomainState,
  upsertRobotSnapshot
} from "@roboops/fleet-domain";

import { nowIso } from "./ids.js";

/** Storage boundary for the mutable in-memory domain aggregate used in Phase 2. */
export interface DomainStateRepository {
  read(): DomainState;
  write(state: DomainState): void;
  reset(state: DomainState): void;
  update(mutator: (state: DomainState) => DomainState): DomainState;
}

/** In-memory repository with the same coarse shape later Postgres repositories will replace. */
export class InMemoryDomainStateRepository implements DomainStateRepository {
  private state: DomainState;

  constructor(initialState: DomainState = createInitialDomainState()) {
    this.state = initialState;
  }

  read(): DomainState {
    return this.state;
  }

  write(state: DomainState): void {
    this.state = state;
  }

  reset(state: DomainState): void {
    this.state = state;
  }

  update(mutator: (state: DomainState) => DomainState): DomainState {
    const nextState = mutator(this.state);
    this.state = nextState;
    return nextState;
  }
}

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
    health: "OK",
    batteryPercent: 80,
    lastTelemetryObservedAt: timestamp,
    lastTelemetryReceivedAt: timestamp,
    lastSeenCommandSequence: 0,
    edgeAgentVersion: "0.1.0"
  };
}
