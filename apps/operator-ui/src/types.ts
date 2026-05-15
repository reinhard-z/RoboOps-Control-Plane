import type {
  CommandId,
  MissionId,
  MissionLifecycleState,
  MissionOperationalStatus,
  RobotConnectionState,
  RobotHealthState,
  RobotId
} from "@roboops/fleet-protocol";

/** Platform robot snapshot fields needed by the operator console. */
export interface RobotSnapshot {
  readonly robotId: RobotId;
  readonly connectionState: RobotConnectionState;
  readonly updatedAt: string;
  readonly health?: RobotHealthState;
  readonly batteryPercent?: number;
  readonly activeMissionId?: MissionId;
  readonly lastTelemetryObservedAt?: string;
  readonly lastTelemetryReceivedAt?: string;
  readonly lastAcknowledgedCommandId?: CommandId;
  readonly lastSeenCommandSequence: number;
  readonly edgeAgentVersion?: string;
}

/** Platform mission snapshot fields rendered in list and detail views. */
export interface MissionSnapshot {
  readonly missionId: MissionId;
  readonly robotId: RobotId;
  readonly lifecycleState: MissionLifecycleState;
  readonly operationalStatus: MissionOperationalStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly currentCommandId?: CommandId;
  readonly lastCommandSequence?: number;
  readonly lastAcknowledgedCommandId?: CommandId;
  readonly lastAcknowledgedCommandSequence?: number;
  readonly idempotencyKey?: string;
  readonly failureReason?: string;
}

/** Browser-facing shape of the Fleet Platform SSE envelope. */
export interface PlatformStreamEvent {
  readonly streamEventId: string;
  readonly type: "domain" | "audit" | "platform";
  readonly occurredAt: string;
  readonly data: unknown;
}

/** API response returned when creating or cancelling a mission command. */
export interface MissionCommandResponse {
  readonly result: {
    readonly status: "ACCEPTED" | "IDEMPOTENT_REPLAY" | "REJECTED";
    readonly reason?: string;
    readonly mission?: MissionSnapshot;
  };
  readonly deliveryCount: number;
  readonly correlationId?: string;
}

/** Minimal operator-editable GO_TO_POSE target. */
export interface PoseTarget {
  readonly x: number;
  readonly y: number;
  readonly theta: number;
}
