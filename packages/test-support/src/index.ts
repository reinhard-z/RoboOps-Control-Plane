/** Deterministic clock for tests that need to advance freshness and TTL checks. */
export class FakeClock {
  private currentTimeMs: number;

  public constructor(startAt: string | Date = "2026-05-10T12:00:00.000Z") {
    this.currentTimeMs = toTimeMs(startAt);
  }

  public now(): string {
    return new Date(this.currentTimeMs).toISOString();
  }

  public nowMs(): number {
    return this.currentTimeMs;
  }

  public advanceBy(ms: number): string {
    this.currentTimeMs += ms;
    return this.now();
  }

  public advanceSeconds(seconds: number): string {
    return this.advanceBy(seconds * 1000);
  }

  public set(startAt: string | Date): string {
    this.currentTimeMs = toTimeMs(startAt);
    return this.now();
  }
}

export function isoPlus(startAt: string | Date, ms: number): string {
  return new Date(toTimeMs(startAt) + ms).toISOString();
}

function toTimeMs(value: string | Date): number {
  const timeMs = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timeMs)) {
    throw new Error(`Invalid timestamp: ${String(value)}`);
  }
  return timeMs;
}
