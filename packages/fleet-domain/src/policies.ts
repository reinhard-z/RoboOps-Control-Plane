import {
  type CommandType,
  type MissionLifecycleState,
  type RobotConnectionState,
  type SafetyClass,
  isMotionCommandType
} from "@roboops/fleet-protocol";

/** Tunable policy thresholds used by pure domain decisions. */
export interface DomainConfig {
  readonly telemetryStaleAfterMs: number;
  readonly telemetryDegradedAfterMs: number;
  readonly telemetryOfflineAfterMs: number;
  readonly lowBatteryPercent: number;
  readonly maxCommandTtlMs: number;
  readonly allowedCommandTypes: readonly CommandType[];
}

export const defaultDomainConfig = {
  telemetryStaleAfterMs: 5_000,
  telemetryDegradedAfterMs: 10_000,
  telemetryOfflineAfterMs: 30_000,
  lowBatteryPercent: 20,
  maxCommandTtlMs: 30_000,
  allowedCommandTypes: [
    "GO_TO_POSE",
    "CANCEL_MISSION",
    "PAUSE_MISSION",
    "RESUME_MISSION",
    "EMERGENCY_STOP"
  ]
} as const satisfies DomainConfig;

/** Returns true while a mission can still receive operational updates. */
export function isActiveMission(lifecycleState: MissionLifecycleState): boolean {
  return ![
    "REJECTED",
    "SAFETY_BLOCKED",
    "CANCELLED",
    "SUCCEEDED",
    "FAILED",
    "TIMED_OUT",
    "MANUAL_REVIEW"
  ].includes(lifecycleState);
}

/** Classifies heartbeat age into the robot connection states used for freshness policy. */
export function classifyConnectionState(
  heartbeatAgeMs: number,
  config: DomainConfig
): RobotConnectionState {
  if (heartbeatAgeMs >= config.telemetryOfflineAfterMs) {
    return "OFFLINE";
  }
  if (heartbeatAgeMs >= config.telemetryDegradedAfterMs) {
    return "DEGRADED";
  }
  if (heartbeatAgeMs >= config.telemetryStaleAfterMs) {
    return "STALE";
  }
  return "ONLINE";
}

/** Treats motion commands and elevated safety classes as commands requiring fresh telemetry. */
export function isRiskyCommand(type: CommandType, safetyClass: SafetyClass): boolean {
  return (
    safetyClass === "RISKY" ||
    safetyClass === "EMERGENCY_STOP" ||
    isMotionCommandType(type)
  );
}
