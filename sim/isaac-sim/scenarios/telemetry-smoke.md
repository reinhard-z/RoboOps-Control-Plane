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

## Emit One Telemetry Payload

After the topic probe succeeds and the Nova Carter ROS scene is playing, emit a
single `robot.telemetry.v1` JSON payload from `/chassis/odom`:

```sh
cd ~/isaac-launchable/isaac-lab
docker compose --profile probe run --rm ros2-probe bash -lc 'source /opt/ros/humble/setup.bash && bash /roboops/sim/isaac-sim/scripts/emit-odom-telemetry-json.sh'
```

Expected telemetry evidence:

- stdout is one JSON object with `schemaVersion: "robot.telemetry.v1"`;
- `observedAt` comes from Isaac `/clock`, formatted as an ISO timestamp;
- `receivedAt` is the sidecar wall-clock receive time;
- `pose.x` and `pose.y` come from `/chassis/odom.pose.pose.position`;
- `pose.theta` is yaw derived from `/chassis/odom.pose.pose.orientation`;
- `batteryPercent`, `health`, `connectionState`, and `edgeAgentVersion` use
  the local smoke-test fallback values.

## Send Live Telemetry To Fleet Platform

After the one-shot payload is valid, run the edge sender from the same ROS2
sidecar. Set `FLEET_PLATFORM_URL` to the Fleet Platform HTTP base URL reachable
from inside the sidecar; the sender converts it to
`/edge/connect?robotId=<id>` and sends the existing `edge.telemetry` wrapper.
Replace `fleet-platform.example` in the command below with that reachable host.

For a stock local Operator UI, use `robot-a` so the default screen tracks the
Isaac pose:

```sh
cd ~/isaac-launchable/isaac-lab
docker compose --profile probe run --rm ros2-probe bash -lc 'source /opt/ros/humble/setup.bash && FLEET_PLATFORM_URL=http://fleet-platform.example:4010 ISAAC_EDGE_ROBOT_ID=robot-a ISAAC_EDGE_HEARTBEAT_SECONDS=1 bash /roboops/sim/isaac-sim/scripts/send-odom-telemetry-edge.sh'
```

When Fleet Platform runs on the Mac and Isaac runs in Brev, expose the Mac
Fleet Platform port through a temporary outbound tunnel such as ngrok:

```sh
ngrok http 4010
```

Use the printed `https://...ngrok-free...` base URL without `/health/live` or a
port suffix. Validate the tunnel from the Brev sidecar before starting the
sender:

```sh
cd ~/isaac-launchable/isaac-lab
docker compose --profile probe run --rm ros2-probe bash -lc 'curl -i -m 10 -H "ngrok-skip-browser-warning: true" https://<ngrok-host>/health/live'
```

Then start the sender with the same base URL. The `/cmd_vel` command shim is
enabled by default; accepted Fleet Platform commands will now publish local
Twist steps while telemetry continues streaming:

```sh
cd ~/isaac-launchable/isaac-lab
docker compose --profile probe run --rm ros2-probe bash -lc 'source /opt/ros/humble/setup.bash && FLEET_PLATFORM_URL=https://<ngrok-host> ISAAC_EDGE_ROBOT_ID=robot-a ISAAC_EDGE_HEARTBEAT_SECONDS=1 bash /roboops/sim/isaac-sim/scripts/send-odom-telemetry-edge.sh'
```

When Fleet Platform is hosted on AWS with the Fargate runbook, use the hosted
HTTPS base URL instead of the ngrok URL:

If this is a fresh Brev Launchable, install the RoboOps sidecar override first.
The upstream Launchable does not include `ros2-probe` by default:

```sh
cd ~
[ -d RoboOps-Control-Plane/.git ] || git clone https://github.com/reinhard-z/RoboOps-Control-Plane.git RoboOps-Control-Plane
bash ~/RoboOps-Control-Plane/sim/isaac-sim/launchable/configure-ros2-probe-sidecar.sh
```

```sh
cd ~/isaac-launchable/isaac-lab
docker compose --profile probe run --rm ros2-probe bash -lc 'curl -fsS -m 10 https://<hosted-fleet-platform-host>/health/live'
```

```sh
cd ~/isaac-launchable/isaac-lab
docker compose --profile probe run --rm ros2-probe bash -lc 'source /opt/ros/humble/setup.bash && FLEET_PLATFORM_URL=https://<hosted-fleet-platform-host> ISAAC_EDGE_ROBOT_ID=robot-a ISAAC_EDGE_HEARTBEAT_SECONDS=1 bash /roboops/sim/isaac-sim/scripts/send-odom-telemetry-edge.sh'
```

Use dry-run first when checking the edge frame without opening a WebSocket:

```sh
cd ~/isaac-launchable/isaac-lab
docker compose --profile probe run --rm ros2-probe bash -lc 'source /opt/ros/humble/setup.bash && ISAAC_EDGE_ROBOT_ID=robot-a bash /roboops/sim/isaac-sim/scripts/send-odom-telemetry-edge.sh --dry-run'
```

Use the command fixture when checking the ack path without Isaac or a live Fleet
Platform:

```sh
bash sim/isaac-sim/scripts/send-odom-telemetry-edge.sh --command-fixture sim/isaac-sim/fixtures/platform-command.json
```

Use `--print-motion-plan` to validate the command-to-`/cmd_vel` planning without
ROS2:

```sh
bash sim/isaac-sim/scripts/send-odom-telemetry-edge.sh --command-fixture sim/isaac-sim/fixtures/platform-command.json --print-motion-plan --motion-plan-pose 0,0,0
bash sim/isaac-sim/scripts/send-odom-telemetry-edge.sh --command-fixture sim/isaac-sim/fixtures/platform-cancel-command.json --print-motion-plan
```

Expected edge evidence:

- stdout in dry-run mode is one `edge.telemetry` JSON object;
- stdout in command fixture mode is one valid `edge.command_ack` JSON object;
- stdout with `--print-motion-plan` includes the ack plus a bounded motion plan;
- live mode logs `connected to Fleet Platform edge socket`;
- live mode logs one `sent edge.telemetry eventId=...` line per heartbeat;
- live mode logs `sent edge.command_ack commandId=... status=...` after a
  valid `platform.command`;
- live mode logs `started /cmd_vel motion plan` after an accepted `GO_TO_POSE`
  and `publishing /cmd_vel` for each Twist step;
- ngrok mode uses `wss://<ngrok-host>/edge/connect?robotId=robot-a` in the
  connected log line;
- Fleet Platform accepts the frame without a protocol change;
- Operator UI shows fresh telemetry and a moving pose after the accepted
  command automatically moves Nova Carter.

The Isaac sender acknowledges `GO_TO_POSE` and `CANCEL_MISSION` commands and
rejects unsupported command types with an explicit ack. Accepted `GO_TO_POSE`
commands publish a simple turn/forward/yaw/stop `/cmd_vel` sequence based on the
latest odometry pose, capped for smoke-test visibility. Accepted
`CANCEL_MISSION` commands stop any active plan and publish zero velocity. The
ack still means received/accepted by the edge adapter, not that Nova Carter
reached the target.

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
| `observedAt` | `/clock`, formatted as an ISO timestamp |
| `receivedAt` | edge wall time |
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
- Accepted Fleet Platform `GO_TO_POSE` commands produce automatic `/cmd_vel`
  movement, and accepted `CANCEL_MISSION` commands publish zero velocity.
- Operator UI shows fresh telemetry and a robot pose update.

## Case Study Evidence

Capture:

- screenshot of Brev Launchable running;
- screenshot of Isaac Sim viewer;
- terminal output from `probe-ros2-topics.sh`;
- terminal output from `send-cmd-vel-smoke.sh`;
- one sample `edge.telemetry` JSON payload;
- Operator UI screenshot showing fresh telemetry/map movement.
