import { describe, expect, it } from "vitest";

import type { DomainState } from "@roboops/fleet-domain";
import { protocolSchemaVersions } from "@roboops/fleet-protocol";
import {
  type DomainStateRepository,
  type DomainStateMutator
} from "../src/index.js";

/** Creates a repository instance for one contract test case. */
export type DomainStateRepositoryFactory = (
  initialState?: DomainState
) => DomainStateRepository | Promise<DomainStateRepository>;

/** Defines the shared whole-state repository behavior every implementation must preserve. */
export function defineDomainStateRepositoryContract(
  name: string,
  createRepository: DomainStateRepositoryFactory
): void {
  describe(name, () => {
    it("starts from an empty domain state when no initial state is supplied", async () => {
      const repository = await createRepository();

      expect(await repository.read()).toEqual({
        missions: {},
        robots: {},
        commands: {},
        idempotencyRecords: {},
        processedEventIds: [],
        processedAckIds: [],
        processedReconnectSessionIds: [],
        nextSequenceByRobot: {},
        auditEvents: [],
        domainEvents: []
      });
    });

    it("reads the current complete domain state", async () => {
      const initialState = populatedDomainState("initial");
      const repository = await createRepository(initialState);

      expectCompleteState(await repository.read(), initialState);
    });

    it("writes a complete replacement state without dropping any collections", async () => {
      const repository = await createRepository(populatedDomainState("initial"));
      const replacementState = populatedDomainState("written");

      await repository.write(replacementState);

      expectCompleteState(await repository.read(), replacementState);
    });

    it("resets to a supplied complete state after previous writes", async () => {
      const repository = await createRepository(populatedDomainState("initial"));
      await repository.write(populatedDomainState("written"));

      const resetState = populatedDomainState("reset");
      await repository.reset(resetState);

      expectCompleteState(await repository.read(), resetState);
    });

    it("updates by passing the latest state into a callback and storing its result", async () => {
      const initialState = populatedDomainState("initial");
      const repository = await createRepository(initialState);
      const replacementState = populatedDomainState("updated");
      const seenStates: DomainState[] = [];

      const returnedState = await repository.update((currentState) => {
        seenStates.push(currentState);
        return { state: replacementState, result: replacementState };
      });

      expect(seenStates).toEqual([initialState]);
      expectCompleteState(returnedState, replacementState);
      expectCompleteState(await repository.read(), replacementState);
    });

    it("leaves the current state untouched when an update callback fails", async () => {
      const initialState = populatedDomainState("initial");
      const repository = await createRepository(initialState);
      const failingMutator: DomainStateMutator<DomainState> = () => {
        throw new Error("update failed");
      };

      await expect(repository.update(failingMutator)).rejects.toThrow("update failed");
      expectCompleteState(await repository.read(), initialState);
    });
  });
}

/** Checks every persisted top-level collection and counter in DomainState. */
function expectCompleteState(actual: DomainState, expected: DomainState): void {
  expect(actual.missions).toEqual(expected.missions);
  expect(actual.robots).toEqual(expected.robots);
  expect(actual.commands).toEqual(expected.commands);
  expect(actual.idempotencyRecords).toEqual(expected.idempotencyRecords);
  expect(actual.domainEvents).toEqual(expected.domainEvents);
  expect(actual.auditEvents).toEqual(expected.auditEvents);
  expect(actual.processedEventIds).toEqual(expected.processedEventIds);
  expect(actual.processedAckIds).toEqual(expected.processedAckIds);
  expect(actual.processedReconnectSessionIds).toEqual(
    expected.processedReconnectSessionIds
  );
  expect(actual.nextSequenceByRobot).toEqual(expected.nextSequenceByRobot);
  expect(actual).toEqual(expected);
}

/** Builds a fully populated aggregate so contract tests catch dropped state fields. */
export function populatedDomainState(suffix: string): DomainState {
  const missionId = `mission-${suffix}`;
  const robotId = `robot-${suffix}`;
  const commandId = `cmd-${suffix}`;
  const idempotencyKey = `operator:test:${missionId}:create`;
  const ackId = `ack-${suffix}`;
  const telemetryEventId = `evt-telemetry-${suffix}`;
  const reconnectSessionId = `edge-session-${suffix}`;
  const timestamp = `2026-05-16T10:00:00.${timestampMilliseconds(suffix)}Z`;

  return {
    missions: {
      [missionId]: {
        missionId,
        robotId,
        lifecycleState: "RUNNING",
        operationalStatus: "RECOVERED",
        targetPose: { x: 1, y: 2, theta: 0.5 },
        createdAt: timestamp,
        updatedAt: timestamp,
        currentCommandId: commandId,
        lastCommandSequence: 7,
        lastAcknowledgedCommandId: commandId,
        lastAcknowledgedCommandSequence: 7,
        idempotencyKey,
        failureReason: `diagnostic-${suffix}`
      }
    },
    robots: {
      [robotId]: {
        robotId,
        connectionState: "ONLINE",
        updatedAt: timestamp,
        pose: { x: 0.5, y: 1.5, theta: 0.25 },
        health: "OK",
        batteryPercent: 72,
        activeMissionId: missionId,
        lastTelemetryObservedAt: timestamp,
        lastTelemetryReceivedAt: timestamp,
        lastAcknowledgedCommandId: commandId,
        lastSeenCommandSequence: 7,
        edgeAgentVersion: `edge-${suffix}`
      }
    },
    commands: {
      [commandId]: {
        schemaVersion: protocolSchemaVersions.commandEnvelope,
        commandId,
        missionId,
        robotId,
        type: "GO_TO_POSE",
        idempotencyKey,
        sequence: 7,
        issuedAt: timestamp,
        expiresAt: "2026-05-16T10:05:00.000Z",
        requiresAck: true,
        safetyClass: "NORMAL",
        correlationId: `corr-${suffix}`,
        causationId: `cause-${suffix}`,
        payload: { target: { x: 1, y: 2, theta: 0.5 } }
      }
    },
    idempotencyRecords: {
      [idempotencyKey]: {
        idempotencyKey,
        payloadSignature: `signature-${suffix}`,
        commandId,
        missionId
      }
    },
    processedEventIds: [telemetryEventId],
    processedAckIds: [ackId],
    processedReconnectSessionIds: [reconnectSessionId],
    nextSequenceByRobot: {
      [robotId]: 8
    },
    auditEvents: [
      {
        schemaVersion: protocolSchemaVersions.auditEvent,
        auditEventId: `audit-${suffix}`,
        actorType: "system",
        action: "mission.command.acked",
        occurredAt: timestamp,
        missionId,
        robotId,
        commandId,
        correlationId: `corr-${suffix}`,
        causationId: commandId,
        details: {
          commandType: "GO_TO_POSE",
          lifecycleState: "RUNNING",
          ackId
        }
      }
    ],
    domainEvents: [
      {
        schemaVersion: protocolSchemaVersions.eventEnvelope,
        eventId: `evt-domain-${suffix}`,
        eventType: "mission.command.acked",
        aggregateType: "mission",
        aggregateId: missionId,
        occurredAt: timestamp,
        receivedAt: timestamp,
        correlationId: `corr-${suffix}`,
        causationId: commandId,
        payload: {
          missionId,
          robotId,
          commandId,
          commandType: "GO_TO_POSE",
          lifecycleState: "RUNNING"
        }
      }
    ]
  };
}

/** Keeps generated timestamps valid and stable for arbitrary test suffixes. */
function timestampMilliseconds(suffix: string): string {
  const charTotal = [...suffix].reduce((total, character) => {
    return total + character.charCodeAt(0);
  }, 0);
  return String(charTotal % 1_000).padStart(3, "0");
}
