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

## Container Images

The repository has one shared Dockerfile for the runnable apps. Image builds
use Node 22, enable pnpm through Corepack, install from `pnpm-lock.yaml` with
`--frozen-lockfile`, build the selected app plus its workspace dependencies,
and copy a production deploy bundle into a non-root runtime image.

Build images from the repo root:

```sh
docker build -f infra/container-images/Dockerfile \
  --build-arg APP_PACKAGE=@roboops/fleet-platform \
  -t roboops/fleet-platform:local .

docker build -f infra/container-images/Dockerfile \
  --build-arg APP_PACKAGE=@roboops/operator-ui \
  -t roboops/operator-ui:local .

docker build -f infra/container-images/Dockerfile \
  --build-arg APP_PACKAGE=@roboops/cloud-edge-simulator \
  -t roboops/cloud-edge-simulator:local .

docker build -f infra/container-images/Dockerfile \
  --build-arg APP_PACKAGE=@roboops/event-worker \
  -t roboops/event-worker:local .
```

Run the in-memory Fleet Platform and Operator UI without Postgres:

```sh
docker run --rm -p 4010:4010 roboops/fleet-platform:local

docker run --rm -p 4020:4020 \
  -e FLEET_PLATFORM_URL=http://127.0.0.1:4010 \
  -e OPERATOR_ROBOT_ID=robot-a \
  roboops/operator-ui:local
```

Run the simulator against the Fleet Platform container:

```sh
docker run --rm \
  -e FLEET_PLATFORM_URL=http://host.docker.internal:4010 \
  -e ROBOT_ID=robot-a \
  -e SIM_SCENARIO=normal \
  roboops/cloud-edge-simulator:local
```

Postgres remains opt-in at runtime. Pass connection strings as environment
variables or CLI flags, never at image build time:

```sh
docker run --rm -p 4010:4010 \
  -e FLEET_PERSISTENCE_MODE=postgres \
  -e FLEET_PERSISTENCE_DATABASE_URL=postgres://user:password@host:5432/db \
  roboops/fleet-platform:local

docker run --rm roboops/event-worker:local

docker run --rm \
  -e FLEET_PERSISTENCE_DATABASE_URL=postgres://user:password@host:5432/db \
  roboops/event-worker:local --publish-noop
```

The Event Worker image prints usage by default so container startup does not
require a database. Supplying `FLEET_PERSISTENCE_DATABASE_URL`,
`DATABASE_URL`, or `--database-url` opts into the existing Postgres-backed
worker behavior. On Linux, add
`--add-host=host.docker.internal:host-gateway` when using the
`host.docker.internal` examples.

## Local Incident Demo

Run the full local stack from the repo root:

```sh
pnpm dev
```

This starts every workspace app that has a dev script in parallel, including
the Fleet Platform API, cloud-edge simulator, Operator UI, and event worker.
The Operator UI is available at `http://127.0.0.1:4020`.

The demo endpoints and UI demo controls are disabled by default. A normal local
demo does not require any secrets: leave `DEMO_MODE`,
`DEMO_ADMIN_TOKEN`, `OPERATOR_DEMO_MODE`, and `OPERATOR_DEMO_ADMIN_TOKEN`
unset. Use the per-app commands below when you want to override scenarios or
enable the local reset/control loop. For that loop, use the same demo token in
the Fleet Platform and Operator UI terminals.

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
server-side action. The UI disables mission creation while `robot-a` already
has active work, and blocked/rejected mission rows show the platform reason
when one is available. Selected mission details show the mission id, active,
terminal, blocked, and manual-review grouping, command progress, API
availability, simulator connection state, and concise action feedback without
exposing raw HTTP text in normal operator flows. **Mark Stale** and
**Reconnect** drive the protected demo fault endpoints when you want to
demonstrate those paths without restarting every process.

The protected demo endpoints are also available over HTTP when Fleet Platform
is running with `DEMO_MODE=true`:

```sh
curl -s -X POST http://127.0.0.1:4010/demo/scenarios/reset \
  -H 'x-demo-admin-token: local-demo-token'

curl -s -X POST http://127.0.0.1:4010/demo/scenarios/incident/start \
  -H 'x-demo-admin-token: local-demo-token'

curl -s -X POST http://127.0.0.1:4010/demo/faults/disconnect \
  -H 'x-demo-admin-token: local-demo-token'

curl -s -X POST http://127.0.0.1:4010/demo/faults/reconnect \
  -H 'x-demo-admin-token: local-demo-token'
```

The normal mission flow is still available over HTTP without demo endpoints:

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

## ROS2 Edge Agent Skeleton

`edge/ros2-edge-agent-cpp` contains the ROS2 Jazzy C++ package scaffold for the
robot-near edge agent. It mirrors the existing Fleet Platform edge wire shapes,
loads `FLEET_PLATFORM_URL`, `ROBOT_ID`, and `EDGE_AGENT_VERSION`, derives the
same outbound `/edge/connect?robotId=...` WebSocket URL as the simulator, and
logs the intended connection behavior.

This skeleton does not implement a WebSocket client, ROS2 topic/action
adapters, navigation, SLAM, Gazebo, or any cloud-to-ROS2/DDS bridge. Build and
run notes are in `edge/ros2-edge-agent-cpp/README.md`. Without installing ROS2
on the host, run the Jazzy container check:

```sh
sh edge/ros2-edge-agent-cpp/scripts/run-ros2-jazzy-container-check.sh
```

For a faster non-ROS compiler smoke check:

```sh
sh edge/ros2-edge-agent-cpp/scripts/run-static-smoke.sh
```

The Kubernetes edge operations reference in `infra/k8s/edge` shows how to run
that robot-near agent from a k3s-compatible cluster without changing the Fleet
Platform protocol or exposing ROS2/DDS to the cloud.

`docs/robot-software-rollout.md` and
`infra/argocd/applications/robot-edge-agent-reference.yaml` add the narrow
GitOps reference for edge-agent software rollout. ArgoCD deploys image/config
versions only; Fleet Platform remains responsible for mission dispatch.

## Evidence Capture Demo Script

Use these commands when recording public-demo clips from a clean local run.

Terminal 1, Fleet Platform with protected demo controls:

```sh
DEMO_MODE=true \
DEMO_ADMIN_TOKEN=local-demo-token \
CORS_ALLOW_ORIGIN=http://127.0.0.1:4020 \
pnpm --filter @roboops/fleet-platform dev
```

Terminal 2, simulator in normal mode:

```sh
FLEET_PLATFORM_URL=http://127.0.0.1:4010 \
ROBOT_ID=robot-a \
EDGE_AGENT_VERSION=sim-0.1.0 \
SIM_SCENARIO=normal \
pnpm --filter @roboops/cloud-edge-simulator dev
```

Terminal 3, Operator UI with demo controls:

```sh
FLEET_PLATFORM_URL=http://127.0.0.1:4010 \
OPERATOR_ROBOT_ID=robot-a \
OPERATOR_DEMO_MODE=true \
OPERATOR_DEMO_ADMIN_TOKEN=local-demo-token \
pnpm --filter @roboops/operator-ui dev
```

Recording walkthrough:

1. Open `http://127.0.0.1:4020` and confirm the API status shows available.
2. Click **Reset State** and record the empty mission and event panels.
3. Click **Start Clean Mission** and record dispatch, edge acknowledgement,
   running telemetry, map movement, and event feed updates.
4. Click **Mark Stale** and wait for the robot state to show degraded.
5. Click **Reconnect** and record reconciliation returning the mission to a
   recovered running state.
6. Click **Start Clean Mission** again to prove repeated runs do not keep old
   mission or idempotency state.

Hosted demo environment:

```sh
# Fleet Platform
HOST=0.0.0.0
PORT=4010
DEMO_MODE=true
DEMO_ADMIN_TOKEN=<high-entropy-demo-token>
CORS_ALLOW_ORIGIN=https://<operator-ui-host>

# Operator UI
OPERATOR_UI_HOST=0.0.0.0
OPERATOR_UI_PORT=4020
FLEET_PLATFORM_URL=https://<fleet-platform-host>
OPERATOR_ROBOT_ID=robot-a
OPERATOR_DEMO_MODE=true
OPERATOR_DEMO_ADMIN_TOKEN=<same-high-entropy-demo-token>

# Simulator
FLEET_PLATFORM_URL=https://<fleet-platform-host>
ROBOT_ID=robot-a
EDGE_AGENT_VERSION=sim-0.1.0
SIM_SCENARIO=normal
```

The demo token is a narrow shared bearer for reset and fault controls only. It
is not user authentication, should not be committed, and should sit behind the
hosting provider's normal access controls for a public recording environment.
For local demos, `CORS_ALLOW_ORIGIN=http://127.0.0.1:4020` is the strict
setting; `*` is acceptable only for throwaway local testing. For hosted demos,
set `CORS_ALLOW_ORIGIN` to the exact Operator UI origin.

Teardown after recording: stop the Operator UI, simulator, and Fleet Platform
processes, then remove hosted demo env vars or rotate the demo token.

## Current Status

This repository is a pnpm monorepo with shared fleet protocol contracts, a
domain state machine, a Fleet Platform API/WebSocket gateway with in-memory
persistence by default and explicit Postgres opt-in, and a local cloud-edge
simulator. `apps/operator-ui` now provides a lightweight local operator console
for creating/cancelling missions and watching robot freshness, mission state,
robot pose/target movement, and audit events without curl.
