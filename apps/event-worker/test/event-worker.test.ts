import { describe, expect, it } from "vitest";

import type { ClaimedOutboxEvent } from "@roboops/fleet-persistence";

import {
  NoopOutboxPublisher,
  runEventWorkerCli,
  runEventWorkerOnce
} from "../src/index.js";
import type { EventWorkerOutboxStore } from "../src/index.js";

describe("event worker single-pass runner", () => {
  it("releases claimed rows for retry when publication is not configured", async () => {
    const store = new FakeOutboxStore([claimedOutboxEvent("outbox-deferred")]);

    const summary = await runEventWorkerOnce({
      store,
      workerId: "worker-deferred",
      batchSize: 5,
      retryDelayMs: 1_000,
      now: () => new Date("2026-05-16T10:00:00.000Z")
    });

    expect(store.claims).toEqual([
      {
        workerId: "worker-deferred",
        batchSize: 5,
        now: new Date("2026-05-16T10:00:00.000Z")
      }
    ]);
    expect(store.published).toEqual([]);
    expect(store.failures).toHaveLength(1);
    expect(store.failures[0]?.outboxId).toBe("outbox-deferred");
    expect(store.failures[0]?.workerId).toBe("worker-deferred");
    expect(store.failures[0]?.retryAt).toEqual(
      new Date("2026-05-16T10:00:01.000Z")
    );
    expect(summary).toEqual({
      claimedCount: 1,
      publishedCount: 0,
      failedCount: 0,
      deferredCount: 1,
      staleClaimCount: 0
    });
  });

  it("marks rows published only when a publisher succeeds", async () => {
    const store = new FakeOutboxStore([claimedOutboxEvent("outbox-published")]);

    const summary = await runEventWorkerOnce({
      store,
      workerId: "worker-published",
      publisher: new NoopOutboxPublisher(),
      now: () => new Date("2026-05-16T10:00:00.000Z")
    });

    expect(store.failures).toEqual([]);
    expect(store.published).toEqual([
      {
        outboxId: "outbox-published",
        workerId: "worker-published",
        publishedAt: new Date("2026-05-16T10:00:00.000Z")
      }
    ]);
    expect(summary.publishedCount).toBe(1);
  });

  it("prints CLI summaries without exposing database URLs", async () => {
    const store = new FakeOutboxStore([claimedOutboxEvent("outbox-cli")]);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runEventWorkerCli(
      [
        "--database-url",
        "postgres://user:secret@127.0.0.1:55432/roboops_control_plane",
        "--worker-id",
        "worker-cli"
      ],
      {},
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message)
      },
      { store }
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain("event worker pass complete");
    expect(stdout[0]).toContain("publication=not_configured");
    expect(stdout[0]).not.toContain("postgres://");
    expect(stdout[0]).not.toContain("secret");
  });
});

/** In-memory test double for the worker's narrow outbox store dependency. */
class FakeOutboxStore implements EventWorkerOutboxStore {
  readonly claims: Array<{
    readonly workerId: string;
    readonly batchSize: number;
    readonly now?: Date | string;
  }> = [];
  readonly published: Array<{
    readonly outboxId: string;
    readonly workerId: string;
    readonly publishedAt?: Date | string;
  }> = [];
  readonly failures: Array<{
    readonly outboxId: string;
    readonly workerId: string;
    readonly retryAt: Date | string;
    readonly error: unknown;
  }> = [];

  constructor(private readonly events: readonly ClaimedOutboxEvent[]) {}

  async claimBatch(options: {
    readonly workerId: string;
    readonly batchSize: number;
    readonly now?: Date | string;
  }): Promise<readonly ClaimedOutboxEvent[]> {
    this.claims.push(options);
    return this.events;
  }

  async markPublished(options: {
    readonly outboxId: string;
    readonly workerId: string;
    readonly publishedAt?: Date | string;
  }): Promise<boolean> {
    this.published.push(options);
    return true;
  }

  async recordFailure(options: {
    readonly outboxId: string;
    readonly workerId: string;
    readonly retryAt: Date | string;
    readonly error: unknown;
  }): Promise<boolean> {
    this.failures.push(options);
    return true;
  }
}

/** Builds a claimed event with stable metadata so worker tests focus on control flow. */
function claimedOutboxEvent(outboxId: string): ClaimedOutboxEvent {
  return {
    outboxId,
    aggregateType: "mission",
    aggregateId: `mission-${outboxId}`,
    eventType: "test.event",
    payload: { id: outboxId },
    correlationId: `corr-${outboxId}`,
    createdAt: "2026-05-16T09:59:00.000Z",
    availableAt: "2026-05-16T10:00:00.000Z",
    lockedAt: "2026-05-16T10:00:00.000Z",
    lockedBy: "worker-test",
    attemptCount: 1
  };
}
