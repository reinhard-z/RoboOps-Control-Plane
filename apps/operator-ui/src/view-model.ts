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

export type ApiConnectionState = "CHECKING" | "AVAILABLE" | "UNAVAILABLE";

/** Short status copy for top-level API and stream indicators. */
export interface StatusSummary {
  readonly label: string;
  readonly detail: string;
  readonly tone: StatusTone;
}

/** Operator-facing summary produced from raw SSE records. */
export interface EventSummary {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly occurredAt: string;
  readonly tone: StatusTone;
}

/** Operator-facing robot connection copy shown next to the raw connection state. */
export type RobotConnectionSummary = StatusSummary;

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

/** Converts snapshot refresh state into explicit API availability copy. */
export function apiStatusSummary(state: ApiConnectionState): StatusSummary {
  if (state === "AVAILABLE") {
    return {
      label: "API available",
      detail: "Fleet Platform snapshots loaded",
      tone: "online"
    };
  }

  if (state === "UNAVAILABLE") {
    return {
      label: "API unavailable",
      detail: "Check Fleet Platform, the API URL, and CORS settings",
      tone: "danger"
    };
  }

  return {
    label: "API checking",
    detail: "Waiting for Fleet Platform",
    tone: "neutral"
  };
}

/** Summarizes simulator connectivity from robot state and telemetry freshness. */
export function robotConnectionSummary(
  robot: RobotSnapshot | undefined,
  nowMs: number = Date.now()
): RobotConnectionSummary {
  if (!robot) {
    return {
      label: "UNKNOWN",
      detail: "No robot snapshot from Fleet Platform yet",
      tone: "neutral"
    };
  }

  if (robot.connectionState === "ONLINE") {
    const age = telemetryAgeMs(robot, nowMs);
    return {
      label: robot.connectionState,
      detail:
        age !== undefined && age >= 5_000
          ? "Telemetry is aging; simulator may be paused"
          : "Simulator telemetry live",
      tone: "online"
    };
  }

  if (robot.connectionState === "RECONNECTING") {
    return {
      label: robot.connectionState,
      detail: "Reconnect reconciliation in progress",
      tone: "reconnecting"
    };
  }

  if (robot.connectionState === "DEGRADED") {
    return {
      label: robot.connectionState,
      detail: "Simulator disconnected or telemetry stalled",
      tone: "degraded"
    };
  }

  if (robot.connectionState === "STALE") {
    return {
      label: robot.connectionState,
      detail: "Telemetry stale; simulator may be paused",
      tone: "stale"
    };
  }

  return {
    label: robot.connectionState,
    detail: "Simulator offline",
    tone: "offline"
  };
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

/** Empty-state text for the mission list when no platform missions exist. */
export function emptyMissionListText(): string {
  return "No missions yet";
}

/** Empty-state text for the event feed before the first SSE message arrives. */
export function emptyEventFeedText(): string {
  return "No events yet";
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
  const context = createEventSummaryContext(event.type, data);
  const summary = summarizeKnownEvent(context) ?? summarizeUnknownEvent(context);

  return {
    id: event.streamEventId,
    title: summary.title,
    detail: summary.detail,
    occurredAt: event.occurredAt,
    tone: summary.tone
  };
}

/** Parsed event fields used by feed copy without depending on one raw payload shape. */
interface EventSummaryContext {
  readonly streamType: PlatformStreamEvent["type"];
  readonly name: string;
  readonly aggregateType: string | undefined;
  readonly aggregateId: string | undefined;
  readonly missionId: string | undefined;
  readonly robotId: string | undefined;
  readonly commandId: string | undefined;
  readonly edgeSessionId: string | undefined;
  readonly reason: string | undefined;
  readonly outcome: string | undefined;
  readonly status: string | undefined;
  readonly lifecycleState: string | undefined;
  readonly connectionState: string | undefined;
  readonly previousConnectionState: string | undefined;
  readonly health: string | undefined;
  readonly commandType: string | undefined;
  readonly sequence: number | undefined;
  readonly lastSeenCommandSequence: number | undefined;
  readonly batteryPercent: number | undefined;
}

/** Feed row copy before the SSE envelope id and timestamp are applied. */
type EventSummaryCopy = Pick<EventSummary, "title" | "detail" | "tone">;

/** Collects common ids and semantic fields from domain, audit, and platform events. */
function createEventSummaryContext(
  streamType: PlatformStreamEvent["type"],
  data: Record<string, unknown>
): EventSummaryContext {
  const payload = asRecord(data["payload"]);
  const details = asRecord(data["details"]);
  const aggregateType = readString(data, "aggregateType");
  const aggregateId = readString(data, "aggregateId");
  const name =
    readString(data, "eventType") ??
    readString(data, "action") ??
    `${streamType}.event`;
  const inferredMissionAggregate =
    aggregateType === "mission" || (!aggregateType && name.startsWith("mission."));
  const inferredRobotAggregate =
    aggregateType === "robot" || (!aggregateType && name.startsWith("robot."));
  const inferredCommandAggregate =
    aggregateType === "command" || (!aggregateType && name.startsWith("command."));

  const missionId =
    readString(data, "missionId") ??
    readString(payload, "missionId") ??
    readString(payload, "currentMissionId") ??
    readString(details, "missionId") ??
    (inferredMissionAggregate ? aggregateId : undefined);
  const robotId =
    readString(data, "robotId") ??
    readString(payload, "robotId") ??
    readString(details, "robotId") ??
    (inferredRobotAggregate ? aggregateId : undefined);
  const commandId =
    readString(data, "commandId") ??
    readString(payload, "commandId") ??
    readString(details, "commandId") ??
    (inferredCommandAggregate ? aggregateId : undefined);

  return {
    streamType,
    name,
    aggregateType,
    aggregateId,
    missionId,
    robotId,
    commandId,
    edgeSessionId:
      readString(data, "edgeSessionId") ??
      readString(payload, "edgeSessionId") ??
      readString(details, "edgeSessionId"),
    reason:
      readString(payload, "reason") ??
      readString(details, "reason") ??
      readString(data, "reason"),
    outcome: readString(payload, "outcome") ?? readString(details, "outcome"),
    status: readString(payload, "status") ?? readString(details, "status"),
    lifecycleState:
      readString(payload, "lifecycleState") ??
      readString(payload, "nextLifecycleState") ??
      readString(details, "lifecycleState") ??
      readString(details, "nextLifecycleState"),
    connectionState:
      readString(payload, "connectionState") ??
      readString(details, "connectionState"),
    previousConnectionState:
      readString(payload, "previousConnectionState") ??
      readString(details, "previousConnectionState"),
    health: readString(payload, "health") ?? readString(details, "health"),
    commandType:
      readString(payload, "commandType") ?? readString(details, "commandType"),
    sequence: readNumber(payload, "sequence") ?? readNumber(details, "sequence"),
    lastSeenCommandSequence:
      readNumber(payload, "lastSeenCommandSequence") ??
      readNumber(details, "lastSeenCommandSequence"),
    batteryPercent:
      readNumber(payload, "batteryPercent") ??
      readNumber(details, "batteryPercent")
  };
}

/** Returns intentional operator copy for the event types that make up the demo incident. */
function summarizeKnownEvent(
  context: EventSummaryContext
): EventSummaryCopy | undefined {
  switch (context.name) {
    case "stream.ready":
      return {
        title: "Event stream connected",
        detail: "Live Fleet Platform updates are connected",
        tone: "online"
      };
    case "mission.command.created":
      return {
        title: "Mission command created",
        detail: commandDetail(context, "Created"),
        tone: "neutral"
      };
    case "mission.command.dispatched":
      return {
        title: "Mission command dispatched",
        detail: commandDetail(context, "Sent to edge"),
        tone: "online"
      };
    case "mission.command.acked":
      return commandAckSummary(context);
    case "mission.command.timeout":
      return {
        title: "Mission command timed out",
        detail: commandDetail(context, "Expired before acknowledgement"),
        tone: "danger"
      };
    case "mission.command.rejected":
      return missionRejectedSummary(context);
    case "mission.running":
    case "mission.lifecycle.running":
      return {
        title: "Mission running",
        detail: missionDetail(context, "Telemetry confirms active work"),
        tone: "online"
      };
    case "mission.cancel.requested":
      return {
        title: "Mission cancel requested",
        detail: commandDetail(context, "Cancel sent to edge"),
        tone: "reconnecting"
      };
    case "mission.cancel.acked":
    case "mission.cancelled":
    case "mission.cancel.completed":
      return {
        title: "Mission cancelled",
        detail: commandDetail(context, "Cancellation accepted by edge"),
        tone: "offline"
      };
    case "mission.cancel.rejected":
      return {
        title: "Mission cancel rejected",
        detail: reasonDetail(
          context,
          "Cancel rejected",
          context.reason
            ? formatCancelRejectionReason(context.reason)
            : undefined
        ),
        tone: "danger"
      };
    case "robot.telemetry.received":
      return {
        title: "Robot telemetry received",
        detail: telemetryDetail(context),
        tone: toneForConnectionName(context.connectionState)
      };
    case "robot.connection.freshness_changed":
      return robotFreshnessSummary(context);
    case "edge.connected":
      return {
        title: "Edge connected",
        detail: edgeDetail(context, "Robot edge session is online"),
        tone: "online"
      };
    case "edge.disconnected":
      return {
        title: "Edge disconnected",
        detail: edgeDetail(context, "Reconnect reconciliation will start"),
        tone: "reconnecting"
      };
    case "edge.reconnected":
      return {
        title: "Edge reconnected",
        detail: edgeDetail(context, "Robot edge session returned"),
        tone: "online"
      };
    case "robot.reconnect.started":
    case "mission.reconciliation.started":
      return {
        title: "Reconnect reconciliation started",
        detail: reconnectStartDetail(context),
        tone: "reconnecting"
      };
    case "mission.reconciliation.completed":
      return reconciliationCompletedSummary(context);
    case "demo.reset":
    case "demo.scenario.reset":
      return {
        title: "Demo state reset",
        detail: robotDetail(context, "Demo baseline restored"),
        tone: "neutral"
      };
    case "demo.incident.start":
    case "demo.incident.started":
      return {
        title: "Demo incident started",
        detail: robotDetail(context, "Clean mission path started"),
        tone: "online"
      };
    case "demo.fault.disconnect":
    case "demo.fault.stale_telemetry":
    case "demo.fault.telemetry_stale":
      return {
        title: "Demo fault: telemetry stale",
        detail: robotDetail(context, "Telemetry freshness fault injected"),
        tone: "degraded"
      };
    case "demo.fault.reconnect":
      return {
        title: "Demo fault: reconnect",
        detail: robotDetail(context, "Reconnect path injected"),
        tone: "reconnecting"
      };
    case "demo.fault.low_battery":
      return {
        title: "Demo fault: low battery",
        detail: robotDetail(context, "Low-battery safety block injected"),
        tone: "degraded"
      };
    case "demo.fault.duplicate_command":
      return {
        title: "Demo fault: duplicate command",
        detail: robotDetail(context, "Duplicate command path injected"),
        tone: "neutral"
      };
    default:
      return undefined;
  }
}

/** Builds compact fallback copy for new event types without dumping raw payloads. */
function summarizeUnknownEvent(
  context: EventSummaryContext
): EventSummaryCopy {
  return {
    title: humanizeEventName(context.name),
    detail: fallbackDetail(context),
    tone: inferTone(context)
  };
}

/** Describes command-oriented events using mission, robot, command, and sequence. */
function commandDetail(context: EventSummaryContext, prefix: string): string {
  return joinDetail([
    prefix,
    context.commandType ? humanizeReasonCode(context.commandType) : undefined,
    idFragment("mission", context.missionId),
    idFragment("robot", context.robotId),
    idFragment("command", context.commandId),
    sequenceFragment(context)
  ]);
}

/** Summarizes edge command acks, including cancel acks that terminate the mission. */
function commandAckSummary(context: EventSummaryContext): EventSummaryCopy {
  if (
    context.commandType === "CANCEL_MISSION" &&
    (context.lifecycleState === "CANCELLED" ||
      context.status === "ACCEPTED" ||
      context.status === "DUPLICATE")
  ) {
    return {
      title: "Mission cancelled",
      detail: commandDetail(context, "Cancellation accepted by edge"),
      tone: "offline"
    };
  }

  if (context.commandType === "CANCEL_MISSION" && context.status === "REJECTED") {
    return {
      title: "Mission cancel rejected",
      detail: commandAckDetail(context),
      tone: "danger"
    };
  }

  if (context.lifecycleState === "RUNNING") {
    return {
      title: "Mission running",
      detail: commandDetail(context, "Edge accepted command"),
      tone: "online"
    };
  }

  return {
    title: "Edge acknowledged mission command",
    detail: commandAckDetail(context),
    tone: toneForAckStatus(context.status)
  };
}

/** Explains edge acknowledgements while keeping ACK status visible but readable. */
function commandAckDetail(context: EventSummaryContext): string {
  const status = context.status
    ? `edge ${humanizeReasonCode(context.status).toLowerCase()}`
    : "edge acknowledged";
  const reason = context.reason
    ? `reason: ${formatReasonText(context.reason)}`
    : undefined;
  return joinDetail([
    status,
    idFragment("mission", context.missionId),
    idFragment("robot", context.robotId),
    idFragment("command", context.commandId),
    sequenceFragment(context),
    reason
  ]);
}

/** Creates the rejected/blocked mission wording using domain safety reason codes. */
function missionRejectedSummary(
  context: EventSummaryContext
): EventSummaryCopy {
  const safetyBlocked = context.reason
    ? isSafetyBlockReason(context.reason)
    : false;
  const reason = context.reason
    ? formatRejectionReason(context.reason)
    : undefined;

  return {
    title: safetyBlocked ? "Mission safety blocked" : "Mission rejected",
    detail: reasonDetail(
      context,
      safetyBlocked ? "Blocked before dispatch" : "Rejected before dispatch",
      reason
    ),
    tone: safetyBlocked ? "degraded" : "danger"
  };
}

/** Shows a mission-scoped detail line with ids first and the operator reason last. */
function reasonDetail(
  context: EventSummaryContext,
  prefix: string,
  reason: string | undefined
): string {
  return joinDetail([
    prefix,
    idFragment("mission", context.missionId),
    idFragment("robot", context.robotId),
    idFragment("command", context.commandId),
    reason ? `reason: ${truncateDetail(reason)}` : undefined
  ]);
}

/** Summarizes telemetry heartbeats with connection, health, battery, and active mission. */
function telemetryDetail(context: EventSummaryContext): string {
  return joinDetail([
    idFragment("robot", context.robotId),
    context.connectionState,
    context.health ? `health ${context.health}` : undefined,
    context.batteryPercent !== undefined
      ? `battery ${Math.round(context.batteryPercent)}%`
      : undefined,
    idFragment("mission", context.missionId)
  ]);
}

/** Explains freshness transitions as state changes instead of raw event names. */
function robotFreshnessSummary(
  context: EventSummaryContext
): EventSummaryCopy {
  const connectionState = context.connectionState;
  const title = connectionState === "ONLINE"
    ? "Robot telemetry recovered"
    : connectionState === "STALE"
      ? "Robot telemetry stale"
      : connectionState === "DEGRADED"
        ? "Robot telemetry degraded"
        : connectionState === "OFFLINE"
          ? "Robot offline"
          : "Robot connection changed";

  return {
    title,
    detail: joinDetail([
      idFragment("robot", context.robotId),
      stateTransition(context.previousConnectionState, context.connectionState),
      idFragment("mission", context.missionId)
    ]),
    tone: toneForConnectionName(connectionState)
  };
}

/** Keeps edge connection events short while retaining session ids when present. */
function edgeDetail(context: EventSummaryContext, prefix: string): string {
  return joinDetail([
    prefix,
    idFragment("robot", context.robotId),
    idFragment("session", context.edgeSessionId)
  ]);
}

/** Explains that reconnect is active and which previous state led into it. */
function reconnectStartDetail(context: EventSummaryContext): string {
  return joinDetail([
    "Cloud is comparing robot and mission state",
    idFragment("robot", context.robotId),
    idFragment("mission", context.missionId),
    context.previousConnectionState
      ? `previous ${context.previousConnectionState}`
      : undefined
  ]);
}

/** Converts reconciliation outcomes into recovered/manual-review incident copy. */
function reconciliationCompletedSummary(
  context: EventSummaryContext
): EventSummaryCopy {
  if (context.outcome === "MANUAL_REVIEW") {
    return {
      title: "Reconnect needs manual review",
      detail: reconciliationDetail(context, "Manual review required"),
      tone: "danger"
    };
  }

  if (context.outcome === "MARK_FAILED") {
    return {
      title: "Reconnect reconciled, mission failed",
      detail: reconciliationDetail(context, "Mission marked failed"),
      tone: "danger"
    };
  }

  if (context.outcome === "MARK_SUCCEEDED") {
    return {
      title: "Reconnect reconciled, mission succeeded",
      detail: reconciliationDetail(context, "Mission marked succeeded"),
      tone: "online"
    };
  }

  return {
    title: "Reconnect reconciled, mission recovered",
    detail: reconciliationDetail(context, "Mission can continue"),
    tone: "online"
  };
}

/** Renders reconciliation ids, sequence, and decision reason without raw JSON. */
function reconciliationDetail(context: EventSummaryContext, prefix: string): string {
  return joinDetail([
    prefix,
    idFragment("mission", context.missionId),
    idFragment("robot", context.robotId),
    context.outcome ? humanizeReasonCode(context.outcome) : undefined,
    sequenceFragment(context),
    context.reason ? `reason: ${formatReasonText(context.reason)}` : undefined
  ]);
}

/** Reuses robot id copy for demo actions where no mission exists yet. */
function robotDetail(context: EventSummaryContext, prefix: string): string {
  return joinDetail([prefix, idFragment("robot", context.robotId)]);
}

/** Describes mission progress events that may not have command ids. */
function missionDetail(context: EventSummaryContext, prefix: string): string {
  return joinDetail([
    prefix,
    idFragment("mission", context.missionId),
    idFragment("robot", context.robotId)
  ]);
}

/** Builds an unknown-event detail from safe scalar fields only. */
function fallbackDetail(context: EventSummaryContext): string {
  return joinDetail([
    sourceLabel(context.streamType),
    idFragment("robot", context.robotId),
    idFragment("mission", context.missionId),
    idFragment("command", context.commandId),
    context.aggregateId &&
    context.aggregateId !== context.robotId &&
    context.aggregateId !== context.missionId &&
    context.aggregateId !== context.commandId
      ? idFragment(context.aggregateType ?? "aggregate", context.aggregateId)
      : undefined,
    stateTransition(context.previousConnectionState, context.connectionState),
    context.status ? `status ${humanizeReasonCode(context.status)}` : undefined,
    context.outcome ? humanizeReasonCode(context.outcome) : undefined,
    sequenceFragment(context),
    context.reason ? `reason: ${formatReasonText(context.reason)}` : undefined
  ]);
}

/** Infers a conservative tone for unknown events from semantic fields, not raw JSON. */
function inferTone(context: EventSummaryContext): StatusTone {
  const connectionTone = toneForConnectionName(context.connectionState);
  if (connectionTone !== "neutral") {
    return connectionTone;
  }

  if (context.outcome === "MANUAL_REVIEW" || context.outcome === "MARK_FAILED") {
    return "danger";
  }
  if (context.outcome) {
    return "online";
  }
  if (context.status) {
    return toneForAckStatus(context.status);
  }
  if (context.reason) {
    return isSafetyBlockReason(context.reason) ? "degraded" : "danger";
  }
  if (context.name.includes("reconnect") || context.name.includes("reconcil")) {
    return "reconnecting";
  }
  if (context.name.includes("offline") || context.name.includes("failed")) {
    return "danger";
  }
  if (context.name.includes("degraded") || context.name.includes("stale")) {
    return "degraded";
  }
  if (context.name.includes("online") || context.name.includes("received")) {
    return "online";
  }
  return "neutral";
}

/** Joins detail fragments with the UI's compact separator and a stable empty fallback. */
function joinDetail(fragments: ReadonlyArray<string | undefined>): string {
  const detail = fragments
    .filter((fragment): fragment is string => Boolean(fragment))
    .join(" · ");
  return detail.length > 0 ? detail : "No additional details";
}

/** Formats labeled ids consistently while allowing long values to wrap in CSS. */
function idFragment(label: string, value: string | undefined): string | undefined {
  return value ? `${label} ${value}` : undefined;
}

/** Formats command sequence values while preserving zero. */
function sequenceFragment(context: EventSummaryContext): string | undefined {
  const sequence = context.sequence ?? context.lastSeenCommandSequence;
  return sequence === undefined ? undefined : `seq ${sequence}`;
}

/** Formats connection transitions as compact "old -> new" copy. */
function stateTransition(
  previous: string | undefined,
  next: string | undefined
): string | undefined {
  if (previous && next) {
    return `${previous} -> ${next}`;
  }
  return next;
}

/** Names the stream source without exposing raw JSON. */
function sourceLabel(streamType: PlatformStreamEvent["type"]): string {
  if (streamType === "domain") {
    return "Domain event";
  }
  if (streamType === "audit") {
    return "Audit event";
  }
  return "Platform event";
}

/** Maps string connection states into the shared operator tone palette. */
function toneForConnectionName(state: string | undefined): StatusTone {
  if (state === "ONLINE") {
    return "online";
  }
  if (state === "STALE") {
    return "stale";
  }
  if (state === "DEGRADED") {
    return "degraded";
  }
  if (state === "OFFLINE") {
    return "offline";
  }
  if (state === "RECONNECTING") {
    return "reconnecting";
  }
  return "neutral";
}

/** Maps edge ack status to the severity operators need in the feed. */
function toneForAckStatus(status: string | undefined): StatusTone {
  if (!status || status === "ACCEPTED" || status === "DUPLICATE") {
    return "online";
  }
  if (status === "REJECTED" || status === "EXPIRED" || status === "FAILED") {
    return "danger";
  }
  return "neutral";
}

/** Identifies dispatch rejections that are safety blocks rather than bad requests. */
function isSafetyBlockReason(reason: string): boolean {
  return [
    "LOW_BATTERY",
    "RECONCILIATION_IN_PROGRESS",
    "ROBOT_ALREADY_ASSIGNED",
    "ROBOT_TELEMETRY_STALE"
  ].includes(reason);
}

/** Keeps free-text reasons readable while still formatting known reason codes. */
function formatReasonText(reason: string): string {
  if (/^[A-Z0-9_]+$/.test(reason)) {
    return formatRejectionReason(reason) ?? humanizeReasonCode(reason);
  }
  return truncateDetail(reason);
}

/** Prevents exceptionally long backend reasons from taking over the feed. */
function truncateDetail(value: string, maxLength: number = 180): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 3)}...`;
}

/** Converts event/action names into title case fallback copy. */
function humanizeEventName(name: string): string {
  const words = name
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return "Platform event";
  }

  return words
    .map((word, index) => {
      const normalized = word.toLowerCase();
      return index === 0
        ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`
        : normalized;
    })
    .join(" ");
}

/** Reads one string property from a JSON-like object. */
function readString(
  value: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

/** Reads one finite numeric property from a JSON-like object. */
function readNumber(
  value: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
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
