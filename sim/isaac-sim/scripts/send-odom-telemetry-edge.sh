#!/usr/bin/env bash
set -euo pipefail

# Streams Isaac odometry telemetry through the existing Fleet Platform edge socket.

# Verifies that the sidecar has the Python runtime used for JSON and WebSocket I/O.
require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Missing required command: ${name}" >&2
    echo "Run this inside the ROS2 sidecar after sourcing /opt/ros/humble/setup.bash." >&2
    exit 1
  fi
}

require_command python3

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ISAAC_EDGE_EMITTER="${ISAAC_EDGE_EMITTER:-${script_dir}/emit-odom-telemetry-json.sh}"

python3 - "$@" <<'PY'
from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
import hashlib
import json
import math
import os
import secrets
import socket
import ssl
import struct
import subprocess
import sys
import time
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
import uuid


DEFAULT_FLEET_PLATFORM_URL = "http://127.0.0.1:4010"
DEFAULT_ROBOT_ID = "nova-carter"
EDGE_TELEMETRY_TYPE = "edge.telemetry"
ROBOT_TELEMETRY_SCHEMA = "robot.telemetry.v1"
WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


@dataclass(frozen=True)
class SenderConfig:
    """Validated runtime settings for a single Isaac telemetry sender process."""

    edge_ws_url: str
    robot_id: str
    edge_session_id: str
    edge_agent_version: str
    last_seen_command_sequence: int
    emitter_path: str
    payload_file: str | None
    heartbeat_seconds: float
    dry_run: bool
    once: bool
    connect_timeout_seconds: float
    emitter_timeout_seconds: float


class EdgeWebSocketClient:
    """Small send-only WebSocket client for Fleet Platform's edge JSON channel."""

    def __init__(self, url: str, timeout_seconds: float) -> None:
        self.url = url
        self.timeout_seconds = timeout_seconds
        self._socket: socket.socket | ssl.SSLSocket | None = None

    # Opens a WebSocket connection and verifies the HTTP upgrade response.
    def connect(self) -> None:
        parts = urlsplit(self.url)
        if parts.scheme not in {"ws", "wss"}:
            raise ValueError("edge WebSocket URL must start with ws:// or wss://")
        if not parts.hostname:
            raise ValueError("edge WebSocket URL must include a host")

        port = parts.port or (443 if parts.scheme == "wss" else 80)
        raw_socket = socket.create_connection(
            (parts.hostname, port),
            timeout=self.timeout_seconds,
        )
        raw_socket.settimeout(self.timeout_seconds)
        if parts.scheme == "wss":
            wrapped_socket = ssl.create_default_context().wrap_socket(
                raw_socket,
                server_hostname=parts.hostname,
            )
            self._socket = wrapped_socket
        else:
            self._socket = raw_socket

        key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        path = parts.path or "/"
        if parts.query:
            path = f"{path}?{parts.query}"
        request = "\r\n".join(
            [
                f"GET {path} HTTP/1.1",
                f"Host: {parts.netloc}",
                "Upgrade: websocket",
                "Connection: Upgrade",
                "Sec-WebSocket-Version: 13",
                f"Sec-WebSocket-Key: {key}",
                "\r\n",
            ]
        )
        self._socket.sendall(request.encode("ascii"))
        response = self._read_http_response()
        self._validate_upgrade_response(response, key)

    # Sends one JSON object as a masked client text frame.
    def send_json(self, value: dict[str, Any]) -> None:
        if self._socket is None:
            raise RuntimeError("WebSocket is not connected")
        payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self._socket.sendall(encode_client_frame(0x1, payload))

    # Sends a close frame and closes the underlying TCP socket.
    def close(self) -> None:
        if self._socket is None:
            return
        try:
            self._socket.sendall(encode_client_frame(0x8, b""))
        except OSError:
            pass
        self._socket.close()
        self._socket = None

    # Reads the upgrade response headers without consuming WebSocket frames.
    def _read_http_response(self) -> bytes:
        if self._socket is None:
            raise RuntimeError("WebSocket is not connected")

        response = bytearray()
        while b"\r\n\r\n" not in response:
            chunk = self._socket.recv(4096)
            if not chunk:
                raise ConnectionError("Fleet Platform closed the WebSocket upgrade")
            response.extend(chunk)
            if len(response) > 65_536:
                raise ConnectionError("WebSocket upgrade response was too large")
        return bytes(response)

    # Checks the status line and Sec-WebSocket-Accept challenge response.
    def _validate_upgrade_response(self, response: bytes, key: str) -> None:
        text = response.decode("iso-8859-1")
        header_text = text.split("\r\n\r\n", 1)[0]
        lines = header_text.split("\r\n")
        status_line = lines[0] if lines else ""
        if " 101 " not in status_line:
            raise ConnectionError(f"WebSocket upgrade failed: {status_line}")

        headers: dict[str, str] = {}
        for line in lines[1:]:
            if ":" not in line:
                continue
            name, value = line.split(":", 1)
            headers[name.strip().lower()] = value.strip()

        expected_accept = base64.b64encode(
            hashlib.sha1(f"{key}{WEBSOCKET_GUID}".encode("ascii")).digest()
        ).decode("ascii")
        if headers.get("sec-websocket-accept") != expected_accept:
            raise ConnectionError("WebSocket upgrade returned an invalid accept key")


# Encodes a masked client frame as required by RFC 6455.
def encode_client_frame(opcode: int, payload: bytes) -> bytes:
    first_byte = 0x80 | opcode
    mask_bit = 0x80
    length = len(payload)
    if length < 126:
        header = bytes([first_byte, mask_bit | length])
    elif length <= 65_535:
        header = bytes([first_byte, mask_bit | 126]) + struct.pack("!H", length)
    else:
        header = bytes([first_byte, mask_bit | 127]) + struct.pack("!Q", length)

    mask = secrets.token_bytes(4)
    masked_payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return header + mask + masked_payload


# Parses CLI flags that are useful both inside ROS2 and in local dry-run checks.
def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="send-odom-telemetry-edge.sh",
        description="Send Isaac /chassis/odom telemetry to Fleet Platform over edge.telemetry.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="wrap and print one edge.telemetry message without opening a WebSocket",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="send one telemetry message, then close the WebSocket and exit",
    )
    parser.add_argument(
        "--payload-file",
        help="read one robot.telemetry.v1 payload from a file instead of ROS2",
    )
    parser.add_argument(
        "--print-url",
        action="store_true",
        help="print the derived edge WebSocket URL and exit",
    )
    return parser.parse_args(argv)


# Combines environment and CLI settings while keeping Fleet Platform's URL shape fixed.
def read_config(args: argparse.Namespace) -> SenderConfig:
    robot_id = first_env(
        "ISAAC_EDGE_ROBOT_ID",
        "ISAAC_TELEMETRY_ROBOT_ID",
        "ROBOT_ID",
        default=DEFAULT_ROBOT_ID,
    )
    edge_agent_version = first_env(
        "ISAAC_EDGE_AGENT_VERSION",
        "EDGE_AGENT_VERSION",
        default="local/dev",
    )
    last_seen_command_sequence = read_non_negative_int_env(
        "ISAAC_EDGE_LAST_SEEN_COMMAND_SEQUENCE",
        0,
    )
    fleet_platform_url = first_env(
        "ISAAC_EDGE_WS_URL",
        "FLEET_PLATFORM_URL",
        default=DEFAULT_FLEET_PLATFORM_URL,
    )
    telemetry_timeout_seconds = read_positive_float_env(
        "ISAAC_TELEMETRY_TIMEOUT_SECONDS",
        10.0,
    )
    dry_run = args.dry_run or read_bool_env("ISAAC_EDGE_DRY_RUN")
    payload_file = (
        args.payload_file.strip()
        if args.payload_file
        else optional_env("ISAAC_EDGE_PAYLOAD_FILE")
    )

    return SenderConfig(
        edge_ws_url=edge_websocket_url(fleet_platform_url, robot_id),
        robot_id=robot_id,
        edge_session_id=first_env(
            "ISAAC_EDGE_SESSION_ID",
            default=f"edge_session_{uuid.uuid4().hex}",
        ),
        edge_agent_version=edge_agent_version,
        last_seen_command_sequence=last_seen_command_sequence,
        emitter_path=first_env("ISAAC_EDGE_EMITTER"),
        payload_file=payload_file,
        heartbeat_seconds=read_positive_float_env("ISAAC_EDGE_HEARTBEAT_SECONDS", 1.0),
        dry_run=dry_run,
        once=args.once or dry_run or payload_file is not None,
        connect_timeout_seconds=read_positive_float_env(
            "ISAAC_EDGE_CONNECT_TIMEOUT_SECONDS",
            5.0,
        ),
        emitter_timeout_seconds=read_positive_float_env(
            "ISAAC_EDGE_EMITTER_TIMEOUT_SECONDS",
            telemetry_timeout_seconds + 5.0,
        ),
    )


# Returns the first non-blank environment variable value, or a required default.
def first_env(*names: str, default: str | None = None) -> str:
    for name in names:
        value = os.environ.get(name)
        if value is not None and value.strip():
            return value.strip()
    if default is not None:
        return default
    raise ValueError(f"one of {', '.join(names)} must be set")


# Reads a non-blank optional environment value.
def optional_env(name: str) -> str | None:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return None
    return value.strip()


# Reads common shell truthy values without accepting arbitrary text as true.
def read_bool_env(name: str) -> bool:
    value = os.environ.get(name, "").strip().lower()
    return value in {"1", "true", "yes", "on"}


# Reads a positive floating point environment value.
def read_positive_float_env(name: str, default: float) -> float:
    raw_value = os.environ.get(name, str(default)).strip()
    try:
        value = float(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number, got {raw_value!r}") from exc
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be a positive finite number")
    return value


# Reads a non-negative integer environment value for command sequence state.
def read_non_negative_int_env(name: str, default: int) -> int:
    raw_value = os.environ.get(name, str(default)).strip()
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw_value!r}") from exc
    if value < 0:
        raise ValueError(f"{name} must be non-negative")
    return value


# Mirrors apps/cloud-edge-simulator's Fleet Platform to /edge/connect URL mapping.
def edge_websocket_url(value: str, robot_id: str) -> str:
    parts = urlsplit(value)
    if parts.scheme in {"http", "https"}:
        scheme = "wss" if parts.scheme == "https" else "ws"
        query = urlencode({"robotId": robot_id})
        return urlunsplit((scheme, parts.netloc, "/edge/connect", query, ""))
    if parts.scheme in {"ws", "wss"}:
        query_params = dict(parse_qsl(parts.query, keep_blank_values=True))
        query_params["robotId"] = robot_id
        path = parts.path or "/edge/connect"
        return urlunsplit(
            (parts.scheme, parts.netloc, path, urlencode(query_params), "")
        )
    raise ValueError("FLEET_PLATFORM_URL must start with http://, https://, ws://, or wss://")


# Reads one telemetry payload either from a file fixture or the ROS2 emitter.
def read_telemetry_payload(config: SenderConfig) -> dict[str, Any]:
    if config.payload_file:
        with open(config.payload_file, "r", encoding="utf-8") as payload_file:
            return parse_json_payload(payload_file.read(), config.payload_file)
    return run_emitter(config)


# Invokes the existing one-shot ROS2 odometry emitter and parses its JSON stdout.
def run_emitter(config: SenderConfig) -> dict[str, Any]:
    env = os.environ.copy()
    env["ISAAC_TELEMETRY_ROBOT_ID"] = config.robot_id
    env["ISAAC_TELEMETRY_EDGE_AGENT_VERSION"] = config.edge_agent_version
    completed = subprocess.run(
        [config.emitter_path],
        check=False,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=config.emitter_timeout_seconds,
    )
    if completed.returncode != 0:
        stderr = completed.stderr.strip()
        raise RuntimeError(
            f"telemetry emitter failed with exit code {completed.returncode}"
            + (f": {stderr}" if stderr else "")
        )
    return parse_json_payload(completed.stdout, config.emitter_path)


# Parses one JSON object and keeps fixture or emitter parse errors actionable.
def parse_json_payload(text: str, source: str) -> dict[str, Any]:
    stripped = text.strip()
    try:
        payload = json.loads(stripped)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{source} did not produce valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"{source} must produce a JSON object")
    return payload


# Builds the edge hello frame that marks the robot socket online.
def create_hello_message(config: SenderConfig) -> dict[str, Any]:
    return {
        "type": "edge.hello",
        "payload": {
            "edgeSessionId": config.edge_session_id,
            "edgeAgentVersion": config.edge_agent_version,
            "lastSeenCommandSequence": config.last_seen_command_sequence,
        },
    }


# Validates and wraps a robot.telemetry.v1 payload as the Fleet Platform edge frame.
def create_edge_telemetry_message(
    config: SenderConfig,
    payload: dict[str, Any],
) -> dict[str, Any]:
    validate_robot_telemetry_payload(payload, config.robot_id)
    return {"type": EDGE_TELEMETRY_TYPE, "payload": payload}


# Checks the fields Fleet Platform requires before a frame is put on the socket.
def validate_robot_telemetry_payload(payload: dict[str, Any], robot_id: str) -> None:
    require_equal(payload, "schemaVersion", ROBOT_TELEMETRY_SCHEMA)
    require_string(payload, "eventId")
    require_equal(payload, "robotId", robot_id)
    require_string(payload, "observedAt")
    require_string(payload, "receivedAt")
    pose = payload.get("pose")
    if not isinstance(pose, dict):
        raise ValueError("pose must be an object")
    require_finite_number(pose, "x", "pose.x")
    require_finite_number(pose, "y", "pose.y")
    require_finite_number(pose, "theta", "pose.theta")
    battery_percent = require_finite_number(
        payload,
        "batteryPercent",
        "batteryPercent",
    )
    if battery_percent < 0 or battery_percent > 100:
        raise ValueError("batteryPercent must be between 0 and 100")
    require_member(payload, "health", {"OK", "WARN", "ERROR", "ESTOP"})
    require_member(
        payload,
        "connectionState",
        {"ONLINE", "STALE", "DEGRADED", "OFFLINE", "RECONNECTING"},
    )
    require_non_negative_int(payload, "lastSeenCommandSequence")
    require_string(payload, "edgeAgentVersion")


# Requires a field to exactly match the expected protocol constant.
def require_equal(payload: dict[str, Any], key: str, expected: str) -> None:
    if payload.get(key) != expected:
        raise ValueError(f"{key} must be {expected!r}")


# Requires a non-empty string field.
def require_string(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} must be a non-empty string")
    return value


# Requires a field to be one of the known protocol enum strings.
def require_member(payload: dict[str, Any], key: str, allowed: set[str]) -> str:
    value = require_string(payload, key)
    if value not in allowed:
        raise ValueError(f"{key} must be one of: {', '.join(sorted(allowed))}")
    return value


# Requires a JSON number and rejects bool, NaN, and infinity.
def require_finite_number(
    payload: dict[str, Any],
    key: str,
    display_name: str,
) -> float:
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{display_name} must be a number")
    numeric_value = float(value)
    if not math.isfinite(numeric_value):
        raise ValueError(f"{display_name} must be finite")
    return numeric_value


# Requires the command sequence field to match platform validation rules.
def require_non_negative_int(payload: dict[str, Any], key: str) -> int:
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{key} must be a non-negative integer")
    return value


# Prints progress to stderr so stdout can remain machine-readable in dry-run mode.
def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


# Runs either one dry-run wrapper or the live WebSocket streaming loop.
def main(argv: list[str]) -> int:
    try:
        args = parse_args(argv)
        config = read_config(args)
        if args.print_url:
            print(config.edge_ws_url)
            return 0

        if config.dry_run:
            payload = read_telemetry_payload(config)
            print(
                json.dumps(
                    create_edge_telemetry_message(config, payload),
                    separators=(",", ":"),
                ),
                flush=True,
            )
            return 0

        client = EdgeWebSocketClient(config.edge_ws_url, config.connect_timeout_seconds)
        client.connect()
        try:
            client.send_json(create_hello_message(config))
            log(f"connected to Fleet Platform edge socket: {config.edge_ws_url}")
            while True:
                started_at = time.monotonic()
                payload = read_telemetry_payload(config)
                message = create_edge_telemetry_message(config, payload)
                client.send_json(message)
                log(f"sent edge.telemetry eventId={payload['eventId']}")
                if config.once:
                    return 0
                elapsed_seconds = time.monotonic() - started_at
                time.sleep(max(0.0, config.heartbeat_seconds - elapsed_seconds))
        finally:
            client.close()
    except KeyboardInterrupt:
        return 130
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
PY
