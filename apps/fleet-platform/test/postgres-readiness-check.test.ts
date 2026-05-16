import { describe, expect, it } from "vitest";

import { localPostgresDatabaseUrl } from "@roboops/fleet-persistence";

import {
  checkFleetPlatformPostgresReadiness,
  runFleetPlatformPostgresReadinessCli,
  type FleetPlatformPostgresReadinessRepository,
  type FleetPlatformPostgresReadinessRepositoryOptions
} from "../src/postgres-readiness-check.js";

const testDatabaseUrl =
  "postgres://roboops:roboops_local_password@127.0.0.1:55432/roboops_control_plane";

describe("fleet platform Postgres readiness check command", () => {
  it("validates the env-configured Postgres repository read without printing secrets", async () => {
    const io = new CapturingCliIo();
    let repositoryOptions: FleetPlatformPostgresReadinessRepositoryOptions | undefined;

    const exitCode = await runFleetPlatformPostgresReadinessCli(
      [],
      {
        FLEET_PERSISTENCE_MODE: "postgres",
        FLEET_PERSISTENCE_DATABASE_URL: testDatabaseUrl
      },
      io,
      (options) => {
        repositoryOptions = options;
        return successfulRepository();
      }
    );

    expect(exitCode).toBe(0);
    expect(repositoryOptions).toEqual({
      databaseUrl: testDatabaseUrl,
      timeoutMs: 2_000
    });
    expect(io.stdoutMessages).toEqual([
      "fleet platform Postgres readiness validated persistenceMode=postgres check=repository.read"
    ]);
    expect(serializedOutput(io)).not.toContain("postgres://");
    expect(serializedOutput(io)).not.toContain("roboops_local_password");
  });

  it("supports the local Docker Compose database shortcut without printing the URL", async () => {
    const io = new CapturingCliIo();
    let repositoryOptions: FleetPlatformPostgresReadinessRepositoryOptions | undefined;

    const exitCode = await runFleetPlatformPostgresReadinessCli(
      ["--local"],
      {},
      io,
      (options) => {
        repositoryOptions = options;
        return successfulRepository();
      }
    );

    expect(exitCode).toBe(0);
    expect(repositoryOptions?.databaseUrl).toBe(localPostgresDatabaseUrl);
    expect(serializedOutput(io)).not.toContain(localPostgresDatabaseUrl);
    expect(serializedOutput(io)).not.toContain("roboops_local_password");
  });

  it("sanitizes raw repository failures in user-facing CLI output", async () => {
    const io = new CapturingCliIo();

    const exitCode = await runFleetPlatformPostgresReadinessCli(
      ["--database-url", testDatabaseUrl],
      {},
      io,
      () => ({
        read: async () => {
          const error = new Error(`raw driver failure for ${testDatabaseUrl}`);
          error.name = `DriverError:${testDatabaseUrl}`;
          throw error;
        }
      })
    );

    expect(exitCode).toBe(1);
    expect(io.stderrMessages).toEqual([
      'fleet platform Postgres readiness failed check=repository.read errorType=Error message="persistence backend is not ready"'
    ]);
    expect(serializedOutput(io)).not.toContain("raw driver failure");
    expect(serializedOutput(io)).not.toContain("postgres://");
    expect(serializedOutput(io)).not.toContain("roboops_local_password");
  });

  it("fails safely when Postgres runtime persistence is not configured", async () => {
    const io = new CapturingCliIo();
    let repositoryCreated = false;

    const exitCode = await runFleetPlatformPostgresReadinessCli(
      [],
      {},
      io,
      () => {
        repositoryCreated = true;
        return successfulRepository();
      }
    );

    expect(exitCode).toBe(1);
    expect(repositoryCreated).toBe(false);
    expect(io.stderrMessages).toEqual([
      'fleet platform Postgres readiness failed check=repository.read errorType=FleetPlatformPostgresReadinessCliError message="Fleet Platform Postgres persistence is not configured"'
    ]);
  });

  it("closes the repository after a timed-out validation read", async () => {
    let closed = false;

    await expect(
      checkFleetPlatformPostgresReadiness({
        databaseUrl: testDatabaseUrl,
        timeoutMs: 5,
        repositoryFactory: () => ({
          read: () => new Promise(() => undefined),
          close: async () => {
            closed = true;
          }
        })
      })
    ).rejects.toMatchObject({ name: "ReadinessTimeoutError" });
    expect(closed).toBe(true);
  });

  it("does not wait indefinitely for close after a timed-out validation read", async () => {
    const startedAt = Date.now();

    await expect(
      checkFleetPlatformPostgresReadiness({
        databaseUrl: testDatabaseUrl,
        timeoutMs: 5,
        repositoryFactory: () => ({
          read: () => new Promise(() => undefined),
          close: () => new Promise(() => undefined)
        })
      })
    ).rejects.toMatchObject({ name: "ReadinessTimeoutError" });

    expect(Date.now() - startedAt).toBeLessThan(100);
  });
});

/** Captures command output without replacing process-level console functions. */
class CapturingCliIo {
  readonly stdoutMessages: string[] = [];
  readonly stderrMessages: string[] = [];

  stdout(message: string): void {
    this.stdoutMessages.push(message);
  }

  stderr(message: string): void {
    this.stderrMessages.push(message);
  }
}

/** Provides the successful read-only repository used by command unit tests. */
function successfulRepository(): FleetPlatformPostgresReadinessRepository {
  return {
    read: async () => undefined
  };
}

/** Serializes captured output so tests can assert that secrets never leak. */
function serializedOutput(io: CapturingCliIo): string {
  return JSON.stringify({
    stdout: io.stdoutMessages,
    stderr: io.stderrMessages
  });
}
