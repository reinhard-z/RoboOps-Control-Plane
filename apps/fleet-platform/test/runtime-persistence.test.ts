import { afterEach, describe, expect, it } from "vitest";

import {
  InMemoryDomainStateRepository,
  PostgresDomainStateRepository
} from "@roboops/fleet-persistence";

import {
  type FleetPlatformRuntime,
  SilentStructuredLogger,
  createFleetPlatformRuntime,
  loadFleetPlatformConfig
} from "../src/index.js";

const testDatabaseUrl =
  "postgres://roboops:roboops_local_password@127.0.0.1:55432/roboops_control_plane";

describe("fleet platform persistence configuration", () => {
  let runtime: FleetPlatformRuntime | undefined;

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
  });

  it("defaults config and runtime repository construction to in-memory persistence", async () => {
    await withFleetPersistenceEnvCleared(async () => {
      expect(loadFleetPlatformConfig({}).persistence).toEqual({
        mode: "in-memory"
      });

      runtime = createFleetPlatformRuntime({
        config: {
          telemetryFreshnessSweepMs: 60_000
        },
        logger: new SilentStructuredLogger()
      });

      expect(runtime.config.persistence).toEqual({ mode: "in-memory" });
      expect(runtime.repository).toBeInstanceOf(InMemoryDomainStateRepository);
      expect(Object.keys((await runtime.service.getState()).robots)).toEqual([
        "robot-a"
      ]);
    });
  });

  it("requires a database URL when Postgres persistence is selected from env", () => {
    expect(() =>
      loadFleetPlatformConfig({
        FLEET_PERSISTENCE_MODE: "postgres"
      })
    ).toThrow("FLEET_PERSISTENCE_DATABASE_URL is required");
  });

  it("requires a database URL when Postgres persistence is selected from config", () => {
    expect(() =>
      createFleetPlatformRuntime({
        config: {
          persistence: {
            mode: "postgres",
            databaseUrl: " "
          }
        },
        logger: new SilentStructuredLogger()
      })
    ).toThrow("persistence.databaseUrl is required");
  });

  it("lets explicit in-memory runtime config override incomplete Postgres env", async () => {
    await withFleetPersistenceEnv(
      {
        FLEET_PERSISTENCE_MODE: "postgres",
        FLEET_PERSISTENCE_DATABASE_URL: undefined
      },
      async () => {
        runtime = createFleetPlatformRuntime({
          config: {
            persistence: { mode: "in-memory" },
            telemetryFreshnessSweepMs: 60_000
          },
          logger: new SilentStructuredLogger()
        });

        expect(runtime.config.persistence).toEqual({ mode: "in-memory" });
        expect(runtime.repository).toBeInstanceOf(InMemoryDomainStateRepository);
      }
    );
  });

  it("constructs the Postgres repository only when Postgres persistence is explicit", () => {
    runtime = createFleetPlatformRuntime({
      config: {
        persistence: {
          mode: "postgres",
          databaseUrl: testDatabaseUrl
        },
        telemetryFreshnessSweepMs: 60_000
      },
      logger: new SilentStructuredLogger()
    });

    expect(runtime.config.persistence).toEqual({
      mode: "postgres",
      databaseUrl: testDatabaseUrl
    });
    expect(runtime.repository).toBeInstanceOf(PostgresDomainStateRepository);
  });
});

/** Runs a callback with Fleet Platform persistence env vars removed for default-path tests. */
async function withFleetPersistenceEnvCleared(
  callback: () => Promise<void>
): Promise<void> {
  const originalMode = process.env.FLEET_PERSISTENCE_MODE;
  const originalDatabaseUrl = process.env.FLEET_PERSISTENCE_DATABASE_URL;
  delete process.env.FLEET_PERSISTENCE_MODE;
  delete process.env.FLEET_PERSISTENCE_DATABASE_URL;

  try {
    await callback();
  } finally {
    restoreOptionalEnv("FLEET_PERSISTENCE_MODE", originalMode);
    restoreOptionalEnv("FLEET_PERSISTENCE_DATABASE_URL", originalDatabaseUrl);
  }
}

/** Runs a callback with specific Fleet Platform persistence env vars installed. */
async function withFleetPersistenceEnv(
  values: {
    readonly FLEET_PERSISTENCE_MODE?: string | undefined;
    readonly FLEET_PERSISTENCE_DATABASE_URL?: string | undefined;
  },
  callback: () => Promise<void>
): Promise<void> {
  const originalMode = process.env.FLEET_PERSISTENCE_MODE;
  const originalDatabaseUrl = process.env.FLEET_PERSISTENCE_DATABASE_URL;
  restoreOptionalEnv("FLEET_PERSISTENCE_MODE", values.FLEET_PERSISTENCE_MODE);
  restoreOptionalEnv(
    "FLEET_PERSISTENCE_DATABASE_URL",
    values.FLEET_PERSISTENCE_DATABASE_URL
  );

  try {
    await callback();
  } finally {
    restoreOptionalEnv("FLEET_PERSISTENCE_MODE", originalMode);
    restoreOptionalEnv("FLEET_PERSISTENCE_DATABASE_URL", originalDatabaseUrl);
  }
}

/** Restores optional env vars without turning an absent value into the string "undefined". */
function restoreOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
