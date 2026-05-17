#!/usr/bin/env bash
set -euo pipefail

# Sends a short, repeatable /cmd_vel sequence from the ROS2 probe sidecar.
odom_timeout_seconds="${CMD_VEL_SMOKE_ODOM_TIMEOUT_SECONDS:-10}"
forward_seconds="${CMD_VEL_SMOKE_FORWARD_SECONDS:-4}"
turn_seconds="${CMD_VEL_SMOKE_TURN_SECONDS:-4}"
stop_seconds="${CMD_VEL_SMOKE_STOP_SECONDS:-3}"
rate_hz="${CMD_VEL_SMOKE_RATE_HZ:-10}"
forward_linear_x="${CMD_VEL_SMOKE_FORWARD_LINEAR_X:-0.25}"
turn_angular_z="${CMD_VEL_SMOKE_TURN_ANGULAR_Z:-0.5}"
stop_sent="false"

# Verifies that the sidecar has the required CLI before sending commands.
require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Missing required command: ${name}" >&2
    echo "Run this inside the ROS2 sidecar after sourcing /opt/ros/humble/setup.bash." >&2
    exit 1
  fi
}

# Formats the Twist payload in the inline YAML accepted by ros2 topic pub.
twist_payload() {
  local linear_x="$1"
  local angular_z="$2"

  printf '{linear: {x: %s, y: 0.0, z: 0.0}, angular: {x: 0.0, y: 0.0, z: %s}}' \
    "${linear_x}" \
    "${angular_z}"
}

# Treats timeout's 124 exit as expected for bounded ros2 topic pub loops.
run_bounded_publish() {
  local seconds="$1"
  shift

  set +e
  timeout "${seconds}" "$@"
  local status="$?"
  set -e

  if [ "${status}" -ne 0 ] && [ "${status}" -ne 124 ]; then
    echo "Command failed with exit code ${status}: $*" >&2
    exit "${status}"
  fi
}

# Captures one odometry sample so before/after movement can be compared.
capture_odom_sample() {
  local label="$1"
  local status

  echo
  echo "== /chassis/odom ${label} =="
  set +e
  timeout "${odom_timeout_seconds}" ros2 topic echo --once /chassis/odom
  status="$?"
  set -e

  if [ "${status}" -ne 0 ]; then
    echo "No /chassis/odom sample captured for '${label}' within ${odom_timeout_seconds}s." >&2
    exit "${status}"
  fi
}

# Prints /cmd_vel metadata and fails early if Isaac is not subscribed.
require_cmd_vel_subscriber() {
  local info
  local subscription_count=""

  if ! info="$(ros2 topic info /cmd_vel 2>&1)"; then
    printf '%s\n' "${info}"
    echo "Missing /cmd_vel. Load the Nova Carter ROS scene and press Play." >&2
    exit 1
  fi

  printf '%s\n' "${info}"

  while IFS= read -r line; do
    case "${line}" in
      "Subscription count: "*)
        subscription_count="${line#Subscription count: }"
        ;;
    esac
  done <<<"${info}"

  if ! [[ "${subscription_count}" =~ ^[0-9]+$ ]]; then
    echo "Could not read /cmd_vel subscriber count from ros2 topic info." >&2
    exit 1
  fi

  if [ "${subscription_count}" -lt 1 ]; then
    echo "No /cmd_vel subscriber found. Load the Nova Carter ROS scene and press Play." >&2
    exit 1
  fi
}

# Publishes a Twist command long enough for Isaac's ROS bridge to consume it.
publish_twist_for() {
  local label="$1"
  local seconds="$2"
  local linear_x="$3"
  local angular_z="$4"

  echo
  echo "== ${label} (${seconds}s) =="
  run_bounded_publish \
    "${seconds}" \
    ros2 topic pub -r "${rate_hz}" /cmd_vel geometry_msgs/msg/Twist \
    "$(twist_payload "${linear_x}" "${angular_z}")"
}

# Sends a final zero command and is safe to call again from exit traps.
publish_stop() {
  if [ "${stop_sent}" = "true" ]; then
    return
  fi

  stop_sent="true"
  publish_twist_for "final stop" "${stop_seconds}" "0.0" "0.0"
}

require_command ros2
require_command timeout

echo "ROS2 distribution: ${ROS_DISTRO:-unknown}"
echo "Command rate: ${rate_hz} Hz"
echo
echo "== /cmd_vel info =="
require_cmd_vel_subscriber

capture_odom_sample "before movement"

trap 'publish_stop' EXIT
trap 'publish_stop; exit 130' INT
trap 'publish_stop; exit 143' TERM

publish_twist_for "forward command" "${forward_seconds}" "${forward_linear_x}" "0.0"
publish_twist_for "turn command" "${turn_seconds}" "0.0" "${turn_angular_z}"
publish_stop

capture_odom_sample "after movement"
