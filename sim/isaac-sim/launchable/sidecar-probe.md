# Isaac ROS2 Sidecar Probe

This is the next bounded spike after the first Brev run. The first run proved
that the Brev host can discover Isaac ROS2 topics, but host-side `ros2 topic
echo` and `ros2 topic hz` did not receive samples. Do not repeat that path.

## Goal

Run the RoboOps ROS2 probe close to Isaac Sim, either:

1. inside the Launchable's browser VS Code / `vscode` container; or
2. in a Compose-managed ROS2 sidecar that shares the Launchable network settings.

The goal is one sample from `/clock` and one pose source, preferably
`/chassis/odom`, with `/tf` as fallback.

## Fast Next Session

1. Start a fresh Isaac Launchable.
2. Open browser VS Code.
3. Start Isaac Sim:

```sh
ACCEPT_EULA=y /isaac-sim/runheadless.sh
```

4. Open `/viewer`.
5. Load the Nova Carter ROS scene.
6. Confirm topic discovery from the Brev host if needed:

```sh
source /opt/ros/humble/setup.bash
ros2 topic list | sort
```

7. Run the sidecar wrapper from the Brev host:

```sh
cd ~/RoboOps-Control-Plane
sim/isaac-sim/scripts/run-ros2-sidecar-probe.sh
```

## Why Sidecar

The Launchable has two relevant runtime contexts:

| Context | What worked | What failed |
| --- | --- | --- |
| Brev host | ROS2 Humble CLI discovered topics and publisher endpoints | `echo`/`hz` received no samples |
| Browser VS Code container | Isaac Sim and the bridge run here | No package install path because there is no `sudo` |

A sidecar gives us a clean ROS2 CLI container colocated with the Launchable
network, without mutating NVIDIA's `vscode` container.

## Expected Evidence

Capture:

```sh
docker ps
docker inspect vscode --format '{{.HostConfig.NetworkMode}} {{.HostConfig.IpcMode}}'
sim/isaac-sim/scripts/run-ros2-sidecar-probe.sh
```

The spike succeeds when the probe prints a sample from `/clock` and either
`/chassis/odom` or `/tf`.

## If The Wrapper Fails

If Docker rejects IPC sharing with:

```text
non-shareable IPC
```

do not continue with ad hoc Docker flags. Instead, add a sidecar service to the
Launchable Compose file or run an Isaac/Python-side probe inside the existing
`vscode` container.
