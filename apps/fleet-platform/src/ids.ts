import { randomUUID } from "node:crypto";

/** Returns the current wall-clock time in the protocol timestamp format. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Adds milliseconds to an ISO timestamp and returns a normalized ISO timestamp. */
export function isoPlus(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

/** Creates a locally unique id with a readable prefix until persistence owns id allocation. */
export function createPlatformId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
