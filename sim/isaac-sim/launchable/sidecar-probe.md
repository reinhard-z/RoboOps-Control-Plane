# Isaac ROS2 Sidecar Probe

This records the working ROS2 probe path after the first Brev run. The Brev
host and ad hoc `docker run` sidecars could discover Isaac ROS2 topics, but
`ros2 topic echo` and `ros2 topic hz` did not receive samples until Isaac and
the probe used the same Fast DDS UDP profile.

## Goal

Run the RoboOps ROS2 probe in a Compose-managed ROS2 sidecar beside Isaac Sim.
The goal is one sample from `/clock` and one pose source, preferably
`/chassis/odom`, with `/tf` as fallback.

## Fast Next Session

1. Start a fresh Isaac Launchable.
2. Open browser VS Code.
3. Add the Fast DDS/sidecar override from the "Working Compose Sidecar" section.
4. Recreate the Launchable services.
5. Start Isaac Sim from the browser VS Code terminal:

```sh
ACCEPT_EULA=y /isaac-sim/runheadless.sh
```

6. Open `/viewer`.
7. Load the Nova Carter ROS scene and press Play.
8. Run the Compose probe from the Brev host:

```sh
cd ~/isaac-launchable/isaac-lab
docker compose --profile probe run --rm ros2-probe
```

9. If the topic probe succeeds, run the repeatable `/cmd_vel` smoke from the
   same Compose sidecar:

```sh
docker compose --profile probe run --rm ros2-probe bash -lc 'source /opt/ros/humble/setup.bash && bash /roboops/sim/isaac-sim/scripts/send-cmd-vel-smoke.sh'
```

## Working Compose Sidecar

Create the Fast DDS UDP profile in the upstream Launchable checkout:

```sh
cd ~/isaac-launchable/isaac-lab

cat > roboops-fastdds.xml <<'EOF'
<?xml version="1.0" encoding="UTF-8" ?>
<profiles xmlns="http://www.eprosima.com/XMLSchemas/fastRTPS_Profiles">
  <transport_descriptors>
    <transport_descriptor>
      <transport_id>UdpTransport</transport_id>
      <type>UDPv4</type>
    </transport_descriptor>
  </transport_descriptors>
  <participant profile_name="udp_transport_profile" is_default_profile="true">
    <rtps>
      <userTransports>
        <transport_id>UdpTransport</transport_id>
      </userTransports>
      <useBuiltinTransports>false</useBuiltinTransports>
    </rtps>
  </participant>
</profiles>
EOF
```

Then create `docker-compose.override.yml` in the same directory:

```yaml
services:
  vscode:
    image: isaac-lab-vscode
    ipc: shareable
    volumes:
      - ./roboops-fastdds.xml:/etc/roboops/fastdds.xml:ro
    environment:
      RMW_IMPLEMENTATION: rmw_fastrtps_cpp
      FASTRTPS_DEFAULT_PROFILES_FILE: /etc/roboops/fastdds.xml

  nginx:
    image: isaac-lab-nginx

  ros2-probe:
    image: osrf/ros:humble-desktop
    profiles:
      - probe
    depends_on:
      - vscode
    network_mode: host
    ipc: service:vscode
    volumes:
      - /home/ubuntu/RoboOps-Control-Plane:/roboops:ro
      - ./roboops-fastdds.xml:/etc/roboops/fastdds.xml:ro
    environment:
      RMW_IMPLEMENTATION: rmw_fastrtps_cpp
      FASTRTPS_DEFAULT_PROFILES_FILE: /etc/roboops/fastdds.xml
      ROS2_POSE_TOPIC_CANDIDATES: "/chassis/odom /tf /odom /robot/pose /pose"
      ROS2_PROBE_TIMEOUT_SECONDS: "10"
    command: >
      bash -lc "source /opt/ros/humble/setup.bash &&
      bash /roboops/sim/isaac-sim/scripts/probe-ros2-topics.sh"
```

Keep the `vscode` and `nginx` image lines. The upstream Launchable compose file
expects the local override to supply those image names; removing them makes
Compose fail with `has neither an image nor a build context specified`.

Recreate the services after writing the override:

```sh
docker compose up -d --force-recreate
```

The sidecar does not need RoboOps scripts copied into the Isaac container. The
override mounts the Brev host checkout at `/home/ubuntu/RoboOps-Control-Plane`
as `/roboops` inside `ros2-probe`. Verify the mount after a fresh Launchable
setup:

```sh
docker compose --profile probe run --rm ros2-probe bash -lc 'ls -l /roboops/sim/isaac-sim/scripts'
```

## Why Sidecar

The Launchable has two relevant runtime contexts:

| Context | What worked | What failed |
| --- | --- | --- |
| Brev host | ROS2 Humble CLI discovered topics and publisher endpoints | `echo`/`hz` received no samples without the shared Fast DDS profile |
| Browser VS Code container | Isaac Sim and the bridge run here | No package install path because there is no `sudo` |
| Compose `ros2-probe` sidecar | Received `/clock`, `/chassis/odom`, and `/tf` samples | Requires the Fast DDS profile before Isaac starts |

A sidecar gives us a clean ROS2 CLI container colocated with the Launchable
network, without mutating NVIDIA's `vscode` container.

## Expected Evidence

Capture:

```sh
docker ps
docker inspect vscode --format '{{.HostConfig.NetworkMode}} {{.HostConfig.IpcMode}}'
docker compose --profile probe run --rm ros2-probe
```

The spike succeeds when the probe prints a sample from `/clock` and either
`/chassis/odom` or `/tf`.

## Repeatable Command Smoke

Run this only after the Nova Carter ROS scene is loaded and simulation Play is
active. The command smoke must use the Compose-managed `ros2-probe` sidecar so
Isaac and the probe share the Fast DDS UDP profile.

```sh
cd ~/isaac-launchable/isaac-lab
docker compose --profile probe run --rm ros2-probe bash -lc 'source /opt/ros/humble/setup.bash && bash /roboops/sim/isaac-sim/scripts/send-cmd-vel-smoke.sh'
```

The script prints `/cmd_vel` topic info, captures one `/chassis/odom` sample,
publishes forward motion, publishes a turn command, sends a final zero-velocity
stop, and captures a second `/chassis/odom` sample. The smoke passes when the
robot visibly moves and the before/after odometry samples are present.

The successful Brev run printed:

- `/clock` as `rosgraph_msgs/msg/Clock`;
- `/chassis/odom` as `nav_msgs/msg/Odometry`;
- `/tf` as `tf2_msgs/msg/TFMessage`.

The repeated `sequence size exceeds remaining buffer` warning did not block
sampling when YAML output followed it.

If `/cmd_vel` or `/chassis/odom` briefly appears missing even though the scene is
playing, rerun the check once after a short wait. Fresh `ros2-probe` containers
can start before Fast DDS discovery has fully converged.

## Edge Telemetry Sender Smoke

After `/clock` and `/chassis/odom` produce samples, dry-run the Isaac telemetry
sender from the same sidecar:

```sh
cd ~/isaac-launchable/isaac-lab
docker compose --profile probe run --rm ros2-probe bash -lc 'source /opt/ros/humble/setup.bash && ISAAC_EDGE_ROBOT_ID=robot-a bash /roboops/sim/isaac-sim/scripts/send-odom-telemetry-edge.sh --dry-run'
```

The dry-run passes when stdout is one `edge.telemetry` JSON object containing a
`robot.telemetry.v1` payload with changing `pose.x`, `pose.y`, or `pose.theta`
after `/cmd_vel` movement.

For a live Fleet Platform running on the Brev host, use the app's health routes
to verify it first:

```sh
curl http://127.0.0.1:4010/health/live
curl http://127.0.0.1:4010/health/ready
```

The app does not expose `/health`. Because the probe sidecar uses
`network_mode: host`, the live sender should use the host loopback URL:

```sh
docker compose --profile probe run --rm ros2-probe bash -lc 'source /opt/ros/humble/setup.bash && FLEET_PLATFORM_URL=http://127.0.0.1:4010 ISAAC_EDGE_ROBOT_ID=robot-a bash /roboops/sim/isaac-sim/scripts/send-odom-telemetry-edge.sh'
```

The live sender passes when it logs `connected to Fleet Platform edge socket`
and repeated `sent edge.telemetry eventId=...` lines. Confirm the platform
snapshot separately:

```sh
curl http://127.0.0.1:4010/robots/robot-a
```

## If The Probe Fails

If Docker rejects IPC sharing with:

```text
non-shareable IPC
```

do not continue with ad hoc Docker flags. Use the Compose-managed sidecar above
so `vscode` is created with `ipc: shareable`.

If the probe sees topics but receives no samples, verify `FASTRTPS_DEFAULT_PROFILES_FILE`
is set inside `vscode` before starting Isaac:

```sh
docker compose exec vscode bash
echo "$FASTRTPS_DEFAULT_PROFILES_FILE"
echo "$RMW_IMPLEMENTATION"
```

If `/clock` is missing, Isaac is usually not publishing the ROS graph yet. Check
that Isaac is running, the Nova Carter ROS scene is loaded, and simulation Play
is active before rerunning the probe:

```sh
docker compose exec vscode bash -lc 'pgrep -af "isaac|kit|runheadless" | head -20'
docker compose --profile probe run --rm ros2-probe bash -lc 'source /opt/ros/humble/setup.bash && ros2 topic list | sort'
```
