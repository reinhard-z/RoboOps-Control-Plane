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
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The repo targets Node 22 or newer. The simulator uses the runtime WebSocket
client that ships with modern Node.

## Local Incident Demo

Terminal 1, start the Fleet Platform API:

```sh
pnpm --filter @roboops/fleet-platform dev
```

Terminal 2, start the cloud-edge simulator:

```sh
FLEET_PLATFORM_URL=http://127.0.0.1:4010 \
ROBOT_ID=robot-a \
EDGE_AGENT_VERSION=sim-0.1.0 \
SIM_SCENARIO=normal \
pnpm --filter @roboops/cloud-edge-simulator dev
```

Terminal 3, start the Operator UI:

```sh
FLEET_PLATFORM_URL=http://127.0.0.1:4010 \
OPERATOR_ROBOT_ID=robot-a \
pnpm --filter @roboops/operator-ui dev
```

Open `http://127.0.0.1:4020` and use **Create Mission** to dispatch the
default `GO_TO_POSE` command. The mission list and live event feed update from
Fleet Platform REST/SSE responses.

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

To demo stale telemetry, restart the simulator with
`SIM_SCENARIO=stale-telemetry`, create the mission, then wait about 11 seconds
before reading `/robots/robot-a`. The platform freshness sweep should move the
robot to `DEGRADED` while the mission stays active.

To demo reconnect recovery, use `SIM_SCENARIO=reconnect`. The simulator accepts
the motion command, disconnects, reconnects with a reconnect handshake, and then
resumes telemetry.

## Current Status

This repository is a pnpm monorepo with shared fleet protocol contracts, a
domain state machine, an in-memory Fleet Platform API/WebSocket gateway, and a
local cloud-edge simulator. `apps/operator-ui` now provides a lightweight local
operator console for creating/cancelling missions and watching robot freshness,
mission state, and audit events without curl.
