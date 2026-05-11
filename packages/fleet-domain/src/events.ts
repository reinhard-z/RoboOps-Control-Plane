import {
  type AuditEventId,
  type AuditEventV1,
  type EventEnvelopeV1,
  protocolSchemaVersions
} from "@roboops/fleet-protocol";

import type { DomainState } from "./state.js";

/** Appends generated audit and domain events while preserving immutable state updates. */
export function appendGeneratedRecords(
  state: DomainState,
  domainEvents: readonly EventEnvelopeV1[],
  auditEvents: readonly AuditEventV1[]
): DomainState {
  return {
    ...state,
    domainEvents: [...state.domainEvents, ...domainEvents],
    auditEvents: [...state.auditEvents, ...auditEvents]
  };
}

/** Creates a deterministic domain event envelope for reducer-produced events. */
export function createDomainEvent(
  state: DomainState,
  input: Omit<EventEnvelopeV1, "schemaVersion" | "eventId">
): EventEnvelopeV1 {
  return {
    schemaVersion: protocolSchemaVersions.eventEnvelope,
    eventId: createGeneratedId("evt_domain", state.domainEvents.length + 1),
    ...input
  };
}

/** Creates a deterministic audit event envelope for reducer-produced audit history. */
export function createAuditEvent(
  state: DomainState,
  input: Omit<AuditEventV1, "schemaVersion" | "auditEventId">
): AuditEventV1 {
  return {
    schemaVersion: protocolSchemaVersions.auditEvent,
    auditEventId: createGeneratedId("audit", state.auditEvents.length + 1) as AuditEventId,
    ...input
  };
}

/** Generates stable local ids for deterministic tests before real persistence exists. */
function createGeneratedId(prefix: string, sequence: number): string {
  return `${prefix}_${String(sequence).padStart(6, "0")}`;
}
