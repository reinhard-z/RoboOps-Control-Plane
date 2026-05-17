#!/usr/bin/env bash
set -euo pipefail

# Emits one robot.telemetry.v1 JSON payload from Isaac's /chassis/odom topic.

# Verifies that the sidecar can run the ROS2 Python subscriber.
require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Missing required command: ${name}" >&2
    echo "Run this inside the ROS2 sidecar after sourcing /opt/ros/humble/setup.bash." >&2
    exit 1
  fi
}

require_command python3

python3 - <<'PY'
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
import os
import sys
import time
import uuid

try:
    import rclpy
    from nav_msgs.msg import Odometry
    from rclpy.node import Node
    from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
except ImportError as exc:
    print(
        "Missing ROS2 Python modules. Source /opt/ros/humble/setup.bash inside the "
        "ros2-probe sidecar before running this script.",
        file=sys.stderr,
    )
    print(f"Import error: {exc}", file=sys.stderr)
    raise SystemExit(1)


BATTERY_PERCENT = 80
CONNECTION_STATE = "ONLINE"
EDGE_AGENT_VERSION = "local/dev"
HEALTH = "OK"
LAST_SEEN_COMMAND_SEQUENCE = 0
SCHEMA_VERSION = "robot.telemetry.v1"


@dataclass(frozen=True)
class EmitterConfig:
    """Runtime settings that are safe to vary between Isaac smoke runs."""

    robot_id: str
    topic: str
    timeout_seconds: float


# Reads an optional environment value and fails fast on blank strings.
def read_required_env(name: str, default_value: str) -> str:
    value = os.environ.get(name, default_value).strip()
    if not value:
        raise ValueError(f"{name} must not be blank")
    return value


# Reads a positive timeout value so the smoke command cannot hang indefinitely.
def read_positive_float_env(name: str, default_value: float) -> float:
    raw_value = os.environ.get(name, str(default_value)).strip()
    try:
        value = float(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number, got {raw_value!r}") from exc

    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be a positive finite number")

    return value


# Loads only the values that matter for a one-shot local telemetry smoke.
def read_config() -> EmitterConfig:
    return EmitterConfig(
        robot_id=read_required_env("ISAAC_TELEMETRY_ROBOT_ID", "nova-carter"),
        topic=read_required_env("ISAAC_TELEMETRY_ODOM_TOPIC", "/chassis/odom"),
        timeout_seconds=read_positive_float_env("ISAAC_TELEMETRY_TIMEOUT_SECONDS", 10.0),
    )


# Returns a UTC ISO timestamp that satisfies the shared protocol date-time schema.
def now_iso_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# Converts a ROS quaternion orientation into the 2D yaw angle used by Fleet Platform.
def yaw_from_quaternion(orientation: object) -> float:
    x = float(orientation.x)
    y = float(orientation.y)
    z = float(orientation.z)
    w = float(orientation.w)

    siny_cosp = 2.0 * ((w * z) + (x * y))
    cosy_cosp = 1.0 - (2.0 * ((y * y) + (z * z)))
    return math.atan2(siny_cosp, cosy_cosp)


# Rejects NaN and infinite values before they can become invalid JSON telemetry.
def require_finite_number(name: str, value: float) -> float:
    if not math.isfinite(value):
        raise ValueError(f"{name} must be finite")
    return value


# Waits for one Odometry message using a QoS profile compatible with Isaac bridge data.
def wait_for_odom_sample(node: Node, topic: str, timeout_seconds: float) -> Odometry:
    sample = None

    def handle_sample(message: Odometry) -> None:
        nonlocal sample
        if sample is None:
            sample = message

    qos = QoSProfile(
        depth=10,
        durability=DurabilityPolicy.VOLATILE,
        history=HistoryPolicy.KEEP_LAST,
        reliability=ReliabilityPolicy.BEST_EFFORT,
    )
    subscription = node.create_subscription(Odometry, topic, handle_sample, qos)
    deadline = time.monotonic() + timeout_seconds

    try:
        while rclpy.ok() and sample is None:
            remaining_seconds = deadline - time.monotonic()
            if remaining_seconds <= 0:
                raise TimeoutError(
                    f"No {topic} Odometry sample received within {timeout_seconds:.1f}s"
                )

            rclpy.spin_once(node, timeout_sec=min(0.1, remaining_seconds))
    finally:
        node.destroy_subscription(subscription)

    if sample is None:
        raise RuntimeError(f"ROS2 shut down before a {topic} Odometry sample was received")

    return sample


# Projects a ROS Odometry sample into the robot.telemetry.v1 payload shape.
def telemetry_payload(config: EmitterConfig, odometry: Odometry) -> dict[str, object]:
    position = odometry.pose.pose.position
    orientation = odometry.pose.pose.orientation
    observed_at = now_iso_utc()

    return {
        "schemaVersion": SCHEMA_VERSION,
        "eventId": f"telemetry-{uuid.uuid4()}",
        "robotId": config.robot_id,
        "observedAt": observed_at,
        "receivedAt": observed_at,
        "pose": {
            "x": require_finite_number("pose.x", float(position.x)),
            "y": require_finite_number("pose.y", float(position.y)),
            "theta": require_finite_number("pose.theta", yaw_from_quaternion(orientation)),
        },
        "batteryPercent": BATTERY_PERCENT,
        "health": HEALTH,
        "connectionState": CONNECTION_STATE,
        "lastSeenCommandSequence": LAST_SEEN_COMMAND_SEQUENCE,
        "edgeAgentVersion": EDGE_AGENT_VERSION,
    }


# Runs the one-shot subscription and prints only JSON on stdout.
def main() -> int:
    try:
        config = read_config()
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    rclpy.init(args=None)
    node = rclpy.create_node("roboops_odom_telemetry_json_emitter")
    try:
        odometry = wait_for_odom_sample(node, config.topic, config.timeout_seconds)
        print(json.dumps(telemetry_payload(config, odometry), separators=(",", ":")))
        return 0
    except (RuntimeError, TimeoutError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
PY
