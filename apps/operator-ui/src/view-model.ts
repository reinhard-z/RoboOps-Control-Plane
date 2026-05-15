import type {
  MissionLifecycleState,
  RobotConnectionState,
  RobotHealthState
} from "@roboops/fleet-protocol";

import type {
  MissionSnapshot,
  PlatformStreamEvent,
  RobotSnapshot
} from "./types.js";

export type StatusTone =
  | "online"
  | "stale"
  | "degraded"
  | "offline"
  | "reconnecting"
  | "neutral"
  | "danger";

/** Operator-facing summary produced from raw SSE records. */
export interface EventSummary {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly occurredAt: string;
  readonly tone: StatusTone;
}

/** Create-mission button state derived from robot assignment and mission state. */
export interface MissionCreationAvailability {
  readonly canCreate: boolean;
  readonly buttonLabel: string;
  readonly message?: string;
  readonly blockingMissionId?: string;
}

/** High-level mission buckets shown before raw lifecycle details. */
export type MissionStateKind = "active" | "terminal" | "blocked" | "manual-review";

/** Operator-facing classification for the selected mission detail panel. */
export interface MissionStateSummary {
  readonly kind: MissionStateKind;
  readonly label: string;
  readonly detail: string;
  readonly tone: StatusTone;
}

/** Human wording for domain rejection codes that can surface in API responses. */
const REJECTION_REASON_MESSAGES = {
  COMMAND_EXPIRED: "The command expired before it could be dispatched",
  COMMAND_PAYLOAD_INVALID: "The command payload is invalid",
  COMMAND_TTL_INVALID: "The command expiration is invalid",
  COMMAND_TYPE_NOT_ALLOWED: "This command type is not allowed",
  DUPLICATE_COMMAND_ID: "A command with this id already exists",
  IDEMPOTENCY_KEY_REUSE_CONFLICT:
    "The idempotency key was reused with different mission details",
  LOW_BATTERY: "The robot battery is below the safety threshold",
  MISSION_NOT_ACTIVE: "The selected mission is no longer active",
  UNKNOWN_MISSION: "Fleet Platform no longer has this mission",
  RECONCILIATION_IN_PROGRESS: "The robot is reconnecting and being reconciled",
  ROBOT_ALREADY_ASSIGNED: "The robot already has an active mission",
  ROBOT_TELEMETRY_STALE: "The robot telemetry is stale"
} as const;

/** Cancel-specific wording for rejection codes that need different operator action. */
const CANCEL_REJECTION_REASON_MESSAGES = {
  COMMAND_EXPIRED: "The cancel command expired before it could be dispatched",
  COMMAND_TTL_INVALID: "The cancel command expiration is invalid",
  DUPLICATE_COMMAND_ID: "A cancel command with this id already exists",
  IDEMPOTENCY_KEY_REUSE_CONFLICT:
    "The cancel request was retried with different mission details",
  MISSION_NOT_ACTIVE: "The selected mission is no longer active",
  UNKNOWN_MISSION: "Fleet Platform no longer has this mission"
} as const;

/** Maps robot connectivity into stable CSS/status tones. */
export function statusToneForConnection(
  state: RobotConnectionState | undefined
): StatusTone {
  if (!state) {
    return "neutral";
  }
  return state.toLowerCase() as StatusTone;
}

/** Maps robot health into the same small tone set used by the console. */
export function statusToneForHealth(
  health: RobotHealthState | undefined
): StatusTone {
  if (health === "ERROR" || health === "ESTOP") {
    return "danger";
  }
  if (health === "WARN") {
    return "degraded";
  }
  if (health === "OK") {
    return "online";
  }
  return "neutral";
}

/** Returns true when a mission can still receive telemetry or cancel updates. */
export function isActiveMissionState(state: MissionLifecycleState): boolean {
  return ![
    "REJECTED",
    "SAFETY_BLOCKED",
    "CANCELLED",
    "SUCCEEDED",
    "FAILED",
    "TIMED_OUT",
    "MANUAL_REVIEW"
  ].includes(state);
}

/** Groups lifecycle states into the buckets operators need for quick triage. */
export function missionStateKind(state: MissionLifecycleState): MissionStateKind {
  if (state === "SAFETY_BLOCKED") {
    return "blocked";
  }

  if (state === "MANUAL_REVIEW") {
    return "manual-review";
  }

  return isActiveMissionState(state) ? "active" : "terminal";
}

/** Summarizes selected mission state with a stable label, detail, and tone. */
export function missionStateSummary(mission: MissionSnapshot): MissionStateSummary {
  const kind = missionStateKind(mission.lifecycleState);
  if (kind === "blocked") {
    return {
      kind,
      label: "BLOCKED",
      detail: "Blocked before dispatch by platform safety policy",
      tone: "degraded"
    };
  }

  if (kind === "manual-review") {
    return {
      kind,
      label: "MANUAL REVIEW",
      detail: "Needs operator review after reconnect reconciliation",
      tone: "danger"
    };
  }

  if (kind === "terminal") {
    return {
      kind,
      label: "TERMINAL",
      detail: terminalMissionDetail(mission.lifecycleState),
      tone: terminalMissionTone(mission.lifecycleState)
    };
  }

  return {
    kind,
    label: "ACTIVE",
    detail: activeMissionDetail(mission.lifecycleState),
    tone: activeMissionTone(mission.operationalStatus)
  };
}

/** Chooses the visual tone for lifecycle and row status pills. */
export function statusToneForMission(mission: MissionSnapshot): StatusTone {
  return missionStateSummary(mission).tone;
}

/** Decides whether the operator can create another mission for the selected robot. */
export function missionCreationAvailability(
  missions: readonly MissionSnapshot[],
  robot: RobotSnapshot | undefined
): MissionCreationAvailability {
  const activeMissionId = robot?.activeMissionId;
  if (!robot || !activeMissionId) {
    return { canCreate: true, buttonLabel: "Create Mission" };
  }

  const activeMission = missions.find(
    (mission) => mission.missionId === activeMissionId
  );
  if (activeMission && !isActiveMissionState(activeMission.lifecycleState)) {
    return { canCreate: true, buttonLabel: "Create Mission" };
  }

  return {
    canCreate: false,
    buttonLabel: "Active Mission In Progress",
    blockingMissionId: activeMissionId,
    message: `Robot ${robot.robotId} is already working on mission ${activeMissionId}. Cancel or finish that mission before creating another GO_TO_POSE.`
  };
}

/** Converts a dispatch rejection code into concise operator-facing wording. */
export function formatRejectionReason(reason: string | undefined): string | undefined {
  if (!reason) {
    return undefined;
  }

  if (hasKnownRejectionReason(reason)) {
    return REJECTION_REASON_MESSAGES[reason];
  }

  return humanizeReasonCode(reason);
}

/** Builds the action-message text used after Fleet Platform rejects a command. */
export function formatCommandRejectionMessage(reason: string | undefined): string {
  const detail = formatRejectionReason(reason);
  if (!detail) {
    return "Mission request was rejected by Fleet Platform.";
  }

  if (reason === "ROBOT_ALREADY_ASSIGNED") {
    return `${detail}. Cancel or finish the active mission before creating another GO_TO_POSE.`;
  }

  return `Mission request rejected: ${detail}.`;
}

/** Builds operator-facing feedback when Fleet Platform rejects cancellation. */
export function formatCancelRejectionMessage(reason: string | undefined): string {
  const detail = formatCancelRejectionReason(reason);
  if (!detail) {
    return "Cancel request was rejected by Fleet Platform.";
  }

  if (reason === "MISSION_NOT_ACTIVE") {
    return `${detail}. Refreshing mission state may show the terminal outcome.`;
  }

  return `Cancel request rejected: ${detail}.`;
}

/** Explains terminal blocked/rejected mission rows when the backend provides a reason. */
export function formatMissionFailureReason(
  mission: MissionSnapshot
): string | undefined {
  const reason = formatRejectionReason(mission.failureReason);
  if (reason) {
    return reason;
  }

  if (mission.lifecycleState === "SAFETY_BLOCKED") {
    return "Blocked by platform safety policy";
  }

  if (mission.lifecycleState === "REJECTED") {
    return "Rejected by platform policy";
  }

  return undefined;
}

/** Sorts newest missions first for a compact operator list. */
export function sortMissions(
  missions: readonly MissionSnapshot[]
): readonly MissionSnapshot[] {
  return [...missions].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  );
}

/** Keeps the selected mission stable, then falls back to active robot work or newest mission. */
export function selectDefaultMission(
  missions: readonly MissionSnapshot[],
  robot: RobotSnapshot | undefined,
  selectedMissionId: string | undefined
): MissionSnapshot | undefined {
  if (selectedMissionId) {
    const selected = missions.find(
      (mission) => mission.missionId === selectedMissionId
    );
    if (selected) {
      return selected;
    }
  }

  if (robot?.activeMissionId) {
    const active = missions.find(
      (mission) => mission.missionId === robot.activeMissionId
    );
    if (active) {
      return active;
    }
  }

  return sortMissions(missions)[0];
}

/** Formats battery values without implying precision the backend does not provide. */
export function formatBattery(value: number | undefined): string {
  if (value === undefined) {
    return "unknown";
  }
  return `${Math.round(value)}%`;
}

/** Formats a timestamp as a compact relative age for live dashboards. */
export function formatRelativeTime(
  timestamp: string | undefined,
  nowMs: number = Date.now()
): string {
  if (!timestamp) {
    return "never";
  }
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return "invalid";
  }

  const ageSeconds = Math.max(0, Math.floor((nowMs - parsed) / 1_000));
  if (ageSeconds < 60) {
    return `${ageSeconds}s ago`;
  }

  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) {
    return `${ageMinutes}m ago`;
  }

  const ageHours = Math.floor(ageMinutes / 60);
  return `${ageHours}h ago`;
}

/** Computes telemetry age from the freshest platform-observed heartbeat timestamp. */
export function telemetryAgeMs(
  robot: RobotSnapshot | undefined,
  nowMs: number = Date.now()
): number | undefined {
  const timestamp = robot?.lastTelemetryReceivedAt ?? robot?.lastTelemetryObservedAt;
  if (!timestamp) {
    return undefined;
  }
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.max(0, nowMs - parsed);
}

/** Parses operator numeric input while treating blank fields as unset. */
export function parsePoseNumber(value: string, fallback: number): number {
  if (value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Converts a raw stream envelope into one concise feed row. */
export function summarizeStreamEvent(event: PlatformStreamEvent): EventSummary {
  const data = asRecord(event.data);
  const title =
    readString(data, "eventType") ??
    readString(data, "action") ??
    `${event.type}.event`;

  return {
    id: event.streamEventId,
    title,
    detail: buildEventDetail(event.type, data),
    occurredAt: event.occurredAt,
    tone: toneForEvent(title, data)
  };
}

/** Builds a terse detail string from common event and audit fields. */
function buildEventDetail(
  streamType: PlatformStreamEvent["type"],
  data: Record<string, unknown>
): string {
  const fragments = [
    streamType,
    readString(data, "robotId"),
    readString(data, "missionId"),
    readString(data, "commandId"),
    readString(data, "aggregateId")
  ];

  const payload = asRecord(data["payload"]);
  const details = asRecord(data["details"]);
  const semanticFragments = [
    readString(payload, "connectionState"),
    readString(payload, "previousConnectionState"),
    readString(payload, "outcome"),
    readString(payload, "reason"),
    readString(details, "connectionState"),
    readString(details, "outcome"),
    readString(details, "reason")
  ];

  return [...fragments, ...semanticFragments].filter(Boolean).join(" · ");
}

/** Chooses an event tone that makes degraded and reconnect paths stand out. */
function toneForEvent(
  title: string,
  data: Record<string, unknown>
): StatusTone {
  const text = `${title} ${JSON.stringify(data)}`.toLowerCase();
  if (text.includes("reconnect") || text.includes("reconcil")) {
    return "reconnecting";
  }
  if (text.includes("offline") || text.includes("failed") || text.includes("reject")) {
    return "danger";
  }
  if (text.includes("degraded") || text.includes("stale") || text.includes("warn")) {
    return "degraded";
  }
  if (text.includes("online") || text.includes("acked") || text.includes("received")) {
    return "online";
  }
  return "neutral";
}

/** Reads one string property from a JSON-like object. */
function readString(
  value: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

/** Narrows JSON-like values to plain records for feed summarization. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Narrows arbitrary strings to the rejection codes with hand-written copy. */
function hasKnownRejectionReason(
  reason: string
): reason is keyof typeof REJECTION_REASON_MESSAGES {
  return Object.prototype.hasOwnProperty.call(REJECTION_REASON_MESSAGES, reason);
}

/** Converts cancel rejection codes into concise action-oriented wording. */
function formatCancelRejectionReason(
  reason: string | undefined
): string | undefined {
  if (!reason) {
    return undefined;
  }

  if (hasKnownCancelRejectionReason(reason)) {
    return CANCEL_REJECTION_REASON_MESSAGES[reason];
  }

  return formatRejectionReason(reason);
}

/** Narrows arbitrary strings to the cancel rejection codes with custom copy. */
function hasKnownCancelRejectionReason(
  reason: string
): reason is keyof typeof CANCEL_REJECTION_REASON_MESSAGES {
  return Object.prototype.hasOwnProperty.call(
    CANCEL_REJECTION_REASON_MESSAGES,
    reason
  );
}

/** Explains active lifecycle states without exposing implementation jargon first. */
function activeMissionDetail(state: MissionLifecycleState): string {
  if (state === "CANCEL_REQUESTED") {
    return "Cancel requested; waiting for edge acknowledgement";
  }

  if (state === "DISPATCHED") {
    return "Command dispatched; waiting for edge acknowledgement";
  }

  if (state === "ACKNOWLEDGED") {
    return "Command acknowledged; waiting for running telemetry";
  }

  return `Lifecycle ${state}`;
}

/** Maps active operational overlays into the tone palette used by the console. */
function activeMissionTone(
  operationalStatus: MissionSnapshot["operationalStatus"]
): StatusTone {
  if (
    operationalStatus === "RECONNECTING" ||
    operationalStatus === "RECONCILING"
  ) {
    return "reconnecting";
  }

  if (operationalStatus === "DEGRADED") {
    return "degraded";
  }

  return "online";
}

/** Explains terminal lifecycle states with the operator action implied by each one. */
function terminalMissionDetail(state: MissionLifecycleState): string {
  if (state === "SUCCEEDED") {
    return "Mission completed successfully";
  }

  if (state === "CANCELLED") {
    return "Cancellation acknowledged by the edge";
  }

  if (state === "FAILED") {
    return "Mission ended in failure";
  }

  if (state === "TIMED_OUT") {
    return "Mission timed out before completion";
  }

  if (state === "REJECTED") {
    return "Mission rejected before dispatch";
  }

  return `Lifecycle ${state}`;
}

/** Uses danger only for terminal states that need investigation. */
function terminalMissionTone(state: MissionLifecycleState): StatusTone {
  if (state === "FAILED" || state === "REJECTED") {
    return "danger";
  }

  if (state === "SUCCEEDED") {
    return "online";
  }

  return "offline";
}

/** Falls back to readable title case for new backend rejection codes. */
function humanizeReasonCode(reason: string): string {
  return reason
    .toLowerCase()
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
