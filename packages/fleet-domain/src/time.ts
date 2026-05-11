import type { IsoTimestamp } from "@roboops/fleet-protocol";

/** Parses ISO timestamps at reducer boundaries and fails fast for invalid test/input data. */
export function parseTimestamp(value: IsoTimestamp): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ISO timestamp: ${value}`);
  }
  return parsed;
}
