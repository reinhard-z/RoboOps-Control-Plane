import type { MissionSnapshot } from "./types.js";
import {
  formatMissionFailureReason,
  formatRelativeTime,
  missionStateSummary,
  statusToneForMission,
  type StatusTone
} from "./view-model.js";

/** DOM factory surface needed to build mission rows in browser or tests. */
export interface MissionElementFactory {
  createElement<K extends keyof HTMLElementTagNameMap>(
    tagName: K
  ): HTMLElementTagNameMap[K];
}

/** Mission detail nodes updated together from the selected mission snapshot. */
export interface MissionDetailRefs {
  readonly missionId: HTMLElement;
  readonly missionState: HTMLElement;
  readonly missionStateDetail: HTMLElement;
  readonly missionLifecycle: HTMLElement;
  readonly missionOperational: HTMLElement;
  readonly missionCommand: HTMLElement;
  readonly missionAck: HTMLElement;
  readonly missionReason: HTMLElement;
}

/** Builds the mission list rows with stable labels, tones, and click behavior. */
export function renderMissionRows(
  documentRef: MissionElementFactory,
  missions: readonly MissionSnapshot[],
  selectedMissionId: string | undefined,
  onSelectMission: (missionId: string) => void
): readonly HTMLElement[] {
  return missions.map((mission) => {
    const button = documentRef.createElement("button");
    button.type = "button";
    button.className = mission.missionId === selectedMissionId
      ? "mission-row selected"
      : "mission-row";
    button.addEventListener("click", () => {
      onSelectMission(mission.missionId);
    });

    const copy = documentRef.createElement("span");
    copy.className = "mission-copy";
    const id = documentRef.createElement("span");
    id.className = "mission-id";
    id.textContent = mission.missionId;
    const meta = documentRef.createElement("span");
    meta.className = "mission-meta";
    meta.textContent = `${mission.lifecycleState} · ${formatRelativeTime(mission.updatedAt)}`;
    const reason = formatMissionFailureReason(mission);
    if (reason) {
      const reasonText = documentRef.createElement("span");
      reasonText.className = "mission-reason";
      reasonText.textContent = `Reason: ${reason}`;
      copy.append(id, meta, reasonText);
    } else {
      copy.append(id, meta);
    }

    const status = documentRef.createElement("span");
    status.className = `status-pill tone-${statusToneForMission(mission)}`;
    status.textContent = missionRowStatusLabel(mission);
    button.append(copy, status);
    return button;
  });
}

/** Renders selected mission details while preserving long ids and command text. */
export function renderSelectedMissionDetails(
  refs: MissionDetailRefs,
  mission: MissionSnapshot | undefined
): void {
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
    statusToneForOperationalStatus(mission.operationalStatus)
  );
  refs.missionCommand.textContent = formatCommandProgress(
    mission.currentCommandId,
    mission.lastCommandSequence
  );
  refs.missionAck.textContent = formatCommandProgress(
    mission.lastAcknowledgedCommandId,
    mission.lastAcknowledgedCommandSequence
  );
  refs.missionReason.textContent = formatMissionFailureReason(mission) ?? "none";
}

/** Updates the operator action message without leaking stale error styling. */
export function renderActionMessage(
  element: HTMLElement,
  message: string,
  isError: boolean
): void {
  element.textContent = message;
  element.classList.toggle("error", isError);
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

/** Maps mission operational status into the shared status pill tones. */
function statusToneForOperationalStatus(
  operationalStatus: MissionSnapshot["operationalStatus"]
): StatusTone {
  if (operationalStatus === "NOMINAL" || operationalStatus === "RECOVERED") {
    return "online";
  }

  if (
    operationalStatus === "RECONNECTING" ||
    operationalStatus === "RECONCILING"
  ) {
    return "reconnecting";
  }

  return "degraded";
}

/** Formats command ids with sequence zero preserved as a valid value. */
function formatCommandProgress(
  commandId: string | undefined,
  sequence: number | undefined
): string {
  if (!commandId) {
    return "none";
  }

  return sequence === undefined ? commandId : `${commandId} · seq ${sequence}`;
}

/** Sets status pill text and tone in one place to prevent stale CSS classes. */
function setStatusPill(element: HTMLElement, label: string, tone: StatusTone): void {
  element.textContent = label;
  element.className = `status-pill tone-${tone}`;
}
