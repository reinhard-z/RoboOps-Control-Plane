# Isaac Sim Telemetry Smoke Scenario

This scenario proves the robotics simulator can feed the existing RoboOps cloud
contract without adding a direct cloud-to-ROS2/DDS bridge.

## Goal

Demonstrate this path:

```text
Isaac Sim
-> ROS2 bridge topics
-> robot-near edge adapter
-> edge.telemetry / robot.telemetry.v1
-> Fleet Platform
-> Operator UI telemetry freshness and map movement
```

## Preconditions

- Brev Launchable is running.
- `isaac-sim/isaac-launchable` services are healthy.
- The Isaac viewer opens at `/viewer`.
- RoboOps is checked out at `~/RoboOps-Control-Plane`.
- Fleet Platform is reachable from the Brev instance.

## Start Isaac Sim

From the browser VS Code terminal:

```sh
ACCEPT_EULA=y /isaac-sim/runheadless.sh
```

Open the Brev secure link in another browser tab and change the path to
`/viewer`. Wait for the Isaac Sim UI to show the application.

## Probe ROS2 Topics

From the RoboOps checkout:

```sh
cd ~/RoboOps-Control-Plane
sim/isaac-sim/scripts/probe-ros2-topics.sh
```

Expected first-pass evidence:

- `ros2` is available in the terminal environment.
- `/clock` appears when the ROS2 bridge is active.
- At least one pose source exists, such as `/tf`, `/odom`, or a dedicated robot
  pose topic.

## Validated First Run

The first Brev run reached topic discovery but not sample extraction:

- `/viewer` rendered Isaac Sim.
- Nova Carter ROS and warehouse scenes loaded.
- ROS2 Humble on the Brev host discovered `/clock`, `/tf`, `/chassis/odom`,
  `/cmd_vel`, lidar, camera, and IMU topics.
- `ros2 topic info` showed publishers.
- `ros2 topic echo` and `ros2 topic hz` from the Brev host did not receive
  samples.

Next time, continue by running the probe or adapter inside the Isaac `vscode`
container or by adding a supported ROS2 sidecar to the Launchable Compose setup.
Do not treat host-side topic discovery alone as enough for telemetry mapping.

## Telemetry Mapping

Use the first available pose source to build a minimal telemetry heartbeat:

| `robot.telemetry.v1` field | First smoke source |
| --- | --- |
| `observedAt` | `/clock` or edge wall time |
| `pose.x` | robot pose in map/world frame |
| `pose.y` | robot pose in map/world frame |
| `pose.theta` | yaw derived from orientation |
| `batteryPercent` | fixed fallback, for example `80` |
| `health` | fixed `OK` until diagnostics are wired |
| `connectionState` | `ONLINE` while the adapter is connected |
| `lastSeenCommandSequence` | edge adapter command state |
| `edgeAgentVersion` | edge adapter build/config |

The smoke test should not stream camera frames, lidar scans, IMU samples,
semantic labels, generated datasets, or maps to Fleet Platform.

## Pass Criteria

- Isaac Sim launches and renders through `/viewer`.
- ROS2 probe records samples from `/clock` and one usable pose source.
- Edge adapter emits a valid `edge.telemetry` message.
- Fleet Platform accepts the telemetry without protocol changes.
- Operator UI shows fresh telemetry and a robot pose update.

## Case Study Evidence

Capture:

- screenshot of Brev Launchable running;
- screenshot of Isaac Sim viewer;
- terminal output from `probe-ros2-topics.sh`;
- one sample `edge.telemetry` JSON payload;
- Operator UI screenshot showing fresh telemetry/map movement.
