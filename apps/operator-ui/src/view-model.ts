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
