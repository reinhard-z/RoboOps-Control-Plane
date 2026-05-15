import { FleetPlatformApiClient } from "./api-client.js";
import {
  formatBattery,
  formatCancelRejectionMessage,
  formatCommandRejectionMessage,
  formatMissionFailureReason,
  formatRelativeTime,
  isActiveMissionState,
  missionCreationAvailability,
  missionStateSummary,
  parsePoseNumber,
  selectDefaultMission,
  sortMissions,
  statusToneForConnection,
  statusToneForHealth,
  statusToneForMission,
  summarizeStreamEvent,
  telemetryAgeMs,
  type EventSummary,
  type StatusTone
} from "./view-model.js";
import type {
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
  readonly demo?: {
    readonly adminToken: string;
  };
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
  busyAction:
    | "create"
    | "cancel"
    | "demo-reset"
    | "demo-start"
    | "demo-stale"
    | "demo-reconnect"
    | undefined;
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
  readonly demoResetButton?: HTMLButtonElement;
  readonly demoStartButton?: HTMLButtonElement;
  readonly demoStaleButton?: HTMLButtonElement;
  readonly demoReconnectButton?: HTMLButtonElement;
  readonly actionMessage: HTMLElement;
  readonly missionList: HTMLElement;
  readonly missionId: HTMLElement;
  readonly missionState: HTMLElement;
  readonly missionStateDetail: HTMLElement;
  readonly missionLifecycle: HTMLElement;
  readonly missionOperational: HTMLElement;
  readonly missionCommand: HTMLElement;
  readonly missionAck: HTMLElement;
  readonly missionReason: HTMLElement;
  readonly eventFeed: HTMLElement;
}

const config = readBrowserConfig();
const api = new FleetPlatformApiClient({
  apiBaseUrl: config.apiBaseUrl,
  ...(config.demo ? { demoAdminToken: config.demo.adminToken } : {})
});
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
  refs.demoResetButton?.addEventListener("click", () => {
    void resetDemoState();
  });
  refs.demoStartButton?.addEventListener("click", () => {
    void startCleanDemoMission();
  });
  refs.demoStaleButton?.addEventListener("click", () => {
    void triggerDemoStaleTelemetry();
  });
  refs.demoReconnectButton?.addEventListener("click", () => {
    void triggerDemoReconnect();
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
    const [robot, missions] = await Promise.all([
      api.getRobot(config.robotId),
      api.listMissions()
    ]);

    state.robot = robot;
    state.missions = sortMissions(missions);
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
  const availability = missionCreationAvailability(state.missions, state.robot);
  if (!availability.canCreate) {
    state.actionMessage =
      availability.message ?? "Cancel or finish the active mission first.";
    state.actionMessageIsError = true;
    render();
    return;
  }

  state.busyAction = "create";
  state.actionMessage = "Creating mission";
  state.actionMessageIsError = false;
  render();

  try {
    const body = await api.createGoToPoseMission(config.robotId, readPoseTarget());

    if (body.result.mission) {
      state.selectedMissionId = body.result.mission.missionId;
    }
    if (body.result.status === "ACCEPTED") {
      state.actionMessage = `Mission dispatched (${body.deliveryCount} edge delivery)`;
    } else if (body.result.status === "IDEMPOTENT_REPLAY") {
      state.actionMessage = "Mission request already dispatched";
    } else {
      state.actionMessage = formatCommandRejectionMessage(body.result.reason);
    }
    state.actionMessageIsError = body.result.status === "REJECTED";
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
    const body = await api.cancelMission(
      mission.missionId,
      "operator requested cancel from UI"
    );
    if (body.result.status === "ACCEPTED") {
      state.actionMessage = `Cancel dispatched (${body.deliveryCount} edge delivery)`;
    } else if (body.result.status === "IDEMPOTENT_REPLAY") {
      state.actionMessage = "Cancel request already dispatched";
    } else {
      state.actionMessage = formatCancelRejectionMessage(body.result.reason);
    }
    state.actionMessageIsError = body.result.status === "REJECTED";
    await refreshSnapshot();
  } catch (error) {
    state.actionMessage = errorMessage(error);
    state.actionMessageIsError = true;
  } finally {
    state.busyAction = undefined;
    render();
  }
}

/** Resets in-memory platform state back to a clean robot-a demo baseline. */
async function resetDemoState(): Promise<void> {
  state.busyAction = "demo-reset";
  state.actionMessage = "Resetting demo state";
  state.actionMessageIsError = false;
  render();

  try {
    await api.resetDemoState();
    state.selectedMissionId = undefined;
    state.events = [];
    state.actionMessage = "Demo state reset";
    await refreshSnapshot();
  } catch (error) {
    state.actionMessage = errorMessage(error);
    state.actionMessageIsError = true;
  } finally {
    state.busyAction = undefined;
    render();
  }
}

/** Runs a clean normal incident start by clearing stale demo state before dispatch. */
async function startCleanDemoMission(): Promise<void> {
  state.busyAction = "demo-start";
  state.actionMessage = "Starting clean demo mission";
  state.actionMessageIsError = false;
  render();

  try {
    await api.resetDemoState();
    state.events = [];
    state.selectedMissionId = undefined;
    const body = await api.startIncidentDemo();
    if (body.result.mission) {
      state.selectedMissionId = body.result.mission.missionId;
    }
    if (body.result.status === "ACCEPTED") {
      state.actionMessage = `Demo mission dispatched (${body.deliveryCount} edge delivery)`;
    } else if (body.result.status === "IDEMPOTENT_REPLAY") {
      state.actionMessage = "Demo mission request already dispatched";
    } else {
      state.actionMessage = formatCommandRejectionMessage(body.result.reason);
    }
    state.actionMessageIsError = body.result.status === "REJECTED";
    await refreshSnapshot();
  } catch (error) {
    state.actionMessage = errorMessage(error);
    state.actionMessageIsError = true;
  } finally {
    state.busyAction = undefined;
    render();
  }
}

/** Forces the local demo robot through the stale telemetry freshness path. */
async function triggerDemoStaleTelemetry(): Promise<void> {
  state.busyAction = "demo-stale";
  state.actionMessage = "Marking telemetry stale";
  state.actionMessageIsError = false;
  render();

  try {
    await api.markDemoTelemetryStale();
    state.actionMessage = "Telemetry marked stale";
    await refreshSnapshot();
  } catch (error) {
    state.actionMessage = errorMessage(error);
    state.actionMessageIsError = true;
  } finally {
    state.busyAction = undefined;
    render();
  }
}

/** Drives the local demo robot through reconnect reconciliation without restarting processes. */
async function triggerDemoReconnect(): Promise<void> {
  state.busyAction = "demo-reconnect";
  state.actionMessage = "Running reconnect";
  state.actionMessageIsError = false;
  render();

  try {
    await api.reconnectDemoRobot();
    state.actionMessage = "Reconnect processed";
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
  const stream = new EventSource(api.eventStreamUrl());
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
    copy.className = "mission-copy";
    const id = document.createElement("span");
    id.className = "mission-id";
    id.textContent = mission.missionId;
    const meta = document.createElement("span");
    meta.className = "mission-meta";
    meta.textContent = `${mission.lifecycleState} · ${formatRelativeTime(mission.updatedAt)}`;
    const reason = formatMissionFailureReason(mission);
    if (reason) {
      const reasonText = document.createElement("span");
      reasonText.className = "mission-reason";
      reasonText.textContent = `Reason: ${reason}`;
      copy.append(id, meta, reasonText);
    } else {
      copy.append(id, meta);
    }

    const status = document.createElement("span");
    status.className = `status-pill tone-${statusToneForMission(mission)}`;
    status.textContent = missionRowStatusLabel(mission);
    button.append(copy, status);
    return button;
  });

  refs.missionList.replaceChildren(...rows);
}

/** Renders lifecycle, operational status, current command, and ack progress. */
function renderMissionDetails(): void {
  const mission = selectedMission();
  if (!mission) {
    refs.missionId.textContent = "none";
    setStatusPill(refs.missionState, "none", "neutral");
    refs.missionStateDetail.textContent = "No mission selected";
    setStatusPill(refs.missionLifecycle, "none", "neutral");
    setStatusPill(refs.missionOperational, "none", "neutral");
    refs.missionCommand.textContent = "none";
    refs.missionAck.textContent = "none";
    refs.missionReason.textContent = "none";
    return;
  }

  const stateSummary = missionStateSummary(mission);
  refs.missionId.textContent = mission.missionId;
  setStatusPill(refs.missionState, stateSummary.label, stateSummary.tone);
  refs.missionStateDetail.textContent = stateSummary.detail;
  setStatusPill(
    refs.missionLifecycle,
    mission.lifecycleState,
    statusToneForMission(mission)
  );
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
  refs.missionReason.textContent = formatMissionFailureReason(mission) ?? "none";
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
  const availability = missionCreationAvailability(state.missions, state.robot);
  refs.actionMessage.textContent = state.actionMessage;
  refs.actionMessage.classList.toggle("error", state.actionMessageIsError);
  refs.createMissionButton.disabled =
    state.busyAction !== undefined || !availability.canCreate;
  refs.createMissionButton.textContent =
    state.busyAction === "create" ? "Creating Mission" : availability.buttonLabel;
  refs.createMissionButton.title = availability.message ?? "";
  refs.cancelMissionButton.disabled =
    state.busyAction !== undefined ||
    !mission ||
    !isActiveMissionState(mission.lifecycleState);
  for (const button of [
    refs.demoResetButton,
    refs.demoStartButton,
    refs.demoStaleButton,
    refs.demoReconnectButton
  ]) {
    if (button) {
      button.disabled = state.busyAction !== undefined;
    }
  }
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

/** Shows mission state categories in rows when operational status is generic. */
function missionRowStatusLabel(mission: MissionSnapshot): string {
  const stateSummary = missionStateSummary(mission);
  if (stateSummary.kind === "blocked") {
    return "BLOCKED";
  }

  if (stateSummary.kind === "manual-review") {
    return "REVIEW";
  }

  if (stateSummary.kind === "terminal") {
    return mission.lifecycleState;
  }

  return mission.operationalStatus;
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
    pollIntervalMs: injected?.pollIntervalMs ?? 2_000,
    ...(isBrowserDemoConfig(injected?.demo) ? { demo: injected.demo } : {})
  };
}

/** Finds required DOM nodes at startup so render functions can stay simple. */
function collectViewRefs(): ViewRefs {
  const demoResetButton = optionalElement<HTMLButtonElement>("demo-reset-button");
  const demoStartButton = optionalElement<HTMLButtonElement>("demo-start-button");
  const demoStaleButton = optionalElement<HTMLButtonElement>("demo-stale-button");
  const demoReconnectButton =
    optionalElement<HTMLButtonElement>("demo-reconnect-button");

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
    ...(demoResetButton ? { demoResetButton } : {}),
    ...(demoStartButton ? { demoStartButton } : {}),
    ...(demoStaleButton ? { demoStaleButton } : {}),
    ...(demoReconnectButton ? { demoReconnectButton } : {}),
    actionMessage: requiredElement("action-message"),
    missionList: requiredElement("mission-list"),
    missionId: requiredElement("mission-id"),
    missionState: requiredElement("mission-state"),
    missionStateDetail: requiredElement("mission-state-detail"),
    missionLifecycle: requiredElement("mission-lifecycle"),
    missionOperational: requiredElement("mission-operational"),
    missionCommand: requiredElement("mission-command"),
    missionAck: requiredElement("mission-ack"),
    missionReason: requiredElement("mission-reason"),
    eventFeed: requiredElement("event-feed")
  };
}

/** Reads an optional DOM node when demo-only controls are not rendered. */
function optionalElement<T extends HTMLElement>(id: string): T | undefined {
  const element = document.getElementById(id);
  return element ? element as T : undefined;
}

/** Returns a typed DOM element or fails fast for broken HTML templates. */
function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`missing required element #${id}`);
  }
  return element as T;
}

/** Validates injected demo config before enabling protected UI actions. */
function isBrowserDemoConfig(
  value: unknown
): value is NonNullable<BrowserOperatorConfig["demo"]> {
  return (
    isRecord(value) &&
    typeof value["adminToken"] === "string" &&
    value["adminToken"].length > 0
  );
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
