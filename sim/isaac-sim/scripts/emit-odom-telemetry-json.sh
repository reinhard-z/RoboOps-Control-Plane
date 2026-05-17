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

# Keeps ROS client logging off stdout so callers can pipe stdout as JSON.
export RCUTILS_LOGGING_USE_STDOUT="${RCUTILS_LOGGING_USE_STDOUT:-0}"

python3 - <<'PY'
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
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
    from rosgraph_msgs.msg import Clock
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
    clock_topic: str
    odom_topic: str
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
        clock_topic=read_required_env("ISAAC_TELEMETRY_CLOCK_TOPIC", "/clock"),
        odom_topic=read_required_env("ISAAC_TELEMETRY_ODOM_TOPIC", "/chassis/odom"),
        timeout_seconds=read_positive_float_env("ISAAC_TELEMETRY_TIMEOUT_SECONDS", 10.0),
    )


# Returns a UTC ISO timestamp that satisfies the shared protocol date-time schema.
def now_iso_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# Converts Isaac /clock simulation time into the protocol's ISO timestamp field.
def ros_clock_to_iso_utc(clock: Clock) -> str:
    seconds = int(clock.clock.sec)
    nanoseconds = int(clock.clock.nanosec)

    if seconds < 0:
        raise ValueError("/clock seconds must be non-negative")

    if nanoseconds < 0 or nanoseconds >= 1_000_000_000:
        raise ValueError("/clock nanoseconds must be between 0 and 999999999")

    timestamp = datetime.fromtimestamp(seconds, timezone.utc)
    timestamp += timedelta(microseconds=nanoseconds // 1_000)
    return timestamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")


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


# Waits for one /clock and one Odometry sample using Isaac-compatible QoS.
def wait_for_samples(node: Node, config: EmitterConfig) -> tuple[Clock, Odometry]:
    clock_sample = None
    odom_sample = None

    def handle_clock_sample(message: Clock) -> None:
        nonlocal clock_sample
        clock_sample = message

    def handle_odom_sample(message: Odometry) -> None:
        nonlocal odom_sample
        if odom_sample is None:
            odom_sample = message

    qos = QoSProfile(
        depth=10,
        durability=DurabilityPolicy.VOLATILE,
        history=HistoryPolicy.KEEP_LAST,
        reliability=ReliabilityPolicy.BEST_EFFORT,
    )
    clock_subscription = node.create_subscription(
        Clock, config.clock_topic, handle_clock_sample, qos
    )
    odom_subscription = node.create_subscription(
        Odometry, config.odom_topic, handle_odom_sample, qos
    )
    deadline = time.monotonic() + config.timeout_seconds

    try:
        while rclpy.ok() and (clock_sample is None or odom_sample is None):
            remaining_seconds = deadline - time.monotonic()
            if remaining_seconds <= 0:
                missing_topics = []
                if clock_sample is None:
                    missing_topics.append(config.clock_topic)
                if odom_sample is None:
                    missing_topics.append(config.odom_topic)
                raise TimeoutError(
                    "No sample received from "
                    f"{', '.join(missing_topics)} within {config.timeout_seconds:.1f}s"
                )

            rclpy.spin_once(node, timeout_sec=min(0.1, remaining_seconds))
    finally:
        node.destroy_subscription(clock_subscription)
        node.destroy_subscription(odom_subscription)

    if clock_sample is None or odom_sample is None:
        raise RuntimeError("ROS2 shut down before telemetry samples were received")

    return clock_sample, odom_sample


# Projects a ROS Odometry sample into the robot.telemetry.v1 payload shape.
def telemetry_payload(
    config: EmitterConfig,
    clock: Clock,
    odometry: Odometry,
) -> dict[str, object]:
    position = odometry.pose.pose.position
    orientation = odometry.pose.pose.orientation

    return {
        "schemaVersion": SCHEMA_VERSION,
        "eventId": f"telemetry-{uuid.uuid4()}",
        "robotId": config.robot_id,
        "observedAt": ros_clock_to_iso_utc(clock),
        "receivedAt": now_iso_utc(),
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
        clock, odometry = wait_for_samples(node, config)
        print(
            json.dumps(telemetry_payload(config, clock, odometry), separators=(",", ":")),
            flush=True,
        )
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
