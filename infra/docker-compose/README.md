# Docker Compose

Local infrastructure compose files for development and integration tests.

## Local Postgres

`docker-compose.local.yml` starts a local Postgres instance for persistence
schema work. It does not require cloud services.

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
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @roboops/fleet-persistence migrate:local
```

Run the optional DB-backed schema test against a disposable local database:

```sh
ROBOOPS_RUN_POSTGRES_TESTS=true \
FLEET_PERSISTENCE_TEST_DATABASE_URL=postgres://roboops:roboops_local_password@127.0.0.1:55432/roboops_control_plane \
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @roboops/fleet-persistence test
```

The Fleet Platform runtime still uses the in-memory repository until the
Postgres adapter is wired into the runtime.

Expected later files:

```text
docker-compose.observability.yml
```
