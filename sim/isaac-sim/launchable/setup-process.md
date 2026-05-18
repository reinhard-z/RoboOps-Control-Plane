# Isaac Launchable Setup Process

This runbook records the first Brev setup path for the RoboOps Isaac Sim smoke
test. Use the browser route when local developer tooling is broken or missing.

## Create The Launchable

1. In Brev, deploy the upstream Isaac Launchable template.
2. Name the instance `roboops-isaac-smoke`.
3. Wait until the instance is running and the setup script is no longer
   `Waiting` or `Building`.
4. Keep the instance stopped when not actively using it; GPU time is billed by
   the hour.

## Browser Access

The simplest path is the Brev browser environment:

1. Click **View Launchable** in Brev.
2. Open the browser VS Code environment.
3. Use its integrated terminal for Docker, Isaac Sim, ROS2, and RoboOps probes.

## Brev CLI Access

Install and authenticate the Brev CLI on the Mac:

```sh
brew install brevdev/homebrew-brev/brev
brev login
```

Open the Launchable in the local editor:

```sh
brev open roboops-isaac-smoke code
```

If `brev` is not found, install the CLI or use the browser access path.

If `code` is not found, add the VS Code CLI to the shell path for the current
terminal:

```sh
export PATH="/Applications/Visual Studio Code.app/Contents/Resources/app/bin:$PATH"
```

To make that persistent for `zsh`:

```sh
printf '\nexport PATH="/Applications/Visual Studio Code.app/Contents/Resources/app/bin:$PATH"\n' >> ~/.zshrc
source ~/.zshrc
```

Then retry:

```sh
brev open roboops-isaac-smoke code
```

## First Remote Checks

Run these inside the Brev browser VS Code terminal or the local editor terminal
connected through Brev:

```sh
docker ps
cd ~/isaac-launchable/isaac-lab
docker compose ps
```

The browser VS Code terminal starts inside the Launchable's `vscode` container.
From that terminal, verify the Isaac Sim mount and start the streamed app:

```sh
ls /isaac-sim
ACCEPT_EULA=y /isaac-sim/runheadless.sh
```

If you are connected to the Brev host over SSH instead of browser VS Code, enter
the `vscode` container first:

```sh
cd ~/isaac-launchable/isaac-lab
docker compose exec vscode bash
```

If you need an Isaac Lab tutorial scene instead of the direct Isaac Sim app, run
this inside the `vscode` container:

```sh
cd /workspace/isaaclab
./isaaclab.sh -p scripts/tutorials/00_sim/create_empty.py --livestream 2
```

Successful startup can include:

```text
Isaac Sim Full Streaming App is loaded.
```

Open a second browser tab with the same Brev secure URL and change the path to:

```text
/viewer
```

## RoboOps Checkout

If RoboOps is not already present on the Brev instance:

```sh
cd ~
git clone https://github.com/reinhard-z/RoboOps-Control-Plane.git RoboOps-Control-Plane
cd RoboOps-Control-Plane
```

If the clone fails with `Permission denied` under
`/home/ubuntu/RoboOps-Control-Plane/.git`, check whether a previous setup left a
root-owned placeholder directory:

```sh
ls -ld ~/RoboOps-Control-Plane
ls -ld ~/RoboOps-Control-Plane/.git
```

If the directory is root-owned and has no `.git`, remove it and clone again:

```sh
sudo rm -rf ~/RoboOps-Control-Plane
git clone https://github.com/reinhard-z/RoboOps-Control-Plane.git ~/RoboOps-Control-Plane
```

Keep RoboOps as a sibling checkout of `isaac-launchable`. Do not clone it under
`/workspace`, which belongs to the Isaac container workspace.

The working ROS2 sample probe runs from the Launchable compose project:

```sh
cd ~/isaac-launchable/isaac-lab
docker compose --profile probe run --rm ros2-probe
```

## ROS2 CLI On The Brev Host

The browser VS Code container has Isaac Sim but no `sudo`, so do not install
packages there. Install ROS2 CLI tools on the Brev host reached with:

```sh
brev shell roboops-isaac-smoke-02
```

The tested host is Ubuntu 22.04 Jammy, so use ROS2 Humble, not Jazzy:

```sh
sudo rm -f /etc/apt/sources.list.d/ros2.list
sudo apt update
sudo apt install -y curl gnupg lsb-release software-properties-common
sudo add-apt-repository -y universe
sudo curl -sSL https://raw.githubusercontent.com/ros/rosdistro/master/ros.key \
  -o /usr/share/keyrings/ros-archive-keyring.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/ros-archive-keyring.gpg] http://packages.ros.org/ros2/ubuntu jammy main" \
  | sudo tee /etc/apt/sources.list.d/ros2.list >/dev/null

sudo apt update
sudo apt install -y ros-humble-ros-base
source /opt/ros/humble/setup.bash
ros2 topic list | sort
```

If a previous attempt added the `noble` ROS2 repository, removing
`/etc/apt/sources.list.d/ros2.list` before adding the Jammy entry avoids the
Jazzy dependency conflict.

## Current Stop Point

The first run reached this state:

- Isaac Sim streamed successfully through `/viewer`.
- The Nova Carter ROS scene loaded.
- ROS2 Humble CLI on the Brev host could discover Isaac topics:
  `/clock`, `/tf`, `/chassis/odom`, `/cmd_vel`, lidar, camera, and IMU topics.
- `ros2 topic info` showed publishers for `/clock` and `/tf`.
- `ros2 topic echo` and `ros2 topic hz` from the Brev host did not receive
  samples.

Do not repeat the same host-side debugging. The second run succeeded after
launching Isaac and the Compose-managed `ros2-probe` sidecar with the same Fast
DDS UDP profile:

- `/clock` produced a `rosgraph_msgs/msg/Clock` sample.
- `/chassis/odom` produced a `nav_msgs/msg/Odometry` sample.
- `/tf` produced a `tf2_msgs/msg/TFMessage` sample.

See `sim/isaac-sim/launchable/sidecar-probe.md` for the working Compose
override and Fast DDS profile.

Capture the outputs from `docker compose ps`, the `/viewer` status, topic
discovery, and the first successful sample source. The first adapter should read
`/chassis/odom`, with `/tf` as fallback.
