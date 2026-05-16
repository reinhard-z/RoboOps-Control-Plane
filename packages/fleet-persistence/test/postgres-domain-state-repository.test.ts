import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { createInitialDomainState } from "@roboops/fleet-domain";

import {
  PostgresDomainStateRepository,
  runPostgresMigrations
} from "../src/index.js";
import {
  defineDomainStateRepositoryContract,
  populatedDomainState
} from "./domain-state-repository-contract.js";

const { Pool: PgPool } = pg;

const shouldRunPostgresTests = process.env.ROBOOPS_RUN_POSTGRES_TESTS === "true";
const testDatabaseUrl = process.env.FLEET_PERSISTENCE_TEST_DATABASE_URL;

describe.skipIf(!shouldRunPostgresTests || !testDatabaseUrl)(
  "PostgresDomainStateRepository",
  () => {
    let pool: Pool | undefined;

    beforeAll(async () => {
      await runPostgresMigrations({ databaseUrl: testDatabaseUrl });
      pool = new PgPool({ connectionString: testDatabaseUrl });
    });

    afterAll(async () => {
      await pool?.end();
    });

    /** Creates a clean repository view for each shared contract case. */
    const createRepository = async (initialState = createInitialDomainState()) => {
      if (!pool) {
        throw new Error("Postgres test pool was not initialized");
      }
      const repository = new PostgresDomainStateRepository({ pool });
      await repository.reset(initialState);
      return repository;
    };

    defineDomainStateRepositoryContract(
      "PostgresDomainStateRepository contract",
      createRepository
    );

    it("keeps repeated replacement writes idempotent", async () => {
      const repository = await createRepository();
      const firstState = populatedDomainState("postgres-first");
      const replacementState = populatedDomainState("postgres-replacement");

      await repository.write(firstState);
      await repository.write(firstState);
      expect(await repository.read()).toEqual(firstState);

      await repository.write(replacementState);
      await repository.write(replacementState);
      expect(await repository.read()).toEqual(replacementState);
    });

    it("preserves append-only edge fact logs when replacing state", async () => {
      if (!pool) {
        throw new Error("Postgres test pool was not initialized");
      }
      const initialState = populatedDomainState("fact-log");
      const repository = await createRepository(initialState);
      const command = Object.values(initialState.commands)[0];
      const mission = Object.values(initialState.missions)[0];
      const robot = Object.values(initialState.robots)[0];
      if (!command || !mission || !robot) {
        throw new Error("Expected populated test state");
      }

      const ackId = "ack-preserved-fact-log";
      const telemetryEventId = "telemetry-preserved-fact-log";
      const edgeSessionId = "edge-session-preserved-fact-log";
      await deletePreservedFactLogFixtures(
        pool,
        ackId,
        telemetryEventId,
        edgeSessionId,
        robot.robotId
      );
      await insertPreservedFactLogFixtures(
        pool,
        ackId,
        telemetryEventId,
        edgeSessionId,
        command,
        mission,
        robot
      );

      await repository.reset(createInitialDomainState());

      expect(await readPreservedFactLogReferences(pool, ackId)).toEqual({
        resolvedCommandId: null,
        resolvedMissionId: null
      });
      expect(await readPreservedTelemetryReferences(pool, telemetryEventId)).toEqual({
        resolvedRobotId: null,
        resolvedMissionId: null
      });
      expect(
        await readPreservedSessionReferences(pool, robot.robotId, edgeSessionId)
      ).toEqual({ resolvedRobotId: null });

      await repository.write(initialState);

      expect(await readPreservedFactLogReferences(pool, ackId)).toEqual({
        resolvedCommandId: command.commandId,
        resolvedMissionId: mission.missionId
      });
      expect(await readPreservedTelemetryReferences(pool, telemetryEventId)).toEqual({
        resolvedRobotId: robot.robotId,
        resolvedMissionId: mission.missionId
      });
      expect(
        await readPreservedSessionReferences(pool, robot.robotId, edgeSessionId)
      ).toEqual({ resolvedRobotId: robot.robotId });
    });
  }
);

/** Removes prior fixture rows so the opt-in DB test can be rerun locally. */
async function deletePreservedFactLogFixtures(
  pool: Pool,
  ackId: string,
  telemetryEventId: string,
  edgeSessionId: string,
  robotId: string
): Promise<void> {
  await pool.query("DELETE FROM fleet_persistence.command_acks WHERE ack_id = $1", [
    ackId
  ]);
  await pool.query(
    "DELETE FROM fleet_persistence.robot_telemetry_events WHERE event_id = $1",
    [telemetryEventId]
  );
  await pool.query(
    [
      "DELETE FROM fleet_persistence.robot_sessions",
      "WHERE robot_id = $1 AND edge_session_id = $2"
    ].join("\n"),
    [robotId, edgeSessionId]
  );
}

/** Inserts edge facts that should outlive repository snapshot replacement. */
async function insertPreservedFactLogFixtures(
  pool: Pool,
  ackId: string,
  telemetryEventId: string,
  edgeSessionId: string,
  command: { readonly commandId: string },
  mission: {
    readonly missionId: string;
    readonly robotId: string;
    readonly updatedAt: string;
  },
  robot: {
    readonly robotId: string;
    readonly updatedAt: string;
    readonly edgeAgentVersion?: string;
  }
): Promise<void> {
  await pool.query(
    [
      "INSERT INTO fleet_persistence.command_acks (",
      "  ack_id, command_id, mission_id, robot_id, resolved_command_id,",
      "  resolved_mission_id, status, received_at, last_seen_command_sequence,",
      "  correlation_id, causation_id, payload_json",
      ") VALUES (",
      "  $1, $2, $3, $4, $2,",
      "  $3, 'ACCEPTED', $5, 1,",
      "  'corr-preserved-fact-log', 'cause-preserved-fact-log', $6::jsonb",
      ")"
    ].join("\n"),
    [
      ackId,
      command.commandId,
      mission.missionId,
      mission.robotId,
      mission.updatedAt,
      JSON.stringify({ ackId })
    ]
  );
  await pool.query(
    [
      "INSERT INTO fleet_persistence.robot_telemetry_events (",
      "  event_id, robot_id, resolved_robot_id, observed_at, received_at,",
      "  pose_json, battery_percent, health, connection_state, current_mission_id,",
      "  resolved_mission_id, last_seen_command_sequence, edge_agent_version, payload_json",
      ") VALUES (",
      "  $1, $2, $2, $3, $3,",
      "  $4::jsonb, 72, 'OK', 'ONLINE', $5,",
      "  $5, 1, $6, $7::jsonb",
      ")"
    ].join("\n"),
    [
      telemetryEventId,
      robot.robotId,
      robot.updatedAt,
      JSON.stringify({ x: 0, y: 0, theta: 0 }),
      mission.missionId,
      robot.edgeAgentVersion ?? "edge-test",
      JSON.stringify({ eventId: telemetryEventId })
    ]
  );
  await pool.query(
    [
      "INSERT INTO fleet_persistence.robot_sessions (",
      "  robot_id, resolved_robot_id, edge_session_id, connected_at,",
      "  last_seen_command_sequence, edge_agent_version, hello_json, updated_at",
      ") VALUES (",
      "  $1, $1, $2, $3,",
      "  1, $4, $5::jsonb, $3",
      ")"
    ].join("\n"),
    [
      robot.robotId,
      edgeSessionId,
      robot.updatedAt,
      robot.edgeAgentVersion ?? "edge-test",
      JSON.stringify({ edgeSessionId })
    ]
  );
}

/** Reads preserved ack references using API-shaped property names for clear assertions. */
async function readPreservedFactLogReferences(
  pool: Pool,
  ackId: string
): Promise<{
  readonly resolvedCommandId: string | null;
  readonly resolvedMissionId: string | null;
}> {
  const result = await pool.query<{
    readonly resolved_command_id: string | null;
    readonly resolved_mission_id: string | null;
  }>(
    [
      "SELECT resolved_command_id, resolved_mission_id",
      "FROM fleet_persistence.command_acks",
      "WHERE ack_id = $1"
    ].join("\n"),
    [ackId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Expected preserved command ack fixture");
  }
  return {
    resolvedCommandId: row.resolved_command_id,
    resolvedMissionId: row.resolved_mission_id
  };
}

/** Reads preserved telemetry references using API-shaped property names for clear assertions. */
async function readPreservedTelemetryReferences(
  pool: Pool,
  eventId: string
): Promise<{
  readonly resolvedRobotId: string | null;
  readonly resolvedMissionId: string | null;
}> {
  const result = await pool.query<{
    readonly resolved_robot_id: string | null;
    readonly resolved_mission_id: string | null;
  }>(
    [
      "SELECT resolved_robot_id, resolved_mission_id",
      "FROM fleet_persistence.robot_telemetry_events",
      "WHERE event_id = $1"
    ].join("\n"),
    [eventId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Expected preserved telemetry fixture");
  }
  return {
    resolvedRobotId: row.resolved_robot_id,
    resolvedMissionId: row.resolved_mission_id
  };
}

/** Reads preserved session references using API-shaped property names for clear assertions. */
async function readPreservedSessionReferences(
  pool: Pool,
  robotId: string,
  edgeSessionId: string
): Promise<{ readonly resolvedRobotId: string | null }> {
  const result = await pool.query<{ readonly resolved_robot_id: string | null }>(
    [
      "SELECT resolved_robot_id",
      "FROM fleet_persistence.robot_sessions",
      "WHERE robot_id = $1 AND edge_session_id = $2"
    ].join("\n"),
    [robotId, edgeSessionId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Expected preserved session fixture");
  }
  return {
    resolvedRobotId: row.resolved_robot_id
  };
}
