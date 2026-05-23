# Local Incident Demo Script

This script is the reviewer walkthrough for the local incident flow. It uses a
simulated robot so the full stack can run without ROS2, DDS, real hardware, or
a hosted robot.

## Scope

- Fleet Platform dispatches missions and owns cloud state.
- The cloud-edge simulator acts as the robot-near runtime for the demo.
- Operator UI creates missions, injects demo faults, and shows the event
  timeline.
- No cloud process connects directly to ROS2/DDS; future edge-agent work keeps
  ROS2/DDS inside the robot-near runtime.
- The demo is not safety certification and does not exercise real hardware.
- Demo controls require `DEMO_MODE=true` and a shared local demo token.
- GitOps and Kubernetes docs are production references for software rollout;
  they are not part of mission dispatch.

This script is intentionally the default local reviewer path. For robotics
simulation evidence with Isaac Sim, Nova Carter ROS scenes, ROS2 topic probes,
and the same Fleet Platform edge contract, use
[`sim/isaac-sim`](../sim/isaac-sim/README.md).

## Start The Stack

Run each command from the repo root in a separate terminal.

Terminal 1, start Fleet Platform:

```sh
DEMO_MODE=true \
DEMO_ADMIN_TOKEN=local-demo-token \
CORS_ALLOW_ORIGIN=http://127.0.0.1:4020 \
pnpm --filter @roboops/fleet-platform dev
```

Fleet Platform uses in-memory persistence by default. To opt into Postgres,
apply the `@roboops/fleet-persistence` migrations first, then set
`FLEET_PERSISTENCE_MODE=postgres` and `FLEET_PERSISTENCE_DATABASE_URL`. For the
local Docker Compose database, validate the migrated repository read path:

```sh
pnpm --filter @roboops/fleet-platform check:postgres:local
```

Terminal 2, start the cloud-edge simulator:

```sh
FLEET_PLATFORM_URL=http://127.0.0.1:4010 \
ROBOT_ID=robot-a \
EDGE_AGENT_VERSION=sim-0.1.0 \
SIM_SCENARIO=normal \
pnpm --filter @roboops/cloud-edge-simulator dev
```

Terminal 3, start Operator UI:

```sh
FLEET_PLATFORM_URL=http://127.0.0.1:4010 \
OPERATOR_ROBOT_ID=robot-a \
OPERATOR_DEMO_MODE=true \
OPERATOR_DEMO_ADMIN_TOKEN=local-demo-token \
pnpm --filter @roboops/operator-ui dev
```

Open `http://127.0.0.1:4020`.

## Walkthrough

1. Confirm the UI shows Fleet Platform as available and the simulator as
   connected for `robot-a`.
2. Click **Reset State** to clear repository state for the demo robot.
3. Click **Create Mission** or **Start Clean Mission** to dispatch the default
   `GO_TO_POSE` command.
4. Watch the mission move through dispatch, edge acknowledgement, running
   state, telemetry updates, and map movement.
5. Click **Mark Stale** and wait for the robot state to show degraded health.
   The mission should remain active while telemetry freshness becomes the risk.
6. Click **Reconnect** and inspect the event timeline for reconnect and
   reconciliation entries.
7. Re-run **Start Clean Mission** if you want to show that reset plus
   idempotency state does not leak between recordings.

## API Evidence

The same flow can be inspected through the Fleet Platform API.

```sh
curl -s http://127.0.0.1:4010/robots/robot-a
curl -s http://127.0.0.1:4010/missions
curl -s http://127.0.0.1:4010/events
curl -s http://127.0.0.1:4010/audit-events
curl -s http://127.0.0.1:4010/metrics
```

The protected demo endpoints are available only when Fleet Platform runs with
`DEMO_MODE=true`:

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

A normal mission can still be created without demo endpoints:

```sh
curl -s http://127.0.0.1:4010/missions \
  -H 'content-type: application/json' \
  -d '{"robotId":"robot-a","type":"GO_TO_POSE","payload":{"target":{"x":2,"y":4.5,"theta":1.57}}}'
```

Use the returned mission id for focused reads:

```sh
curl -s http://127.0.0.1:4010/missions/<missionId>
curl -s "http://127.0.0.1:4010/events?missionId=<missionId>"
curl -s "http://127.0.0.1:4010/audit-events?missionId=<missionId>"
```

## Simulator Scenario Variants

Use these when you want to demonstrate stale telemetry or reconnect by
restarting only the simulator instead of using UI demo controls.

Stale telemetry:

```sh
FLEET_PLATFORM_URL=http://127.0.0.1:4010 \
ROBOT_ID=robot-a \
EDGE_AGENT_VERSION=sim-0.1.0 \
SIM_SCENARIO=stale-telemetry \
pnpm --filter @roboops/cloud-edge-simulator dev
```

Create a clean mission, wait about 11 seconds, then read `/robots/robot-a`.
Fleet Platform should mark the robot degraded while the mission stays active.

Reconnect:

```sh
FLEET_PLATFORM_URL=http://127.0.0.1:4010 \
ROBOT_ID=robot-a \
EDGE_AGENT_VERSION=sim-0.1.0 \
SIM_SCENARIO=reconnect \
pnpm --filter @roboops/cloud-edge-simulator dev
```

Create a clean mission. The simulator accepts the command, disconnects,
reconnects with a handshake, and resumes telemetry.

## Recording Notes

For local recordings, keep `CORS_ALLOW_ORIGIN=http://127.0.0.1:4020`. A hosted
recording environment should use a high-entropy demo token, exact CORS origin,
provider-level access controls, and no real robot credentials.

For a short-lived AWS/Kubernetes recording, use the focused evidence checklist
in the [AWS/Kubernetes demo runbook](aws-kubernetes-demo-runbook.md).

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

The demo token is a narrow bearer for reset and fault controls only. It is not
user authentication, should not be committed, and should be rotated or removed
after evidence capture.
