import {
  type CausationId,
  type CommandEnvelopeV1,
  type CommandId,
  type CorrelationId,
  type IdempotencyKey,
  type IsoTimestamp,
  type MissionId,
  protocolSchemaVersions
} from "@roboops/fleet-protocol";

import { appendGeneratedRecords, createAuditEvent, createDomainEvent } from "./events.js";
import {
  type DomainConfig,
  defaultDomainConfig,
  isActiveMission
} from "./policies.js";
import type {
  DomainState,
  DomainTransition,
  MissionSnapshot
} from "./state.js";
import { parseTimestamp } from "./time.js";

export type CancelMissionRejectionReason =
  | "COMMAND_EXPIRED"
  | "COMMAND_TTL_INVALID"
  | "DUPLICATE_COMMAND_ID"
  | "IDEMPOTENCY_KEY_REUSE_CONFLICT"
  | "MISSION_NOT_ACTIVE"
  | "UNKNOWN_MISSION";

export type CancelMissionResult =
  | {
      readonly status: "ACCEPTED";
      readonly command: CommandEnvelopeV1;
      readonly mission: MissionSnapshot;
    }
  | {
      readonly status: "IDEMPOTENT_REPLAY";
      readonly command: CommandEnvelopeV1;
      readonly mission: MissionSnapshot;
    }
  | {
      readonly status: "REJECTED";
      readonly reason: CancelMissionRejectionReason;
      readonly mission?: MissionSnapshot;
    };

/** Operator request fields needed to ask the edge to cancel an active mission. */
export interface RequestMissionCancellationInput {
  readonly commandId: CommandId;
  readonly missionId: MissionId;
  readonly idempotencyKey: IdempotencyKey;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId;
  readonly reason: string;
  readonly now: IsoTimestamp;
}

/** Creates a cancel command for an existing mission without overwriting mission identity or history. */
export function requestMissionCancellation(
  state: DomainState,
  input: RequestMissionCancellationInput,
  config: DomainConfig = defaultDomainConfig
): DomainTransition<CancelMissionResult> {
  const mission = state.missions[input.missionId];
  if (!mission) {
    return rejectCancellation(state, input, "UNKNOWN_MISSION");
  }

  const payloadSignature = createPayloadSignature(input);
  const idempotencyRecord = state.idempotencyRecords[input.idempotencyKey];
  if (idempotencyRecord) {
    if (idempotencyRecord.payloadSignature !== payloadSignature) {
      return rejectCancellation(
        state,
        input,
        "IDEMPOTENCY_KEY_REUSE_CONFLICT",
        mission
      );
    }

    const command = state.commands[idempotencyRecord.commandId];
    const replayMission = state.missions[idempotencyRecord.missionId];
    if (command && replayMission) {
      return {
        state,
        result: { status: "IDEMPOTENT_REPLAY", command, mission: replayMission },
        auditEvents: [],
        domainEvents: []
      };
    }
  }

  if (!isActiveMission(mission.lifecycleState)) {
    return rejectCancellation(state, input, "MISSION_NOT_ACTIVE", mission);
  }

  if (state.commands[input.commandId]) {
    return rejectCancellation(state, input, "DUPLICATE_COMMAND_ID", mission);
  }

  const issuedAtMs = parseTimestamp(input.issuedAt);
  const expiresAtMs = parseTimestamp(input.expiresAt);
  const nowMs = parseTimestamp(input.now);
  if (expiresAtMs <= nowMs) {
    return rejectCancellation(state, input, "COMMAND_EXPIRED", mission);
  }

  if (expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > config.maxCommandTtlMs) {
    return rejectCancellation(state, input, "COMMAND_TTL_INVALID", mission);
  }

  const sequence =
    state.nextSequenceByRobot[mission.robotId] ??
    (mission.lastCommandSequence ?? state.robots[mission.robotId]?.lastSeenCommandSequence ?? 0) +
      1;
  const command: CommandEnvelopeV1 = {
    schemaVersion: protocolSchemaVersions.commandEnvelope,
    commandId: input.commandId,
    missionId: mission.missionId,
    robotId: mission.robotId,
    type: "CANCEL_MISSION",
    idempotencyKey: input.idempotencyKey,
    sequence,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    requiresAck: true,
    safetyClass: "NORMAL",
    correlationId: input.correlationId,
    causationId: input.causationId,
    payload: { reason: input.reason }
  };
  const nextMission: MissionSnapshot = {
    ...mission,
    lifecycleState: "CANCEL_REQUESTED",
    updatedAt: input.now,
    currentCommandId: command.commandId,
    lastCommandSequence: sequence
  };

  const event = createDomainEvent(state, {
    eventType: "mission.cancel.requested",
    aggregateType: "mission",
    aggregateId: mission.missionId,
    occurredAt: input.now,
    receivedAt: input.now,
    correlationId: input.correlationId,
    causationId: input.causationId,
    payload: {
      commandId: command.commandId,
      robotId: command.robotId,
      sequence
    }
  });
  const audit = createAuditEvent(state, {
    actorType: "operator",
    action: "mission.cancel.requested",
    occurredAt: input.now,
    missionId: mission.missionId,
    robotId: mission.robotId,
    commandId: command.commandId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    details: {
      reason: input.reason,
      sequence
    }
  });

  const nextState = appendGeneratedRecords(
    {
      ...state,
      missions: {
        ...state.missions,
        [nextMission.missionId]: nextMission
      },
      commands: {
        ...state.commands,
        [command.commandId]: command
      },
      idempotencyRecords: {
        ...state.idempotencyRecords,
        [input.idempotencyKey]: {
          idempotencyKey: input.idempotencyKey,
          payloadSignature,
          commandId: command.commandId,
          missionId: mission.missionId
        }
      },
      nextSequenceByRobot: {
        ...state.nextSequenceByRobot,
        [mission.robotId]: sequence + 1
      }
    },
    [event],
    [audit]
  );

  return {
    state: nextState,
    result: { status: "ACCEPTED", command, mission: nextMission },
    auditEvents: [audit],
    domainEvents: [event]
  };
}

/** Emits a rejected cancellation decision while preserving the current mission snapshot. */
function rejectCancellation(
  state: DomainState,
  input: RequestMissionCancellationInput,
  reason: CancelMissionRejectionReason,
  mission?: MissionSnapshot
): DomainTransition<CancelMissionResult> {
  const event = createDomainEvent(state, {
    eventType: "mission.cancel.rejected",
    aggregateType: mission ? "mission" : "system",
    aggregateId: mission?.missionId ?? input.missionId,
    occurredAt: input.now,
    receivedAt: input.now,
    correlationId: input.correlationId,
    causationId: input.causationId,
    payload: {
      reason
    }
  });
  const audit = createAuditEvent(state, {
    actorType: "system",
    action: "mission.cancel.rejected",
    occurredAt: input.now,
    ...(mission ? { missionId: mission.missionId, robotId: mission.robotId } : {}),
    commandId: input.commandId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    details: {
      reason
    }
  });

  const nextState = appendGeneratedRecords(state, [event], [audit]);
  return {
    state: nextState,
    result: {
      status: "REJECTED",
      reason,
      ...(mission ? { mission } : {})
    },
    auditEvents: [audit],
    domainEvents: [event]
  };
}

/** Produces the canonical idempotency comparison payload for cancellation requests. */
function createPayloadSignature(input: RequestMissionCancellationInput): string {
  return stableSerialize({
    missionId: input.missionId,
    type: "CANCEL_MISSION",
    payload: { reason: input.reason }
  });
}

/** Serializes objects with sorted keys so semantically identical payloads compare equal. */
function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`);
  return `{${entries.join(",")}}`;
}
