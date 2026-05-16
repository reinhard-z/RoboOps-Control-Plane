# RoboOps Control Plane

RoboOps Control Plane is a portfolio prototype for cloud-to-edge fleet
operations with intermittently connected ROS2 robots. It focuses on mission
dispatch, command acknowledgement, telemetry freshness, reconnect
reconciliation, auditability, and operator visibility.

The local demo shows one incident end to end:

```text
operator creates mission
-> Fleet Platform dispatches a command
-> cloud-edge simulator acknowledges it
-> telemetry becomes stale
-> robot health degrades while the mission remains active
-> reconnect handshake reconciles cloud and edge state
-> Operator UI shows the event and audit timeline
```

## What Exists Now

| Area | Status |
| --- | --- |
| Fleet Platform | Implemented TypeScript API with REST reads/actions, SSE UI events, outbound edge WebSocket gateway, in-memory state by default, optional Postgres repositories, transactional outbox write path, metrics, and structured incident logs. |
| Cloud-edge simulator | Implemented local robot simulator for command ack, telemetry, stale telemetry, disconnect, reconnect, and simple pose movement. This is the default reviewer demo robot. |
| Operator UI | Implemented lightweight browser console for mission creation/cancel, robot freshness, mission state, map movement, demo fault controls, and event timeline. |
| Event worker | Implemented outbox publisher worker for durable Postgres-backed runs. |
| ROS2 edge agent | Skeleton only. It mirrors protocol/configuration shape but does not yet connect to WebSocket, ROS2 topics/actions, navigation, SLAM, Gazebo, or hardware. |
| Kubernetes/GitOps | Production-reference manifests and rollout notes only. They document deploy patterns for software versions, not robot mission control. |

## Boundaries

- GitOps deploys Fleet Platform and edge-agent software versions. Fleet
  Platform dispatches missions.
- ROS2/DDS stays local to the robot-near runtime. The cloud API does not talk
  directly to ROS2/DDS.
- The reviewer demo uses a simulator, not a hosted robot and not real hardware.
- This project is not safety-certified and is not a production safety system.
- It does not claim full Open-RMF, VDA5050, MassRobotics, navigation, SLAM, AI
  autonomy, or real hardware integration.
- Demo reset and fault controls are disabled by default and require explicit
  demo mode plus a demo admin token.

## Quick Start

The repo targets Node 22 or newer and uses pnpm workspaces.

```sh
pnpm install
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm dev` starts every workspace app with a `dev` script in parallel,
including Fleet Platform, cloud-edge simulator, Operator UI, and event worker.
The Operator UI listens at `http://127.0.0.1:4020`.

## Local Incident Demo

For the most repeatable portfolio walkthrough, use three terminals from the
repo root.

Terminal 1, Fleet Platform with protected demo controls:

```sh
DEMO_MODE=true \
DEMO_ADMIN_TOKEN=local-demo-token \
CORS_ALLOW_ORIGIN=http://127.0.0.1:4020 \
pnpm --filter @roboops/fleet-platform dev
```

Terminal 2, cloud-edge simulator:

```sh
FLEET_PLATFORM_URL=http://127.0.0.1:4010 \
ROBOT_ID=robot-a \
EDGE_AGENT_VERSION=sim-0.1.0 \
SIM_SCENARIO=normal \
pnpm --filter @roboops/cloud-edge-simulator dev
```

Terminal 3, Operator UI:

```sh
FLEET_PLATFORM_URL=http://127.0.0.1:4010 \
OPERATOR_ROBOT_ID=robot-a \
OPERATOR_DEMO_MODE=true \
OPERATOR_DEMO_ADMIN_TOKEN=local-demo-token \
pnpm --filter @roboops/operator-ui dev
```

Walkthrough:

1. Open `http://127.0.0.1:4020`.
2. Click **Reset State**.
3. Click **Create Mission** or **Start Clean Mission**.
4. Watch dispatch, edge acknowledgement, telemetry, and map movement.
5. Click **Mark Stale** and wait for the robot to show degraded health.
6. Click **Reconnect** and inspect reconciliation in the event timeline.
7. Inspect `/events`, `/audit-events`, and `/metrics` when you want API-level
   evidence.

The detailed script, curl alternatives, hosted recording notes, and simulator
scenario variants live in [docs/demo-script.md](docs/demo-script.md).

## Container Images

The repository uses one shared Dockerfile for runnable apps. Images use Node
22, enable pnpm through Corepack, build the selected app and dependencies, and
copy a production deploy bundle into a non-root runtime image.

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

Run the in-memory Fleet Platform, Operator UI, and simulator:

```sh
docker run --rm -p 4010:4010 roboops/fleet-platform:local

docker run --rm -p 4020:4020 \
  -e FLEET_PLATFORM_URL=http://127.0.0.1:4010 \
  -e OPERATOR_ROBOT_ID=robot-a \
  roboops/operator-ui:local

docker run --rm \
  -e FLEET_PLATFORM_URL=http://host.docker.internal:4010 \
  -e ROBOT_ID=robot-a \
  -e SIM_SCENARIO=normal \
  roboops/cloud-edge-simulator:local
```

Postgres is opt-in at runtime:

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

On Linux, add `--add-host=host.docker.internal:host-gateway` when using the
`host.docker.internal` simulator example.

## Production References

- [Current architecture](docs/architecture/current-architecture.md) explains
  the API, domain, simulator, UI, persistence, observability, and deployment
  boundaries.
- [Robot software rollout](docs/robot-software-rollout.md) explains the
  GitOps boundary: ArgoCD rolls out image/config versions, while Fleet Platform
  remains responsible for missions.
- [ROS2 edge agent skeleton](edge/ros2-edge-agent-cpp/README.md) documents the
  robot-near package scaffold.
- [Local Docker Compose](infra/docker-compose/README.md), [Kubernetes edge
  reference](infra/k8s/edge/README.md), and [ArgoCD references](infra/argocd/applications/README.md)
  are deployment references, not required for the local incident demo.
