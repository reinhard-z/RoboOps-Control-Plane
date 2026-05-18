# Isaac Sim Robotics Smoke Path

This folder captures the preferred robotics simulation path for RoboOps. The
hosted portfolio demo still uses `apps/cloud-edge-simulator`; Isaac Sim is for
a local or remote robotics smoke test that proves a richer simulator can feed
the same edge contract.

## Runtime Target

Do not plan a native Isaac Sim install on the project Mac. NVIDIA's current
requirements target Ubuntu 22.04/24.04 or Windows 10/11 on x86_64 with an RTX
GPU. The aarch64 build is limited to NVIDIA DGX Spark-class hardware, and the
container path is Linux-only.

Recommended project setup:

```text
Mac developer machine
-> Fleet Platform, Operator UI, repo development

Remote RTX Linux workstation or cloud VM
-> Isaac Sim, ROS2 bridge, robot scene, edge adapter
```

Official references:

- https://docs.isaacsim.omniverse.nvidia.com/5.1.0/installation/requirements.html
- https://docs.isaacsim.omniverse.nvidia.com/5.1.0/installation/install_container.html
- https://docs.isaacsim.omniverse.nvidia.com/5.1.0/installation/install_ros.html

## Cloud Choice

Use NVIDIA Brev / Isaac Launchable first. The goal of this project stage is to
prove the simulator-to-edge telemetry path, not to operate a permanent GPU
platform. A Launchable gives the shortest path to an RTX instance with the
Isaac stack already shaped for experimentation.

Move to self-managed AWS only after the edge adapter has a working smoke
scenario and there is a concrete need for AWS ownership, such as VPC placement,
custom IAM, repeatable Terraform, GHCR/ECR integration, CI-triggered simulation,
or longer-running scheduled tests.

| Option | Use when | Tradeoff |
| --- | --- | --- |
| Isaac Launchable on NVIDIA Brev | First smoke test, demo recording, quick iteration | Fastest start, less infrastructure control |
| Self-managed AWS EC2 | Repeatable infra, security controls, CI, project-specific networking | More setup: GPU quota, drivers, container/runtime, remote desktop, cleanup |

Do not make Isaac Sim part of the always-on public demo. Keep the public demo on
`apps/cloud-edge-simulator`; run Isaac on demand for robotics evidence and
recordings.

Cloud references:

- https://docs.nvidia.com/brev/concepts/launchables
- https://docs.isaacsim.omniverse.nvidia.com/6.0.0/installation/install_advanced_cloud_setup_launchable.html
- https://github.com/isaac-sim/isaac-launchable
- https://github.com/isaac-sim/isaac-launchable/blob/main/isaac-lab/vscode/README.md
- https://developer.nvidia.com/isaac-sim

## Launchable Template Notes

Use `isaac-sim/isaac-launchable` as the upstream template reference, not as a
vendored dependency. It packages the workflow we want for the first robotics
smoke test:

- browser-based VS Code for commands and development;
- browser-based Isaac Sim streaming at `/viewer`;
- Docker Compose-managed services for VS Code, Isaac Lab, Isaac Sim, and the
  web viewer;
- Brev secure link on port `80`;
- streaming ports `1024`, `47998`, and `49100`;
- Isaac Sim `5.1` and Isaac Lab `2.3` in the current template.

The template's setup shape is simple:

```sh
git clone https://github.com/isaac-sim/isaac-launchable
cd isaac-launchable/isaac-lab
docker compose up -d
```

After the containers are ready, open the browser VS Code terminal and start the
streamed Isaac Sim app:

```sh
ACCEPT_EULA=y /isaac-sim/runheadless.sh
```

If you need an Isaac Lab tutorial scene instead, run it from the same browser VS
Code terminal:

```sh
cd /workspace/isaaclab
./isaaclab.sh -p scripts/tutorials/00_sim/create_empty.py --livestream 2
```

The RoboOps repo should live beside the launchable repo on the Brev host:

```text
/home/ubuntu/isaac-launchable
/home/ubuntu/RoboOps-Control-Plane
```

Inside the `vscode` container, Isaac Lab is available at `/workspace/isaaclab`.

Keep RoboOps-specific setup, probes, scenario notes, and telemetry adapters in
this repository under `sim/isaac-sim`. Do not copy NVIDIA container files,
streaming client code, cached assets, generated datasets, or credentials into
this monorepo.

## Repo Scaffold

Use these files when creating or running the first Brev environment:

| Path | Purpose |
| --- | --- |
| `launchable/setup.sh` | Clones/starts the upstream Isaac Launchable beside the RoboOps checkout |
| `launchable/setup-process.md` | Records Brev CLI, browser access, and first remote validation steps |
| `launchable/environment.md` | Records expected compute, workspace layout, and supported environment variables |
| `launchable/ports.md` | Lists secure-link and streaming ports for the Launchable |
| `launchable/sidecar-probe.md` | Defines the next bounded spike for sample extraction near Isaac |
| `scenarios/telemetry-smoke.md` | Step-by-step first telemetry smoke scenario |
| `fixtures/platform-command.json` | Local `platform.command` fixture for ack validation |
| `fixtures/robot-telemetry.json` | Local `robot.telemetry.v1` fixture for dry-run validation |
| `scripts/probe-ros2-topics.sh` | Captures ROS2 topic evidence before wiring the edge adapter |
| `scripts/run-ros2-sidecar-probe.sh` | Runs the probe in a ROS2 sidecar sharing the Isaac container network |

## Why Isaac Sim

Isaac Sim is a good fit when the smoke scenario should show realistic robot
assets, camera/depth/lidar/IMU streams, synthetic data generation, or a digital
twin-style warehouse.

## ROS2 Bridge Shape

Isaac Sim provides a ROS2 bridge and supports ROS2 Humble and Jazzy. The tested
Brev Launchable runs Isaac in a Noble container but exposes host SSH on Ubuntu
22.04 Jammy. Use Humble CLI tools on the Jammy host for first topic inspection;
keep Jazzy as the longer-term adapter target when the runtime host is Ubuntu
24.04.

The first adapter should consume only common ROS2 messages:

| Need | Candidate source |
| --- | --- |
| Sim time | `/clock` |
| Robot pose | `/chassis/odom`, with `/tf` fallback |
| Robot command input | Nav2 action, velocity topic, or a project-specific command adapter |
| Basic health | Diagnostics, watchdog state, or adapter policy |
| Battery | Battery plugin, diagnostic topic, or configured fallback |

Camera, depth, lidar, radar, IMU, joint states, semantic labels, and synthetic
datasets are valuable locally, but they should not be sent to Fleet Platform
until the cloud protocol has explicit fields for them.

## Validated State

The first Brev run validated:

- `roboops-isaac-smoke-02` launched on an AWS `g6e.4xlarge` with an NVIDIA L40S.
- Browser VS Code opened through the Brev Launchable.
- Isaac Sim streamed through `/viewer`.
- `ACCEPT_EULA=y /isaac-sim/runheadless.sh` starts the streamed Isaac app from
  the browser VS Code terminal.
- Nova Carter ROS and warehouse scenes loaded in Isaac Sim.
- ROS2 Humble CLI installs on the Brev SSH host.
- ROS2 discovery from the Brev host sees Isaac topics including `/clock`, `/tf`,
  `/chassis/odom`, `/cmd_vel`, lidar, camera, and IMU topics.

The first run did not complete sample subscription from the Brev host. The
second run succeeded with a Compose-managed ROS2 sidecar after both Isaac and the
probe used the same Fast DDS UDP profile. The probe received samples from
`/clock`, `/chassis/odom`, and `/tf`.

Start the first adapter from `/chassis/odom`; keep `/tf` as a fallback pose
source. Avoid spending more time on ad hoc host-side DDS tuning.

## RoboOps Contract Boundary

Fleet Platform still receives the same outbound WebSocket messages from the
robot-near edge runtime:

```text
edge.hello
edge.command_ack
edge.telemetry
edge.reconnect_handshake
```

The `edge.telemetry` payload remains `robot.telemetry.v1`:

| Field | Isaac Sim / edge source |
| --- | --- |
| `schemaVersion` | Constant: `robot.telemetry.v1` |
| `eventId` | Edge-agent generated id |
| `robotId` | Edge-agent configuration |
| `observedAt` | Sim time or wall-clock observation time |
| `receivedAt` | Edge-agent send time |
| `pose.x` | Robot pose projected into the map frame |
| `pose.y` | Robot pose projected into the map frame |
| `pose.theta` | Yaw derived from robot orientation |
| `batteryPercent` | Battery source or fallback policy |
| `health` | `OK`, `WARN`, `ERROR`, or `ESTOP` from diagnostics/policy |
| `connectionState` | Edge-agent freshness/connectivity policy |
| `currentMissionId` | Active mission tracked by the edge, when present |
| `lastAcknowledgedCommandId` | Last acknowledged command, when present |
| `lastSeenCommandSequence` | Highest command sequence processed by the edge |
| `edgeAgentVersion` | Edge-agent build/configuration |

## First Smoke Scenario

1. Run Isaac Sim on an RTX Linux host or cloud VM.
2. Enable the ROS2 bridge.
3. Load one mobile robot scene and publish `/clock` plus a pose source.
4. Run the probe or edge adapter inside the Isaac runtime container or a
   supported ROS2 sidecar.
5. Convert pose and simple health into `robot.telemetry.v1`.
6. Send telemetry to a Fleet Platform running locally or in the hosted stack.
7. Verify Operator UI map movement, telemetry freshness, stale handling, and
   reconnect reconciliation without changing the cloud contract.
8. Receive `platform.command` messages over the same edge socket and return
   `edge.command_ack` responses.
