#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
repo_dir=$(CDPATH= cd -- "$package_dir/../.." && pwd)
image="${ROS2_DOCKER_IMAGE:-osrf/ros:jazzy-desktop}"
host_docker_config="${DOCKER_CONFIG:-$HOME/.docker}"
sanitized_docker_config=$(mktemp -d "${TMPDIR:-/tmp}/roboops-docker-config.XXXXXX")

cleanup() {
  rm -rf "$sanitized_docker_config"
}
trap cleanup EXIT INT TERM

# The default image is public. Use a sanitized Docker config so local credential
# helper settings do not break pulls in shells that lack Docker Desktop helpers.
current_context=$(docker context show 2>/dev/null || printf 'default')
if [ -d "$host_docker_config/contexts" ]; then
  cp -R "$host_docker_config/contexts" "$sanitized_docker_config/contexts"
fi
printf '{"currentContext":"%s"}\n' "$current_context" \
  > "$sanitized_docker_config/config.json"

DOCKER_CONFIG="$sanitized_docker_config" docker run --rm \
  -v "$repo_dir:/workspace:ro" \
  -w /workspace \
  "$image" \
  bash -lc '
    set -euo pipefail

    if ! command -v colcon >/dev/null 2>&1; then
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        python3-colcon-common-extensions
    fi

    set +u
    source /opt/ros/jazzy/setup.bash
    set -u

    ROS2_BUILD_DIR=/tmp/roboops-ros2-edge-agent-build
    rm -rf "$ROS2_BUILD_DIR"

    colcon --log-base "$ROS2_BUILD_DIR/log" build \
      --base-paths edge/ros2-edge-agent-cpp \
      --build-base "$ROS2_BUILD_DIR/build" \
      --install-base "$ROS2_BUILD_DIR/install" \
      --packages-select roboops_ros2_edge_agent \
      --event-handlers console_direct+

    colcon --log-base "$ROS2_BUILD_DIR/log" test \
      --base-paths edge/ros2-edge-agent-cpp \
      --build-base "$ROS2_BUILD_DIR/build" \
      --install-base "$ROS2_BUILD_DIR/install" \
      --packages-select roboops_ros2_edge_agent \
      --event-handlers console_direct+

    colcon --log-base "$ROS2_BUILD_DIR/log" test-result \
      --test-result-base "$ROS2_BUILD_DIR/build" \
      --verbose
  '
