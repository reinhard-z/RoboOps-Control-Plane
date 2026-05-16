# ROS2 Edge Agent C++ Skeleton

This package is the first ROS2 Jazzy-facing edge agent scaffold for RoboOps.
It demonstrates the cloud-to-edge boundary without changing the existing Fleet
Platform protocol:

- the agent is robot-near and is expected to connect outbound to Fleet Platform;
- Fleet Platform remains the cloud control-plane boundary at
  `/edge/connect?robotId=...`;
- no direct cloud-to-ROS2/DDS bridge is started;
- no navigation, SLAM, Gazebo scenario, Kubernetes rollout, or hosted robot
  deployment is implemented in this slice.

The TypeScript package `packages/fleet-protocol` remains the source of truth
for protocol versions, fixtures, and JSON Schemas, including
`packages/fleet-protocol/src/fixtures.ts`. The C++ helpers in
`include/roboops_ros2_edge_agent/protocol.hpp` mirror the current hello,
command acknowledgement, telemetry, and reconnect handshake wire shapes so the
ROS2 agent can evolve toward the same contract as `apps/cloud-edge-simulator`
without adding cross-language code generation yet.

## Configuration

The executable reads these environment variables, then allows ROS parameters
with the same lower-case names to override them:

| Environment variable | ROS parameter | Default |
| --- | --- | --- |
| `FLEET_PLATFORM_URL` | `fleet_platform_url` | `http://127.0.0.1:4010` |
| `ROBOT_ID` | `robot_id` | `robot-a` |
| `EDGE_AGENT_VERSION` | `edge_agent_version` | `ros2-edge-agent-cpp-0.1.0` |

`FLEET_PLATFORM_URL` must be an `http://` or `https://` Fleet Platform base URL.
The skeleton derives the outbound WebSocket URL as:

```text
ws(s)://<fleet-platform-origin>/edge/connect?robotId=<url-encoded robot id>
```

Use `config/edge-agent.example.env` as a local reference only. Do not commit
environment-specific robot credentials or secrets.

## Build With ROS2 Jazzy

Prerequisites:

- ROS2 Jazzy with `rclcpp`, `ament_cmake`, `ament_cmake_gtest`, and `launch_ros`
- `colcon`
- a C++17 compiler

From the repository root:

```sh
source /opt/ros/jazzy/setup.bash

ROS2_BUILD_DIR=/tmp/roboops-ros2-edge-agent-build
colcon --log-base "$ROS2_BUILD_DIR/log" build \
  --base-paths edge/ros2-edge-agent-cpp \
  --build-base "$ROS2_BUILD_DIR/build" \
  --install-base "$ROS2_BUILD_DIR/install" \
  --packages-select roboops_ros2_edge_agent

source "$ROS2_BUILD_DIR/install/setup.bash"
```

If ROS2 is not installed on the host, run the same build/test path in the
Jazzy container used by CI:

```sh
sh edge/ros2-edge-agent-cpp/scripts/run-ros2-jazzy-container-check.sh
```

Run the skeleton:

```sh
FLEET_PLATFORM_URL=http://127.0.0.1:4010 \
ROBOT_ID=robot-a \
EDGE_AGENT_VERSION=ros2-edge-agent-cpp-0.1.0 \
ros2 run roboops_ros2_edge_agent roboops_ros2_edge_agent
```

Or with ROS parameters:

```sh
ros2 run roboops_ros2_edge_agent roboops_ros2_edge_agent --ros-args \
  -p fleet_platform_url:=http://127.0.0.1:4010 \
  -p robot_id:=robot-a \
  -p edge_agent_version:=ros2-edge-agent-cpp-0.1.0
```

The executable currently logs the intended outbound connection URL and a sample
`edge.hello` message, then exits. Real WebSocket transport and ROS2 topic/action
adapters are intentionally out of scope for this slice.

## Checks

When ROS2 is installed:

```sh
source /opt/ros/jazzy/setup.bash

ROS2_BUILD_DIR=/tmp/roboops-ros2-edge-agent-build
colcon --log-base "$ROS2_BUILD_DIR/log" test \
  --base-paths edge/ros2-edge-agent-cpp \
  --build-base "$ROS2_BUILD_DIR/build" \
  --install-base "$ROS2_BUILD_DIR/install" \
  --packages-select roboops_ros2_edge_agent
```

Without ROS2, run the dependency-light smoke check for config parsing and
message construction:

```sh
sh edge/ros2-edge-agent-cpp/scripts/run-static-smoke.sh
```

The path-scoped GitHub Actions workflow in
`.github/workflows/ros2-edge-agent.yml` runs the Jazzy container build when this
package or that workflow changes.

## Current Limitations

- No WebSocket client is implemented yet.
- No ROS2 publishers, subscribers, actions, navigation, SLAM, or Gazebo scenario
  are implemented yet.
- No cloud process talks directly to ROS2 or DDS.
- Protocol parsing from live platform commands is represented by typed C++
  structures, but a real JSON parser is intentionally deferred until transport
  is added.
- `packages/fleet-protocol` remains the authoritative cloud contract; update
  the C++ mirror only after the TypeScript contract changes.
