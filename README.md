# RoboOps Control Plane

A cloud-to-edge robot fleet operations platform prototype for dispatching, supervising, reconciling, and auditing missions for intermittently connected ROS 2 robots.

The first milestone is a local incident demo:

```text
operator creates mission
-> command is dispatched
-> edge acknowledges command
-> telemetry becomes stale
-> robot becomes degraded
-> reconnect handshake happens
-> mission is reconciled
-> audit log explains the incident
```

## Development

```sh
pnpm install
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The repo targets Node 22 or newer. The simulator uses the runtime WebSocket
client that ships with modern Node.

## Local Incident Demo

Run the full local stack from the repo root:

```sh
pnpm dev
```

This starts every workspace app that has a dev script in parallel, including
the Fleet Platform API, cloud-edge simulator, Operator UI, and event worker.
The Operator UI is available at `http://127.0.0.1:4020`.

The demo endpoints and UI demo controls are disabled by default. Use the
per-app commands below when you want to override scenarios or enable the local
reset/control loop. For that loop, use the same demo token in the Fleet
Platform and Operator UI terminals.

Terminal 1, start the Fleet Platform API without demo admin endpoints:

```sh
pnpm --filter @roboops/fleet-platform dev
```

Fleet Platform uses in-memory persistence by default. To opt into Postgres,
apply the `@roboops/fleet-persistence` migrations first, then set
`FLEET_PERSISTENCE_MODE=postgres` and `FLEET_PERSISTENCE_DATABASE_URL`.
For the local Docker Compose database, validate the migrated repository read
path before starting the API:

```sh
pnpm --filter @roboops/fleet-platform check:postgres:local
```

The readiness check is opt-in, read-only, and does not run migrations. It
prints sanitized diagnostics if the database is unavailable or not migrated.
Fleet Platform also exposes in-process Prometheus text metrics at `/metrics`
without requiring a collector or Prometheus server:

```sh
curl -s http://127.0.0.1:4010/metrics
```

Metric labels use stable route templates and sanitized error types; IDs,
database URLs, credentials, and raw driver text are not used as labels.

Or start it with protected demo reset/control endpoints enabled:

```sh
DEMO_MODE=true \
DEMO_ADMIN_TOKEN=local-demo-token \
pnpm --filter @roboops/fleet-platform dev
```

Terminal 2, start the cloud-edge simulator in normal mode:

```sh
FLEET_PLATFORM_URL=http://127.0.0.1:4010 \
ROBOT_ID=robot-a \
EDGE_AGENT_VERSION=sim-0.1.0 \
SIM_SCENARIO=normal \
pnpm --filter @roboops/cloud-edge-simulator dev
```

Use the same command with `SIM_SCENARIO=stale-telemetry` to accept the mission
and then stop telemetry so Fleet Platform marks the robot degraded:

```sh
FLEET_PLATFORM_URL=http://127.0.0.1:4010 \
ROBOT_ID=robot-a \
EDGE_AGENT_VERSION=sim-0.1.0 \
SIM_SCENARIO=stale-telemetry \
pnpm --filter @roboops/cloud-edge-simulator dev
```

Use `SIM_SCENARIO=reconnect` to accept the mission, disconnect, reconnect with
a handshake, and resume telemetry:

```sh
FLEET_PLATFORM_URL=http://127.0.0.1:4010 \
ROBOT_ID=robot-a \
EDGE_AGENT_VERSION=sim-0.1.0 \
SIM_SCENARIO=reconnect \
pnpm --filter @roboops/cloud-edge-simulator dev
```

Terminal 3, start the Operator UI with demo controls disabled:

```sh
FLEET_PLATFORM_URL=http://127.0.0.1:4010 \
OPERATOR_ROBOT_ID=robot-a \
pnpm --filter @roboops/operator-ui dev
```

Or start it with demo controls enabled:

```sh
FLEET_PLATFORM_URL=http://127.0.0.1:4010 \
OPERATOR_ROBOT_ID=robot-a \
OPERATOR_DEMO_MODE=true \
OPERATOR_DEMO_ADMIN_TOKEN=local-demo-token \
pnpm --filter @roboops/operator-ui dev
```

Open `http://127.0.0.1:4020`. With demo controls disabled, use **Create
Mission** to dispatch the default `GO_TO_POSE` command. With demo controls
enabled, use **Reset State** to clear residual repository state, or **Start
Clean Mission** to reset and dispatch the normal demo `GO_TO_POSE` in one
action. The UI disables mission creation while `robot-a` already has active
work, and blocked/rejected mission rows show the platform reason when one is
available. Selected mission details show the mission id, active, terminal,
blocked, and manual-review grouping, command progress, and cancel rejection
feedback without exposing raw HTTP text in normal operator flows. **Mark
Stale** and **Reconnect** drive the protected demo fault endpoints when you
want to demonstrate those paths without restarting every process.

The protected demo endpoints are also available over HTTP when Fleet Platform
is running with `DEMO_MODE=true`:

```sh
curl -s -X POST http://127.0.0.1:4010/demo/scenarios/reset \
  -H 'x-demo-admin-token: local-demo-token'

curl -s -X POST http://127.0.0.1:4010/demo/scenarios/incident/start \
  -H 'x-demo-admin-token: local-demo-token'
```

The same flow is still available over HTTP:

```sh
curl -s http://127.0.0.1:4010/missions \
  -H 'content-type: application/json' \
  -d '{"robotId":"robot-a","type":"GO_TO_POSE","payload":{"target":{"x":2,"y":4.5,"theta":1.57}}}'
```

The simulator receives `platform.command`, sends an accepted
`edge.command_ack`, and then emits `edge.telemetry` heartbeats. Use the returned
mission id to verify the mission reaches `RUNNING`:

```sh
curl -s http://127.0.0.1:4010/missions/<missionId>
curl -s http://127.0.0.1:4010/robots/robot-a
```

For stale telemetry with the simulator scenario, restart only the simulator with
`SIM_SCENARIO=stale-telemetry`, create a clean mission, then wait about 11
seconds before reading `/robots/robot-a`. The platform freshness sweep should
move the robot to `DEGRADED` while the mission stays active.

For reconnect recovery with the simulator scenario, restart only the simulator
with `SIM_SCENARIO=reconnect` and start a clean mission. The simulator accepts
the motion command, disconnects, reconnects with a reconnect handshake, and then
resumes telemetry.

## Current Status

This repository is a pnpm monorepo with shared fleet protocol contracts, a
domain state machine, a Fleet Platform API/WebSocket gateway with in-memory
persistence by default and explicit Postgres opt-in, and a local cloud-edge
simulator. `apps/operator-ui` now provides a lightweight local operator console
for creating/cancelling missions and watching robot freshness, mission state,
and audit events without curl.
