import type {
  CommandEnvelopeV1,
  MissionId,
  MissionLifecycleState,
  Pose2D,
  RobotId
} from "@roboops/fleet-protocol";

export const simulatorScenarios = [
  "normal",
  "stale-telemetry",
  "reconnect"
] as const;

export type SimulatorScenario = (typeof simulatorScenarios)[number];

/** Environment-backed settings used by the local cloud-edge simulator process. */
export interface CloudEdgeSimulatorConfig {
  readonly fleetPlatformUrl: string;
  readonly robotId: RobotId;
  readonly edgeAgentVersion: string;
  readonly scenario: SimulatorScenario;
  readonly heartbeatIntervalMs: number;
  readonly reconnectDelayMs: number;
}

/** Small mutable model of the robot state the simulator reports to the platform. */
export interface SimulatorState {
  readonly robotId: RobotId;
  readonly edgeSessionId: string;
  readonly edgeAgentVersion: string;
  readonly scenario: SimulatorScenario;
  readonly pose: Pose2D;
  readonly targetPose?: Pose2D;
  readonly batteryPercent: number;
  readonly lastSeenCommandSequence: number;
  readonly lastAcknowledgedCommandId?: string;
  readonly currentMissionId?: MissionId;
  readonly reportedMissionLifecycleState?: MissionLifecycleState;
  readonly lastTelemetryObservedAt?: string;
  readonly reconnectHandshakeSent: boolean;
}

/** Platform message subset the simulator currently needs for local demos. */
export type SimulatorPlatformMessage =
  | { readonly type: "platform.command"; readonly payload: CommandEnvelopeV1 }
  | { readonly type: "platform.ping"; readonly payload: { readonly sentAt: string } }
  | {
      readonly type: "platform.error";
      readonly payload: {
        readonly code: string;
        readonly message: string;
        readonly correlationId?: string;
      };
    };

/** Edge wire messages produced by the simulator and sent over the WebSocket. */
export type SimulatorEdgeMessage =
  | { readonly type: "edge.hello"; readonly payload: Record<string, unknown> }
  | { readonly type: "edge.command_ack"; readonly payload: Record<string, unknown> }
  | { readonly type: "edge.telemetry"; readonly payload: Record<string, unknown> }
  | {
      readonly type: "edge.reconnect_handshake";
      readonly payload: Record<string, unknown>;
    };

/** Runtime side effects requested by pure command handling. */
export interface SimulatorAction {
  readonly kind:
    | "start_telemetry"
    | "stop_telemetry"
    | "disconnect_for_reconnect"
    | "log";
  readonly message?: string;
}

/** Pure handling result consumed by the WebSocket runtime and unit tests. */
export interface SimulatorStep {
  readonly state: SimulatorState;
  readonly outbound: readonly SimulatorEdgeMessage[];
  readonly actions: readonly SimulatorAction[];
}
