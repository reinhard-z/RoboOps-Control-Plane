import { FleetPlatformApiClient } from "./api-client.js";
import {
  appendRobotPoseTrail,
  createRobotMapModel
} from "./map-view-model.js";
import {
  renderActionMessage,
  renderMissionRows,
  renderSelectedMissionDetails
} from "./mission-dom.js";
import {
  formatBattery,
  formatCancelRejectionMessage,
  formatCommandRejectionMessage,
  formatRelativeTime,
  isActiveMissionState,
  missionCreationAvailability,
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
  MissionSnapshot,
  PlatformStreamEvent,
  Pose2D,
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
  poseTrail: readonly Pose2D[];
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
  readonly mapFrame: HTMLElement;
  readonly mapStatus: HTMLElement;
  readonly mapPose: HTMLElement;
  readonly mapTarget: HTMLElement;
  readonly mapTrail: SVGPolylineElement;
  readonly mapTargetLine: SVGLineElement;
  readonly mapTargetMarker: SVGGElement;
  readonly mapRobotMarker: SVGGElement;
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
  poseTrail: [],
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
    state.poseTrail = appendRobotPoseTrail(state.poseTrail, robot.pose);
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
    state.poseTrail = [];
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
    state.poseTrail = [];
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
  renderRobotMap();
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

  const rows = renderMissionRows(
    document,
    state.missions,
    state.selectedMissionId,
    (missionId) => {
      state.selectedMissionId = missionId;
      render();
    }
  );

  refs.missionList.replaceChildren(...rows);
}

/** Renders lifecycle, operational status, current command, and ack progress. */
function renderMissionDetails(): void {
  renderSelectedMissionDetails(refs, selectedMission());
}

/** Renders the telemetry-driven virtual robot map and active mission target. */
function renderRobotMap(): void {
  const model = createRobotMapModel(state.robot, selectedMission(), state.poseTrail);
  setStatusPill(refs.mapStatus, model.statusLabel, model.statusTone);
  refs.mapPose.textContent = model.poseLabel;
  refs.mapTarget.textContent = model.targetLabel;
  refs.mapFrame.className = `map-frame tone-${model.statusTone}`;
  refs.mapTrail.setAttribute("points", model.trailPoints);

  if (model.robot) {
    refs.mapRobotMarker.setAttribute(
      "transform",
      `translate(${model.robot.point.x} ${model.robot.point.y}) rotate(${model.robot.headingDegrees})`
    );
    refs.mapRobotMarker.setAttribute(
      "class",
      `map-robot-marker tone-${model.statusTone}`
    );
    setSvgVisible(refs.mapRobotMarker, true);
  } else {
    setSvgVisible(refs.mapRobotMarker, false);
  }

  if (model.robot && model.target) {
    refs.mapTargetLine.setAttribute("x1", String(model.robot.point.x));
    refs.mapTargetLine.setAttribute("y1", String(model.robot.point.y));
    refs.mapTargetLine.setAttribute("x2", String(model.target.point.x));
    refs.mapTargetLine.setAttribute("y2", String(model.target.point.y));
    setSvgVisible(refs.mapTargetLine, true);
  } else {
    setSvgVisible(refs.mapTargetLine, false);
  }

  if (model.target) {
    refs.mapTargetMarker.setAttribute(
      "transform",
      `translate(${model.target.point.x} ${model.target.point.y})`
    );
    setSvgVisible(refs.mapTargetMarker, true);
  } else {
    setSvgVisible(refs.mapTargetMarker, false);
  }
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
  renderActionMessage(
    refs.actionMessage,
    state.actionMessage,
    state.actionMessageIsError
  );
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

/** Toggles SVG elements without relying on HTMLElement-only hidden semantics. */
function setSvgVisible(element: SVGElement, visible: boolean): void {
  element.style.display = visible ? "" : "none";
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
    mapFrame: requiredElement("map-frame"),
    mapStatus: requiredElement("map-status"),
    mapPose: requiredElement("map-pose"),
    mapTarget: requiredElement("map-target"),
    mapTrail: requiredElement<SVGPolylineElement>("map-trail"),
    mapTargetLine: requiredElement<SVGLineElement>("map-target-line"),
    mapTargetMarker: requiredElement<SVGGElement>("map-target-marker"),
    mapRobotMarker: requiredElement<SVGGElement>("map-robot-marker"),
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
function optionalElement<T extends Element = HTMLElement>(id: string): T | undefined {
  const element = document.getElementById(id);
  return element ? element as unknown as T : undefined;
}

/** Returns a typed DOM element or fails fast for broken HTML templates. */
function requiredElement<T extends Element = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`missing required element #${id}`);
  }
  return element as unknown as T;
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
