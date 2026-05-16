import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createInitialDomainState } from "@roboops/fleet-domain";
import { protocolSchemaVersions } from "@roboops/fleet-protocol";
import { runPostgresMigrations } from "@roboops/fleet-persistence";

import {
  type FleetPlatformRuntime,
  type RequestContext,
  SilentStructuredLogger,
  createFleetPlatformRuntime
} from "../src/index.js";

const shouldRunPostgresTests = process.env.ROBOOPS_RUN_POSTGRES_TESTS === "true";
const testDatabaseUrl = process.env.FLEET_PERSISTENCE_TEST_DATABASE_URL;
const shouldRunPostgresRuntimeTests =
  shouldRunPostgresTests &&
  typeof testDatabaseUrl === "string" &&
  testDatabaseUrl.trim().length > 0;

describe.skipIf(!shouldRunPostgresRuntimeTests)(
  "fleet platform Postgres runtime persistence",
  () => {
    let firstRuntime: FleetPlatformRuntime | undefined;
    let secondRuntime: FleetPlatformRuntime | undefined;

    beforeAll(async () => {
      await runPostgresMigrations({ databaseUrl: requirePostgresTestDatabaseUrl() });
    });

    afterEach(async () => {
      await firstRuntime?.stop();
      await secondRuntime?.stop();
      firstRuntime = undefined;
      secondRuntime = undefined;
    });

    it("keeps mission, robot, and command state readable after runtime restart", async () => {
      const databaseUrl = requirePostgresTestDatabaseUrl();
      const robotId = "robot-postgres-runtime";
      const missionId = "mission-postgres-runtime";
      const commandId = "cmd-postgres-runtime";
      const ackId = "ack-postgres-runtime";
      const connectedAt = "2026-05-16T12:00:00.000Z";
      const dispatchedAt = "2026-05-16T12:00:01.000Z";
      const ackedAt = "2026-05-16T12:00:02.000Z";

      firstRuntime = createPostgresRuntime(databaseUrl, robotId);
      await firstRuntime.repository.reset(createInitialDomainState());
      await firstRuntime.service.handleEdgeConnected(
        robotId,
        {
          edgeSessionId: "edge-session-postgres-runtime",
          edgeAgentVersion: "0.1.0",
          lastSeenCommandSequence: 0
        },
        requestContext("connect", connectedAt)
      );

      const dispatch = await firstRuntime.service.createMission(
        {
          robotId,
          missionId,
          commandId,
          type: "GO_TO_POSE",
          idempotencyKey: "operator:test:postgres-runtime:create",
          payload: { target: { x: 2, y: 4, theta: 1.57 } },
          safetyClass: "NORMAL"
        },
        requestContext("dispatch", dispatchedAt)
      );
      expect(dispatch.result.status).toBe("ACCEPTED");
      if (dispatch.result.status !== "ACCEPTED") {
        throw new Error("Expected Postgres runtime mission dispatch to be accepted");
      }

      const command = dispatch.result.command;
      await firstRuntime.service.handleEdgeMessage(
        robotId,
        {
          type: "edge.command_ack",
          payload: {
            schemaVersion: protocolSchemaVersions.commandAck,
            ackId,
            commandId: command.commandId,
            missionId: command.missionId,
            robotId: command.robotId,
            status: "ACCEPTED",
            receivedAt: ackedAt,
            lastSeenCommandSequence: command.sequence,
            correlationId: command.correlationId,
            causationId: command.commandId
          }
        },
        requestContext("ack", ackedAt)
      );

      await firstRuntime.stop();
      firstRuntime = undefined;

      secondRuntime = createPostgresRuntime(databaseUrl, robotId);
      const persistedState = await secondRuntime.service.getState();

      expect(persistedState.missions[missionId]).toMatchObject({
        missionId,
        robotId,
        lifecycleState: "RUNNING",
        operationalStatus: "NOMINAL",
        currentCommandId: commandId,
        lastAcknowledgedCommandId: commandId,
        lastAcknowledgedCommandSequence: command.sequence
      });
      expect(persistedState.robots[robotId]).toMatchObject({
        robotId,
        connectionState: "ONLINE",
        activeMissionId: missionId,
        lastAcknowledgedCommandId: commandId,
        lastSeenCommandSequence: command.sequence
      });
      expect(persistedState.commands[commandId]).toMatchObject({
        commandId,
        missionId,
        robotId,
        type: "GO_TO_POSE",
        sequence: command.sequence
      });
      expect(persistedState.processedAckIds).toContain(ackId);
    });
  }
);

/** Builds a Postgres-backed runtime without binding the HTTP server. */
function createPostgresRuntime(
  databaseUrl: string,
  demoRobotId: string
): FleetPlatformRuntime {
  return createFleetPlatformRuntime({
    config: {
      host: "127.0.0.1",
      port: 0,
      demoMode: false,
      demoRobotId,
      corsAllowOrigin: "*",
      defaultCommandTtlMs: 10_000,
      telemetryFreshnessSweepMs: 60_000,
      persistence: {
        mode: "postgres",
        databaseUrl
      }
    },
    logger: new SilentStructuredLogger()
  });
}

/** Creates deterministic request metadata so persisted records are stable. */
function requestContext(label: string, now: string): RequestContext {
  return {
    correlationId: `corr-postgres-runtime-${label}`,
    causationId: `test-postgres-runtime-${label}`,
    now
  };
}

/** Returns the opt-in database URL after the describe guard has enabled this file. */
function requirePostgresTestDatabaseUrl(): string {
  if (!testDatabaseUrl || testDatabaseUrl.trim().length === 0) {
    throw new Error("FLEET_PERSISTENCE_TEST_DATABASE_URL is required");
  }
  return testDatabaseUrl;
}
