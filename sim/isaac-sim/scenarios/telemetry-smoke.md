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
- The Launchable has the Fast DDS UDP profile and `ros2-probe` Compose sidecar
  from `sim/isaac-sim/launchable/sidecar-probe.md`.
- Fleet Platform is reachable from the Brev instance.

## Start Isaac Sim

From the browser VS Code terminal:

```sh
ACCEPT_EULA=y /isaac-sim/runheadless.sh
```

Open the Brev secure link in another browser tab and change the path to
`/viewer`. Wait for the Isaac Sim UI to show the application.

## Probe ROS2 Topics

From the Launchable checkout on the Brev host:

```sh
cd ~/isaac-launchable/isaac-lab
docker compose --profile probe run --rm ros2-probe
```

Expected first-pass evidence:

- `ros2` is available in the terminal environment.
- `/clock` appears when the ROS2 bridge is active.
- `/clock` produces a sample.
- `/chassis/odom` produces a `nav_msgs/msg/Odometry` sample.
- `/tf` produces a `tf2_msgs/msg/TFMessage` sample.

## Smoke `/cmd_vel`

After the topic probe succeeds, run the command smoke from the same Launchable
checkout and Compose-managed ROS2 sidecar:

```sh
cd ~/isaac-launchable/isaac-lab
docker compose --profile probe run --rm ros2-probe bash -lc 'source /opt/ros/humble/setup.bash && bash /roboops/sim/isaac-sim/scripts/send-cmd-vel-smoke.sh'
```

Expected command evidence:

- `/cmd_vel` prints topic info with the Isaac subscriber present.
- `/chassis/odom` produces one sample before movement.
- Forward and turn commands visibly move the Nova Carter robot.
- The final zero-velocity command stops the robot.
- `/chassis/odom` produces one sample after movement.

## Validated First Run

The first Brev run reached topic discovery but not sample extraction:

- `/viewer` rendered Isaac Sim.
- Nova Carter ROS and warehouse scenes loaded.
- ROS2 Humble on the Brev host discovered `/clock`, `/tf`, `/chassis/odom`,
  `/cmd_vel`, lidar, camera, and IMU topics.
- `ros2 topic info` showed publishers.
- `ros2 topic echo` and `ros2 topic hz` from the Brev host did not receive
  samples.

The second run succeeded after launching Isaac and the sidecar probe with the
same Fast DDS UDP profile. The first telemetry adapter should start from
`/chassis/odom`, with `/tf` as fallback.

## Telemetry Mapping

Use the first available pose source to build a minimal telemetry heartbeat:

| `robot.telemetry.v1` field | First smoke source |
| --- | --- |
| `observedAt` | `/clock` or edge wall time |
| `pose.x` | `/chassis/odom.pose.pose.position.x` |
| `pose.y` | `/chassis/odom.pose.pose.position.y` |
| `pose.theta` | yaw derived from `/chassis/odom.pose.pose.orientation` |
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
- `/cmd_vel` smoke records before/after `/chassis/odom` samples and visible
  robot movement.
- Edge adapter emits a valid `edge.telemetry` message.
- Fleet Platform accepts the telemetry without protocol changes.
- Operator UI shows fresh telemetry and a robot pose update.

## Case Study Evidence

Capture:

- screenshot of Brev Launchable running;
- screenshot of Isaac Sim viewer;
- terminal output from `probe-ros2-topics.sh`;
- terminal output from `send-cmd-vel-smoke.sh`;
- one sample `edge.telemetry` JSON payload;
- Operator UI screenshot showing fresh telemetry/map movement.
