#!/usr/bin/env bash
set -euo pipefail

# Prints the ROS2 graph evidence needed before wiring the RoboOps edge adapter.
timeout_seconds="${ROS2_PROBE_TIMEOUT_SECONDS:-3}"
pose_candidates="${ROS2_POSE_TOPIC_CANDIDATES:-/chassis/odom /tf /odom /robot/pose /pose}"

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Missing required command: ${name}" >&2
    echo "Open the Isaac Launchable VS Code terminal and ensure ROS2 is sourced." >&2
    exit 1
  fi
}

topic_exists() {
  local topic="$1"
  ros2 topic list | grep -Fx -- "$topic" >/dev/null 2>&1
}

print_topic_info() {
  local topic="$1"
  echo
  echo "== ${topic} =="
  ros2 topic info "$topic" || true
  echo "-- sample (${timeout_seconds}s timeout) --"
  timeout "${timeout_seconds}" ros2 topic echo --once "$topic" || true
}

require_command ros2
require_command timeout

echo "ROS2 distribution: ${ROS_DISTRO:-unknown}"
echo
echo "== topics =="
ros2 topic list

if topic_exists "/clock"; then
  print_topic_info "/clock"
else
  echo
  echo "Missing /clock. Start Isaac Sim and confirm the ROS2 bridge is active."
fi

echo
echo "== pose topic candidates =="
found_pose_topic="false"
for topic in ${pose_candidates}; do
  if topic_exists "$topic"; then
    found_pose_topic="true"
    print_topic_info "$topic"
  else
    echo "not found: ${topic}"
  fi
done

if [ "${found_pose_topic}" != "true" ]; then
  cat <<'EOF'

No default pose candidate was found.
Inspect the full topic list above, then rerun with:

  ROS2_POSE_TOPIC_CANDIDATES="/your/pose/topic /another/topic" \
    sim/isaac-sim/scripts/probe-ros2-topics.sh
EOF
fi
