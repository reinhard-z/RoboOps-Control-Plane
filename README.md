# RoboOps Control Plane

[![CI](https://github.com/reinhard-z/RoboOps-Control-Plane/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/reinhard-z/RoboOps-Control-Plane/actions/workflows/ci.yml)

RoboOps Control Plane is a portfolio prototype for cloud-to-edge fleet
operations with intermittently connected ROS2 robots. It focuses on mission
dispatch, command acknowledgement, telemetry freshness, reconnect
reconciliation, auditability, and operator visibility.

## Case Study Demo

RoboOps demonstrates a cloud control plane that can dispatch work to a
robot-near runtime, keep operators informed when telemetry goes stale, and
reconcile state after the edge reconnects. The default demo path is intentionally
local and reproducible: Fleet Platform, Operator UI, and a deterministic
cloud-edge simulator run on one machine. It does not require real robot hardware.

[Portfolio page](https://mrza.ch/) includes the public RoboOps case-study
summary. The local recording path uses the simulator by default; the Isaac/Brev
path is separate evidence for ROS2 and NVIDIA Isaac Sim integration.

**Command dispatch flow**

The command animation shows the operator creating a mission, Fleet Platform
translating it into an edge command, and the robot-near runtime acknowledging
the work back to the cloud.

<img src="docs/assets/roboops-command.gif" alt="Animated RoboOps command dispatch flow" width="800">

**Telemetry freshness and reconnect flow**

The heartbeat animation shows the other side of the incident: telemetry updates
stop, Fleet Platform marks the robot degraded, and the reconnect handshake
reconciles cloud and edge state.

<img src="docs/assets/roboops-heartbeat.gif" alt="Animated RoboOps telemetry heartbeat flow" width="800">

**Operator UI with Isaac simulation evidence**

The Operator UI preview shows the browser console used for mission state, robot
health, map movement, demo fault controls, and the event timeline while the
Isaac/Brev path provides robotics simulation evidence.

![Operator UI connected to the Isaac simulation path](docs/assets/operatorui-and-isaac.png)

The core incident flow is:

```text
operator creates mission
-> Fleet Platform dispatches a command
-> cloud-edge simulator acknowledges it
-> telemetry becomes stale
-> robot health degrades while the mission remains active
-> reconnect handshake reconciles cloud and edge state
-> Operator UI shows the event and audit timeline
```

## What This Demonstrates

- Cloud-to-edge robot operations with a cloud API, operator console, and
  robot-near runtime boundary.
- Mission dispatch from the Operator UI through Fleet Platform to the edge.
- Command acknowledgement and audit history for the work sent to the robot.
- Telemetry freshness tracking so stale robot updates become visible operator
  risk.
- Robot state degradation while a mission remains active and telemetry is no
  longer fresh.
- Reconnect reconciliation after cloud and edge state diverge during an
  interruption.
- Operator visibility through robot health, mission state, map movement, event
  history, audit events, and metrics.

## What Exists Now

| Area                           | Status                                                                                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fleet Platform                 | Implemented TypeScript API with REST reads/actions, SSE UI events, outbound edge WebSocket gateway, in-memory state by default, optional Postgres repositories, transactional outbox write path, metrics, and structured incident logs.                                   |
| Cloud-edge simulator           | Implemented local robot simulator for command ack, telemetry, stale telemetry, disconnect, reconnect, and simple pose movement. This is the default reviewer demo robot.                                                                                                  |
| Isaac/Brev robotics smoke path | Documented and validated on-demand simulation path under `sim/isaac-sim`. It uses NVIDIA Brev / Isaac Launchable, Isaac Sim, Nova Carter ROS scenes, ROS2 sidecar probes, and the same Fleet Platform edge contract.                                                      |
| Operator UI                    | Implemented lightweight browser console for mission creation/cancel, robot freshness, mission state, map movement, demo fault controls, and event timeline.                                                                                                               |
| Event worker                   | Implemented outbox publisher worker for durable Postgres-backed runs.                                                                                                                                                                                                     |
| ROS2 edge agent                | Skeleton only. It mirrors protocol/configuration shape but does not yet implement WebSocket transport, ROS2 topics/actions, navigation, SLAM, Isaac Sim, or hardware. The Isaac/Brev smoke path currently uses adapter scripts under `sim/isaac-sim`, not this C++ agent. |
| Kubernetes/GitOps              | Production-reference manifests and rollout notes only. They document deploy patterns for software versions, not robot mission control.                                                                                                                                    |

## Boundaries

- GitOps deploys Fleet Platform and edge-agent software versions. Fleet
  Platform dispatches missions.
- ROS2/DDS stays local to the robot-near runtime. The cloud API does not talk
  directly to ROS2/DDS.
- The default local reviewer demo uses a simulator, not a hosted robot and not
  real hardware.
- The Isaac/Brev smoke path is the preferred robotics simulation evidence path,
  but it runs on demand rather than as the always-on public demo.
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

GitHub Actions builds the same image matrix on every push and pull request.
Pushes to `main`, git tags, or manual workflow runs publish GHCR images:

```text
ghcr.io/<owner>/roboops-fleet-platform:sha-<commit-sha>
ghcr.io/<owner>/roboops-operator-ui:sha-<commit-sha>
ghcr.io/<owner>/roboops-cloud-edge-simulator:sha-<commit-sha>
ghcr.io/<owner>/roboops-event-worker:sha-<commit-sha>
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
- [AWS Fargate + Brev Isaac runbook](docs/aws-fargate-brev-isaac-runbook.md)
  deploys only Fleet Platform and Operator UI to AWS and connects the Brev
  Isaac sender outbound to the hosted Fleet Platform.
- [AWS/Kubernetes demo runbook](docs/aws-kubernetes-demo-runbook.md) explains
  how to capture short-lived hosted demo evidence without expanding the project
  into a production hosting guide.
- [Robot software rollout](docs/robot-software-rollout.md) explains the
  GitOps boundary: ArgoCD rolls out image/config versions, while Fleet Platform
  remains responsible for missions.
- [ROS2 edge agent skeleton](edge/ros2-edge-agent-cpp/README.md) documents the
  robot-near package scaffold.
- [Local Docker Compose](infra/docker-compose/README.md), [Kubernetes edge
  reference](infra/k8s/edge/README.md), and [ArgoCD references](infra/argocd/applications/README.md)
  are deployment references, not required for the local incident demo.

## Usage Notice

This repository is public for portfolio and case-study review. See [NOTICE.md](NOTICE.md).
