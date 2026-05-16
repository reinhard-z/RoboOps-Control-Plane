# Docker Compose

Local infrastructure compose files for development and integration tests.

## Local Postgres

`docker-compose.local.yml` starts a local Postgres instance for persistence
schema, adapter, and explicit Fleet Platform runtime work. It does not require
cloud services.

```sh
docker-compose -f infra/docker-compose/docker-compose.local.yml up -d postgres
```

Connection details:

```text
Database: roboops_control_plane
User:     roboops
Password: roboops_local_password
Port:     55432
URL:      postgres://roboops:roboops_local_password@127.0.0.1:55432/roboops_control_plane
```

Apply `packages/fleet-persistence` migrations after the container is healthy:

```sh
pnpm --filter @roboops/fleet-persistence migrate:local
```

Validate that Fleet Platform can read the migrated repository state before
starting the API in Postgres mode:

```sh
pnpm --filter @roboops/fleet-platform check:postgres:local
```

This validation command is read-only. It does not apply migrations and reports
sanitized diagnostics if the database is unavailable or the repository schema is
not ready.

Fleet Platform defaults to the in-memory repository. To run it against this
local Postgres database, first apply migrations, then start the platform with
both persistence env vars:

```sh
FLEET_PERSISTENCE_MODE=postgres \
FLEET_PERSISTENCE_DATABASE_URL=postgres://roboops:roboops_local_password@127.0.0.1:55432/roboops_control_plane \
pnpm --filter @roboops/fleet-platform dev
```

Normal server startup does not run migrations automatically.
After startup, `/health/ready` verifies that the configured repository can read
the current domain state. In Postgres mode it returns `503` with a sanitized
structured error when the database is unavailable or not migrated.

Run the optional DB-backed schema and repository adapter tests against a
disposable local database:

```sh
ROBOOPS_RUN_POSTGRES_TESTS=true \
FLEET_PERSISTENCE_TEST_DATABASE_URL=postgres://roboops:roboops_local_password@127.0.0.1:55432/roboops_control_plane \
pnpm --filter @roboops/fleet-persistence test
```

Run the optional Fleet Platform runtime persistence check against the same local
database. The test applies any pending `fleet-persistence` migrations before it
starts the Postgres-backed runtime:

```sh
ROBOOPS_RUN_POSTGRES_TESTS=true \
FLEET_PERSISTENCE_TEST_DATABASE_URL=postgres://roboops:roboops_local_password@127.0.0.1:55432/roboops_control_plane \
pnpm --filter @roboops/fleet-platform test
```

Leave `FLEET_PERSISTENCE_MODE` unset for the default in-memory local demo.

Expected later files:

```text
docker-compose.observability.yml
```
