#!/usr/bin/env bash
set -euo pipefail

# Runs the RoboOps ROS2 topic probe inside a ROS2 sidecar near Isaac Sim.
container_name="${ISAAC_VSCODE_CONTAINER:-vscode}"
image="${ROS2_SIDECAR_IMAGE:-osrf/ros:humble-desktop}"
repo_dir="${ROBOOPS_DIR:-$PWD}"
probe_path="/roboops/sim/isaac-sim/scripts/probe-ros2-topics.sh"

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Missing required command: ${name}" >&2
    exit 1
  fi
}

require_command docker

if [ ! -f "${repo_dir}/sim/isaac-sim/scripts/probe-ros2-topics.sh" ]; then
  echo "RoboOps repo not found at ${repo_dir}" >&2
  echo "Run from the repo root or set ROBOOPS_DIR." >&2
  exit 1
fi

if ! docker inspect "${container_name}" >/dev/null 2>&1; then
  echo "Isaac Launchable container not found: ${container_name}" >&2
  echo "Run 'docker ps' on the Brev host and set ISAAC_VSCODE_CONTAINER if needed." >&2
  exit 1
fi

cat <<EOF
Running ROS2 probe sidecar.

Container: ${container_name}
Image:     ${image}
Repo:      ${repo_dir}

If this sees topics but no samples, the next step is a Compose-managed sidecar
or an Isaac/Python-side probe inside the existing vscode container.
EOF

docker run --rm -it \
  --network "container:${container_name}" \
  -v "${repo_dir}:/roboops:ro" \
  "${image}" \
  bash -lc "source /opt/ros/humble/setup.bash && ${probe_path}"
