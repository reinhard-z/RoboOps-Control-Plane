import {
  formatBattery,
  formatRelativeTime,
  isActiveMissionState,
  parsePoseNumber,
  selectDefaultMission,
  sortMissions,
  statusToneForConnection,
  statusToneForHealth,
  summarizeStreamEvent,
  telemetryAgeMs,
  type EventSummary,
  type StatusTone
} from "./view-model.js";
import type {
  MissionCommandResponse,
  MissionSnapshot,
  PlatformStreamEvent,
  PoseTarget,
  RobotSnapshot
} from "./types.js";

declare global {
  interface Window {
    readonly __ROBOOPS_OPERATOR_CONFIG__?: BrowserOperatorConfig;
  }
}

/** Browser runtime config injected by the Operator UI server. */
interface BrowserOperatorConfig {
  readonly apiBaseUrl: string;
  readonly robotId: string;
  readonly pollIntervalMs: number;
}

/** Mutable UI state kept small enough to render directly without a framework. */
interface AppState {
  robot: RobotSnapshot | undefined;
  missions: readonly MissionSnapshot[];
  selectedMissionId: string | undefined;
  events: readonly EventSummary[];
  streamState: "CONNECTING" | "OPEN" | "RECONNECTING";
  actionMessage: string;
  actionMessageIsError: boolean;
  busyAction: "create" | "cancel" | undefined;
}

/** Cached DOM references for the single-page console. */
interface ViewRefs {
  readonly apiLabel: HTMLElement;
  readonly streamDot: HTMLElement;
  readonly streamLabel: HTMLElement;
  readonly robotHeading: HTMLElement;
  readonly robotConnection: HTMLElement;
  readonly robotHealth: HTMLElement;
  readonly robotBattery: HTMLElement;
  readonly robotTelemetryAge: HTMLElement;
  readonly robotTelemetryTime: HTMLElement;
  readonly robotAgent: HTMLElement;
  readonly missionForm: HTMLFormElement;
  readonly targetX: HTMLInputElement;
  readonly targetY: HTMLInputElement;
  readonly targetTheta: HTMLInputElement;
  readonly createMissionButton: HTMLButtonElement;
  readonly cancelMissionButton: HTMLButtonElement;
  readonly actionMessage: HTMLElement;
  readonly missionList: HTMLElement;
  readonly missionLifecycle: HTMLElement;
  readonly missionOperational: HTMLElement;
  readonly missionCommand: HTMLElement;
  readonly missionAck: HTMLElement;
  readonly eventFeed: HTMLElement;
}

const config = readBrowserConfig();
const state: AppState = {
  robot: undefined,
  missions: [],
  selectedMissionId: undefined,
  events: [],
  streamState: "CONNECTING",
  actionMessage: "",
  actionMessageIsError: false,
  busyAction: undefined
};
const refs = collectViewRefs();
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let relativeTimer: ReturnType<typeof setInterval> | undefined;
let pollingTimer: ReturnType<typeof setInterval> | undefined;

void boot();

/** Starts polling, event streaming, and form handlers once the DOM is ready. */
async function boot(): Promise<void> {
  refs.apiLabel.textContent = config.apiBaseUrl;
  refs.robotHeading.textContent = config.robotId;
  refs.missionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void createMission();
  });
  refs.cancelMissionButton.addEventListener("click", () => {
    void cancelSelectedMission();
  });

  await refreshSnapshot();
  connectEventStream();
  pollingTimer = setInterval(() => {
    void refreshSnapshot();
  }, config.pollIntervalMs);
  relativeTimer = setInterval(renderRelativeTimes, 1_000);
}

/** Loads robot and mission snapshots from Fleet Platform concurrently. */
async function refreshSnapshot(): Promise<void> {
  try {
    const [robotBody, missionsBody] = await Promise.all([
      requestJson<{ readonly robot: RobotSnapshot }>(
        `/robots/${encodeURIComponent(config.robotId)}`
      ),
      requestJson<{ readonly missions: readonly MissionSnapshot[] }>("/missions")
    ]);

    state.robot = robotBody.robot;
    state.missions = sortMissions(missionsBody.missions);
    const selected = selectDefaultMission(
      state.missions,
      state.robot,
      state.selectedMissionId
    );
    state.selectedMissionId = selected?.missionId;
    render();
  } catch (error) {
    state.actionMessage = errorMessage(error);
    state.actionMessageIsError = true;
    render();
  }
}

/** Creates a GO_TO_POSE mission for the configured demo robot. */
async function createMission(): Promise<void> {
  state.busyAction = "create";
  state.actionMessage = "Creating mission";
  state.actionMessageIsError = false;
  render();

  try {
    const body = await requestJson<MissionCommandResponse>("/missions", {
      method: "POST",
      body: {
        robotId: config.robotId,
        type: "GO_TO_POSE",
        safetyClass: "NORMAL",
        payload: { target: readPoseTarget() }
      }
    });

    if (body.result.mission) {
      state.selectedMissionId = body.result.mission.missionId;
    }
    state.actionMessage =
      body.result.status === "ACCEPTED"
        ? `Mission dispatched (${body.deliveryCount} edge delivery)`
        : `Mission ${body.result.status.toLowerCase()}`;
    await refreshSnapshot();
  } catch (error) {
    state.actionMessage = errorMessage(error);
    state.actionMessageIsError = true;
  } finally {
    state.busyAction = undefined;
    render();
  }
}

/** Sends a cancel command for the selected mission when it is still active. */
async function cancelSelectedMission(): Promise<void> {
  const mission = selectedMission();
  if (!mission || !isActiveMissionState(mission.lifecycleState)) {
    return;
  }

  state.busyAction = "cancel";
  state.actionMessage = "Requesting cancellation";
  state.actionMessageIsError = false;
  render();

  try {
    const body = await requestJson<MissionCommandResponse>(
      `/missions/${encodeURIComponent(mission.missionId)}/cancel`,
      {
        method: "POST",
        body: { reason: "operator requested cancel from UI" }
      }
    );
    state.actionMessage =
      body.result.status === "ACCEPTED"
        ? `Cancel dispatched (${body.deliveryCount} edge delivery)`
        : `Cancel ${body.result.status.toLowerCase()}`;
    await refreshSnapshot();
  } catch (error) {
    state.actionMessage = errorMessage(error);
    state.actionMessageIsError = true;
  } finally {
    state.busyAction = undefined;
    render();
  }
}

/** Opens the Fleet Platform SSE feed and refreshes snapshots after each event. */
function connectEventStream(): void {
  const stream = new EventSource(apiUrl("/stream/events"));
  for (const eventType of ["platform", "domain", "audit"] as const) {
    stream.addEventListener(eventType, (event) => {
      handleStreamMessage(event as MessageEvent<string>);
    });
  }

  stream.addEventListener("open", () => {
    state.streamState = "OPEN";
    renderStreamState();
  });
  stream.addEventListener("error", () => {
    state.streamState = "RECONNECTING";
    renderStreamState();
  });
}

/** Parses one SSE message and queues a near-term snapshot refresh. */
function handleStreamMessage(event: MessageEvent<string>): void {
  const parsed = parseStreamEvent(event.data);
  if (!parsed) {
    return;
  }

  state.events = [summarizeStreamEvent(parsed), ...state.events].slice(0, 60);
  renderEvents();
  scheduleRefresh();
}

/** Debounces refreshes so paired domain/audit events only cause one read burst. */
function scheduleRefresh(): void {
  if (refreshTimer) {
    return;
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refreshSnapshot();
  }, 150);
}

/** Renders every visible console region from current state. */
function render(): void {
  renderStreamState();
  renderRobot();
  renderMissions();
  renderMissionDetails();
  renderEvents();
  renderActionState();
}

/** Renders robot freshness, health, battery, and agent metadata. */
function renderRobot(): void {
  const robot = state.robot;
  const connectionState = robot?.connectionState ?? "UNKNOWN";
  setStatusPill(
    refs.robotConnection,
    connectionState,
    statusToneForConnection(robot?.connectionState)
  );
  setStatusPill(
    refs.robotHealth,
    robot?.health ?? "unknown",
    statusToneForHealth(robot?.health)
  );
  refs.robotBattery.textContent = formatBattery(robot?.batteryPercent);
  refs.robotTelemetryTime.textContent = robot?.lastTelemetryReceivedAt ?? "";
  refs.robotAgent.textContent = robot?.edgeAgentVersion ?? "unknown";
  renderRelativeTimes();
}

/** Renders the mission list with selected mission state preserved. */
function renderMissions(): void {
  if (state.missions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No missions";
    refs.missionList.replaceChildren(empty);
    return;
  }

  const rows = state.missions.map((mission) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = mission.missionId === state.selectedMissionId
      ? "mission-row selected"
      : "mission-row";
    button.addEventListener("click", () => {
      state.selectedMissionId = mission.missionId;
      render();
    });

    const copy = document.createElement("span");
    const id = document.createElement("span");
    id.className = "mission-id";
    id.textContent = mission.missionId;
    const meta = document.createElement("span");
    meta.className = "mission-meta";
    meta.textContent = `${mission.lifecycleState} · ${formatRelativeTime(mission.updatedAt)}`;
    copy.append(id, meta);

    const status = document.createElement("span");
    status.className = `status-pill tone-${missionTone(mission)}`;
    status.textContent = mission.operationalStatus;
    button.append(copy, status);
    return button;
  });

  refs.missionList.replaceChildren(...rows);
}

/** Renders lifecycle, operational status, current command, and ack progress. */
function renderMissionDetails(): void {
  const mission = selectedMission();
  if (!mission) {
    setStatusPill(refs.missionLifecycle, "none", "neutral");
    setStatusPill(refs.missionOperational, "none", "neutral");
    refs.missionCommand.textContent = "none";
    refs.missionAck.textContent = "none";
    return;
  }

  setStatusPill(refs.missionLifecycle, mission.lifecycleState, missionTone(mission));
  setStatusPill(
    refs.missionOperational,
    mission.operationalStatus,
    mission.operationalStatus === "NOMINAL" || mission.operationalStatus === "RECOVERED"
      ? "online"
      : mission.operationalStatus === "RECONNECTING" ||
          mission.operationalStatus === "RECONCILING"
        ? "reconnecting"
        : "degraded"
  );
  refs.missionCommand.textContent = mission.currentCommandId
    ? `${mission.currentCommandId}${mission.lastCommandSequence ? ` · seq ${mission.lastCommandSequence}` : ""}`
    : "none";
  refs.missionAck.textContent = mission.lastAcknowledgedCommandId
    ? `${mission.lastAcknowledgedCommandId}${mission.lastAcknowledgedCommandSequence ? ` · seq ${mission.lastAcknowledgedCommandSequence}` : ""}`
    : "none";
}

/** Renders the bounded live event feed. */
function renderEvents(): void {
  if (state.events.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "Waiting for events";
    refs.eventFeed.replaceChildren(empty);
    return;
  }

  const items = state.events.map((event) => {
    const item = document.createElement("li");
    item.className = `event-item tone-${event.tone}`;

    const title = document.createElement("p");
    title.className = "event-title";
    title.textContent = event.title;
    const detail = document.createElement("p");
    detail.className = "event-detail";
    detail.textContent = event.detail;
    const time = document.createElement("p");
    time.className = "event-time";
    time.textContent = formatRelativeTime(event.occurredAt);

    item.append(title, detail, time);
    return item;
  });

  refs.eventFeed.replaceChildren(...items);
}

/** Renders action feedback and button disabled states. */
function renderActionState(): void {
  const mission = selectedMission();
  refs.actionMessage.textContent = state.actionMessage;
  refs.actionMessage.classList.toggle("error", state.actionMessageIsError);
  refs.createMissionButton.disabled = state.busyAction !== undefined;
  refs.cancelMissionButton.disabled =
    state.busyAction !== undefined ||
    !mission ||
    !isActiveMissionState(mission.lifecycleState);
}

/** Updates relative telemetry and event ages without refetching server state. */
function renderRelativeTimes(): void {
  refs.robotTelemetryAge.textContent = formatRelativeTime(
    state.robot?.lastTelemetryReceivedAt ?? state.robot?.lastTelemetryObservedAt
  );

  const age = telemetryAgeMs(state.robot);
  if (age !== undefined && age >= 5_000 && state.robot?.connectionState === "ONLINE") {
    refs.robotTelemetryAge.textContent += " (stale soon)";
  }

  if (state.events.length > 0) {
    renderEvents();
  }
}

/** Renders the SSE connection state separately from robot connection state. */
function renderStreamState(): void {
  const tone = state.streamState === "OPEN" ? "online" : "reconnecting";
  refs.streamLabel.textContent =
    state.streamState === "OPEN" ? "Events live" : "Events reconnecting";
  refs.streamDot.className = `dot tone-${tone}`;
}

/** Finds the currently selected mission in the latest snapshot. */
function selectedMission(): MissionSnapshot | undefined {
  return selectDefaultMission(
    state.missions,
    state.robot,
    state.selectedMissionId
  );
}

/** Chooses the visual tone for lifecycle and row status pills. */
function missionTone(mission: MissionSnapshot): StatusTone {
  if (mission.lifecycleState === "FAILED" || mission.lifecycleState === "REJECTED") {
    return "danger";
  }
  if (mission.lifecycleState === "SAFETY_BLOCKED" || mission.operationalStatus === "DEGRADED") {
    return "degraded";
  }
  if (
    mission.operationalStatus === "RECONNECTING" ||
    mission.operationalStatus === "RECONCILING"
  ) {
    return "reconnecting";
  }
  if (mission.lifecycleState === "CANCELLED" || mission.lifecycleState === "TIMED_OUT") {
    return "offline";
  }
  return "online";
}

/** Reads the pose form using defaults when a field is blank or invalid. */
function readPoseTarget(): PoseTarget {
  return {
    x: readNumberInput(refs.targetX, 2),
    y: readNumberInput(refs.targetY, 4.5),
    theta: readNumberInput(refs.targetTheta, 1.57)
  };
}

/** Parses one numeric input while keeping the mission button forgiving. */
function readNumberInput(input: HTMLInputElement, fallback: number): number {
  return parsePoseNumber(input.value, fallback);
}

/** Sets status pill text and tone in one place to prevent stale CSS classes. */
function setStatusPill(element: HTMLElement, label: string, tone: StatusTone): void {
  element.textContent = label;
  element.className = `status-pill tone-${tone}`;
}

/** Sends and receives JSON from the Fleet Platform API. */
async function requestJson<T>(
  path: string,
  init: { readonly method?: "GET" | "POST"; readonly body?: unknown } = {}
): Promise<T> {
  const requestInit: RequestInit = { method: init.method ?? "GET" };
  if (init.body !== undefined) {
    requestInit.headers = { "Content-Type": "application/json" };
    requestInit.body = JSON.stringify(init.body);
  }

  const response = await fetch(apiUrl(path), requestInit);
  const text = await response.text();
  const parsedBody = parseJsonResponseBody(text);
  if (!response.ok) {
    const detail = parsedBody.ok
      ? readApiError(parsedBody.value)
      : parsedBody.reason;
    throw new Error(
      detail
        ? `Fleet Platform returned ${response.status}: ${detail}`
        : `Fleet Platform returned ${response.status}`
    );
  }
  if (!parsedBody.ok) {
    throw new Error(parsedBody.reason);
  }
  return parsedBody.value as T;
}

/** Parses JSON responses without hiding HTTP status failures behind SyntaxError. */
function parseJsonResponseBody(
  text: string
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string } {
  if (text.length === 0) {
    return { ok: true, value: undefined };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "response body was not valid JSON" };
  }
}

/** Joins API paths without depending on trailing slash configuration. */
function apiUrl(path: string): string {
  return `${config.apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Extracts Fleet Platform's structured error message when available. */
function readApiError(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body["error"])) {
    return undefined;
  }
  const error = body["error"];
  const code = typeof error["code"] === "string" ? error["code"] : "API_ERROR";
  const message =
    typeof error["message"] === "string" ? error["message"] : "request failed";
  return `${code}: ${message}`;
}

/** Parses the JSON data payload from an SSE browser event. */
function parseStreamEvent(value: string): PlatformStreamEvent | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    const streamEventId = parsed["streamEventId"];
    const type = parsed["type"];
    const occurredAt = parsed["occurredAt"];
    if (
      typeof streamEventId !== "string" ||
      !isStreamType(type) ||
      typeof occurredAt !== "string"
    ) {
      return undefined;
    }
    return {
      streamEventId,
      type,
      occurredAt,
      data: parsed["data"]
    };
  } catch {
    return undefined;
  }
}

/** Validates the named SSE event types produced by Fleet Platform. */
function isStreamType(value: unknown): value is PlatformStreamEvent["type"] {
  return value === "domain" || value === "audit" || value === "platform";
}

/** Converts unknown thrown values into concise operator-facing text. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads injected browser config and applies defensive local defaults. */
function readBrowserConfig(): BrowserOperatorConfig {
  const injected = window.__ROBOOPS_OPERATOR_CONFIG__;
  return {
    apiBaseUrl: injected?.apiBaseUrl ?? "http://127.0.0.1:4010",
    robotId: injected?.robotId ?? "robot-a",
    pollIntervalMs: injected?.pollIntervalMs ?? 2_000
  };
}

/** Finds required DOM nodes at startup so render functions can stay simple. */
function collectViewRefs(): ViewRefs {
  return {
    apiLabel: requiredElement("api-label"),
    streamDot: requiredElement("stream-dot"),
    streamLabel: requiredElement("stream-label"),
    robotHeading: requiredElement("robot-heading"),
    robotConnection: requiredElement("robot-connection"),
    robotHealth: requiredElement("robot-health"),
    robotBattery: requiredElement("robot-battery"),
    robotTelemetryAge: requiredElement("robot-telemetry-age"),
    robotTelemetryTime: requiredElement("robot-telemetry-time"),
    robotAgent: requiredElement("robot-agent"),
    missionForm: requiredElement<HTMLFormElement>("mission-form"),
    targetX: requiredElement<HTMLInputElement>("target-x"),
    targetY: requiredElement<HTMLInputElement>("target-y"),
    targetTheta: requiredElement<HTMLInputElement>("target-theta"),
    createMissionButton: requiredElement<HTMLButtonElement>("create-mission-button"),
    cancelMissionButton: requiredElement<HTMLButtonElement>("cancel-mission-button"),
    actionMessage: requiredElement("action-message"),
    missionList: requiredElement("mission-list"),
    missionLifecycle: requiredElement("mission-lifecycle"),
    missionOperational: requiredElement("mission-operational"),
    missionCommand: requiredElement("mission-command"),
    missionAck: requiredElement("mission-ack"),
    eventFeed: requiredElement("event-feed")
  };
}

/** Returns a typed DOM element or fails fast for broken HTML templates. */
function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`missing required element #${id}`);
  }
  return element as T;
}

/** Checks whether a JSON-like value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

window.addEventListener("beforeunload", () => {
  if (relativeTimer) {
    clearInterval(relativeTimer);
  }
  if (pollingTimer) {
    clearInterval(pollingTimer);
  }
});
