// Public package barrel. Keep exports explicit so internal helpers stay private.
export type { CommandAckResult, MissionTimeoutResult } from "./ack.js";
export { applyCommandAck, applyMissionTimeout } from "./ack.js";
export type {
  CancelMissionRejectionReason,
  CancelMissionResult,
  RequestMissionCancellationInput
} from "./cancel.js";
export { requestMissionCancellation } from "./cancel.js";
export type {
  DispatchMissionCommandInput,
  DispatchMissionResult,
  DispatchRejectionReason
} from "./dispatch.js";
export { dispatchMissionCommand } from "./dispatch.js";
export type { DomainConfig } from "./policies.js";
export { defaultDomainConfig, isActiveMission } from "./policies.js";
export type {
  ReconnectHandshakeResult,
  ReconnectStartResult
} from "./reconnect.js";
export { beginReconnect, processReconnectHandshake } from "./reconnect.js";
export type {
  DomainState,
  DomainTransition,
  IdempotencyRecord,
  MissionSnapshot,
  RobotSnapshot
} from "./state.js";
export { createInitialDomainState, getMission, getRobot, upsertRobotSnapshot } from "./state.js";
export type { FreshnessResult, TelemetryResult } from "./telemetry.js";
export { evaluateTelemetryFreshness, ingestRobotTelemetry } from "./telemetry.js";
