import { describe, expect, it } from "vitest";

import {
  renderActionMessage,
  renderMissionRows,
  renderSelectedMissionDetails,
  type MissionDetailRefs,
  type MissionElementFactory
} from "../src/mission-dom.js";
import { operatorUiStyles } from "../src/styles.js";
import type { MissionSnapshot } from "../src/types.js";
import { formatCancelRejectionMessage } from "../src/view-model.js";

describe("operator UI mission DOM rendering", () => {
  it("renders an explicit empty selected-mission state", () => {
    const { refs, nodes } = createDetailRefs();

    renderSelectedMissionDetails(refs, undefined);

    expect(nodes.missionId.textContent).toBe("none");
    expect(nodes.missionState.textContent).toBe("none");
    expect(nodes.missionStateDetail.textContent).toBe("No mission selected");
    expect(nodes.missionCommand.textContent).toBe("none");
    expect(nodes.missionReason.textContent).toBe("none");
  });

  it("renders selected mission identity, state group, and long command values", () => {
    const longMissionId = `mission-${"selected-active-".repeat(8)}`;
    const longCommandId = `cmd-${"cancel-command-".repeat(8)}`;
    const longAckId = `cmd-${"go-to-pose-ack-".repeat(8)}`;
    const { refs, nodes } = createDetailRefs();

    renderSelectedMissionDetails(
      refs,
      mission(longMissionId, {
        lifecycleState: "CANCEL_REQUESTED",
        operationalStatus: "RECONNECTING",
        currentCommandId: longCommandId,
        lastCommandSequence: 42,
        lastAcknowledgedCommandId: longAckId,
        lastAcknowledgedCommandSequence: 41
      })
    );

    expect(nodes.missionId.textContent).toBe(longMissionId);
    expect(nodes.missionState.textContent).toBe("ACTIVE");
    expect(nodes.missionState.className).toContain("tone-reconnecting");
    expect(nodes.missionStateDetail.textContent).toBe(
      "Cancel requested; waiting for edge acknowledgement"
    );
    expect(nodes.missionLifecycle.textContent).toBe("CANCEL_REQUESTED");
    expect(nodes.missionOperational.textContent).toBe("RECONNECTING");
    expect(nodes.missionCommand.textContent).toBe(`${longCommandId} · seq 42`);
    expect(nodes.missionAck.textContent).toBe(`${longAckId} · seq 41`);
  });

  it("preserves zero command sequence values in selected mission details", () => {
    const { refs, nodes } = createDetailRefs();

    renderSelectedMissionDetails(
      refs,
      mission("mission-seq-zero", {
        currentCommandId: "cmd-current-zero",
        lastCommandSequence: 0,
        lastAcknowledgedCommandId: "cmd-ack-zero",
        lastAcknowledgedCommandSequence: 0
      })
    );

    expect(nodes.missionCommand.textContent).toBe("cmd-current-zero · seq 0");
    expect(nodes.missionAck.textContent).toBe("cmd-ack-zero · seq 0");
  });

  it("distinguishes terminal, blocked, and manual-review selected states", () => {
    const cases = [
      {
        mission: mission("mission-cancelled", { lifecycleState: "CANCELLED" }),
        label: "TERMINAL",
        detail: "Cancellation acknowledged by the edge",
        tone: "tone-offline"
      },
      {
        mission: mission("mission-blocked", {
          lifecycleState: "SAFETY_BLOCKED",
          operationalStatus: "DEGRADED",
          failureReason: "ROBOT_TELEMETRY_STALE"
        }),
        label: "BLOCKED",
        detail: "Blocked before dispatch by platform safety policy",
        tone: "tone-degraded",
        reason: "The robot telemetry is stale"
      },
      {
        mission: mission("mission-review", { lifecycleState: "MANUAL_REVIEW" }),
        label: "MANUAL REVIEW",
        detail: "Needs operator review after reconnect reconciliation",
        tone: "tone-danger"
      }
    ] as const;

    for (const testCase of cases) {
      const { refs, nodes } = createDetailRefs();

      renderSelectedMissionDetails(refs, testCase.mission);

      expect(nodes.missionState.textContent).toBe(testCase.label);
      expect(nodes.missionState.className).toContain(testCase.tone);
      expect(nodes.missionStateDetail.textContent).toBe(testCase.detail);
      expect(nodes.missionReason.textContent).toBe(testCase.reason ?? "none");
    }
  });

  it("renders mission rows with status labels, reasons, and selection callbacks", () => {
    const documentRef = new TestDocument();
    const selected: string[] = [];
    const rows = renderMissionRows(
      documentRef,
      [
        mission("mission-blocked", {
          lifecycleState: "SAFETY_BLOCKED",
          operationalStatus: "DEGRADED",
          failureReason: "ROBOT_TELEMETRY_STALE"
        }),
        mission("mission-review", { lifecycleState: "MANUAL_REVIEW" }),
        mission("mission-cancelled", { lifecycleState: "CANCELLED" })
      ],
      "mission-review",
      (missionId) => {
        selected.push(missionId);
      }
    ).map((row) => row as unknown as TestElement);

    expect(rows[0]?.findByClass("status-pill")?.textContent).toBe("BLOCKED");
    expect(rows[0]?.textContent).toContain("Reason: The robot telemetry is stale");
    expect(rows[1]?.className).toContain("selected");
    expect(rows[1]?.findByClass("status-pill")?.textContent).toBe("REVIEW");
    expect(rows[2]?.findByClass("status-pill")?.textContent).toBe("CANCELLED");

    rows[1]?.click();

    expect(selected).toEqual(["mission-review"]);
  });

  it("renders cancel rejection feedback without raw HTTP text", () => {
    const actionMessage = new TestElement("p");

    renderActionMessage(
      actionMessage as unknown as HTMLElement,
      formatCancelRejectionMessage("MISSION_NOT_ACTIVE"),
      true
    );

    expect(actionMessage.textContent).toBe(
      "The selected mission is no longer active. Refreshing mission state may show the terminal outcome."
    );
    expect(actionMessage.textContent).not.toContain("HTTP");
    expect(actionMessage.textContent).not.toContain("422");
    expect(actionMessage.className).toContain("error");

    renderActionMessage(
      actionMessage as unknown as HTMLElement,
      "Cancel dispatched (1 edge delivery)",
      false
    );

    expect(actionMessage.className).not.toContain("error");
  });

  it("keeps detail code styling configured for long ids and commands", () => {
    expect(operatorUiStyles).toContain(".detail-code");
    expect(operatorUiStyles).toContain("word-break: break-word");
  });
});

/** Optional mission fields used by DOM rendering tests. */
interface MissionOptions {
  readonly lifecycleState?: MissionSnapshot["lifecycleState"];
  readonly operationalStatus?: MissionSnapshot["operationalStatus"];
  readonly currentCommandId?: string;
  readonly lastCommandSequence?: number;
  readonly lastAcknowledgedCommandId?: string;
  readonly lastAcknowledgedCommandSequence?: number;
  readonly failureReason?: string;
}

/** Creates a mission snapshot with stable timestamps for deterministic DOM text. */
function mission(
  missionId: string,
  options: MissionOptions = {}
): MissionSnapshot {
  return {
    missionId,
    robotId: "robot-a",
    lifecycleState: options.lifecycleState ?? "RUNNING",
    operationalStatus: options.operationalStatus ?? "NOMINAL",
    createdAt: "2026-05-15T12:00:00.000Z",
    updatedAt: "2026-05-15T12:00:00.000Z",
    ...(options.currentCommandId
      ? { currentCommandId: options.currentCommandId }
      : {}),
    ...(options.lastCommandSequence !== undefined
      ? { lastCommandSequence: options.lastCommandSequence }
      : {}),
    ...(options.lastAcknowledgedCommandId
      ? { lastAcknowledgedCommandId: options.lastAcknowledgedCommandId }
      : {}),
    ...(options.lastAcknowledgedCommandSequence !== undefined
      ? { lastAcknowledgedCommandSequence: options.lastAcknowledgedCommandSequence }
      : {}),
    ...(options.failureReason ? { failureReason: options.failureReason } : {})
  };
}

/** Creates typed detail refs while preserving test access to each fake element. */
function createDetailRefs(): {
  readonly refs: MissionDetailRefs;
  readonly nodes: Record<keyof MissionDetailRefs, TestElement>;
} {
  const nodes = {
    missionId: new TestElement("dd"),
    missionState: new TestElement("span"),
    missionStateDetail: new TestElement("small"),
    missionLifecycle: new TestElement("span"),
    missionOperational: new TestElement("span"),
    missionCommand: new TestElement("dd"),
    missionAck: new TestElement("dd"),
    missionReason: new TestElement("dd")
  } satisfies Record<keyof MissionDetailRefs, TestElement>;

  return {
    refs: nodes as unknown as MissionDetailRefs,
    nodes
  };
}

/** Minimal classList implementation for the renderer's error toggles. */
class TestClassList {
  constructor(private readonly owner: TestElement) {}

  toggle(token: string, force?: boolean): boolean {
    const tokens = new Set(this.owner.className.split(/\s+/).filter(Boolean));
    const shouldAdd = force ?? !tokens.has(token);
    if (shouldAdd) {
      tokens.add(token);
    } else {
      tokens.delete(token);
    }
    this.owner.className = [...tokens].join(" ");
    return shouldAdd;
  }
}

/** Small element double covering the DOM APIs the mission renderer mutates. */
class TestElement {
  readonly classList = new TestClassList(this);
  readonly children: TestElement[] = [];
  className = "";
  type = "";
  private readonly listeners = new Map<string, Array<() => void>>();
  private ownText = "";

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return `${this.ownText}${this.children
      .map((child) => child.textContent)
      .join("")}`;
  }

  set textContent(value: string | null) {
    this.ownText = value ?? "";
    this.children.length = 0;
  }

  append(...children: TestElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: TestElement[]): void {
    this.ownText = "";
    this.children.splice(0, this.children.length, ...children);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = typeof listener === "function"
      ? () => {
          listener({} as Event);
        }
      : () => {
          listener.handleEvent({} as Event);
        };
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) {
      listener();
    }
  }

  findByClass(className: string): TestElement | undefined {
    if (this.className.split(/\s+/).includes(className)) {
      return this;
    }

    for (const child of this.children) {
      const match = child.findByClass(className);
      if (match) {
        return match;
      }
    }

    return undefined;
  }
}

/** Minimal document double that lets DOM rendering tests build real trees. */
class TestDocument implements MissionElementFactory {
  createElement<K extends keyof HTMLElementTagNameMap>(
    tagName: K
  ): HTMLElementTagNameMap[K] {
    return new TestElement(tagName) as unknown as HTMLElementTagNameMap[K];
  }
}
