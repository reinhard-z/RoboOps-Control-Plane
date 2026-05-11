import { createPlatformId, nowIso } from "./ids.js";

/** Event sent to browser SSE clients after domain, audit, or platform activity. */
export interface PlatformStreamEvent {
  readonly streamEventId: string;
  readonly type: "domain" | "audit" | "platform";
  readonly occurredAt: string;
  readonly data: unknown;
}

export type PlatformStreamListener = (event: PlatformStreamEvent) => void;

/** Fan-out hub for live UI updates; durable event storage still lives in DomainState. */
export class PlatformEventHub {
  private readonly listeners = new Set<PlatformStreamListener>();

  subscribe(listener: PlatformStreamListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(
    type: PlatformStreamEvent["type"],
    data: unknown,
    occurredAt: string = nowIso()
  ): PlatformStreamEvent {
    const event: PlatformStreamEvent = {
      streamEventId: createPlatformId("stream"),
      type,
      occurredAt,
      data
    };

    for (const listener of this.listeners) {
      listener(event);
    }

    return event;
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}
