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
from datetime import datetime, timezone
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
COMMAND_ACK_SCHEMA = "command.ack.v1"
COMMAND_ENVELOPE_SCHEMA = "command.envelope.v1"
EDGE_COMMAND_ACK_TYPE = "edge.command_ack"
EDGE_TELEMETRY_TYPE = "edge.telemetry"
KNOWN_COMMAND_TYPES = {
    "GO_TO_POSE",
    "CANCEL_MISSION",
    "PAUSE_MISSION",
    "RESUME_MISSION",
    "EMERGENCY_STOP",
}
MAX_WEBSOCKET_FRAME_BYTES = 1024 * 1024
PLATFORM_COMMAND_TYPE = "platform.command"
PLATFORM_ERROR_TYPE = "platform.error"
PLATFORM_PING_TYPE = "platform.ping"
ROBOT_TELEMETRY_SCHEMA = "robot.telemetry.v1"
SAFETY_CLASSES = {"NORMAL", "RISKY", "EMERGENCY_STOP"}
SUPPORTED_COMMAND_TYPES = {"GO_TO_POSE", "CANCEL_MISSION"}
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
    command_fixture_file: str | None
    heartbeat_seconds: float
    command_poll_seconds: float
    dry_run: bool
    once: bool
    connect_timeout_seconds: float
    emitter_timeout_seconds: float


@dataclass
class EdgeAgentState:
    """Mutable edge state reported back through acks and telemetry heartbeats."""

    last_seen_command_sequence: int
    last_acknowledged_command_id: str | None = None
    current_mission_id: str | None = None


@dataclass(frozen=True)
class WebSocketFrame:
    """Decoded WebSocket frame received from Fleet Platform."""

    opcode: int
    payload: bytes
    frame_bytes: int


class EdgeWebSocketClient:
    """Small WebSocket client for Fleet Platform's edge JSON channel."""

    def __init__(self, url: str, timeout_seconds: float) -> None:
        self.url = url
        self.timeout_seconds = timeout_seconds
        self._socket: socket.socket | ssl.SSLSocket | None = None
        self._receive_buffer = bytearray()

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
        self._socket.settimeout(self.timeout_seconds)
        payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self._socket.sendall(encode_client_frame(0x1, payload))

    # Receives one Fleet Platform JSON object, replying to WebSocket pings internally.
    def receive_json(self, timeout_seconds: float) -> dict[str, Any] | None:
        while True:
            frame = self._read_frame(timeout_seconds)
            if frame is None:
                return None
            if frame.opcode == 0x8:
                raise ConnectionError("Fleet Platform closed the WebSocket")
            if frame.opcode == 0x9:
                self._send_control_frame(0xA, frame.payload)
                timeout_seconds = 0.0
                continue
            if frame.opcode == 0xA:
                timeout_seconds = 0.0
                continue
            if frame.opcode != 0x1:
                raise ConnectionError(f"unsupported WebSocket opcode {frame.opcode}")

            try:
                message = json.loads(frame.payload.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ValueError(f"platform message must be valid JSON: {exc}") from exc
            if not isinstance(message, dict):
                raise ValueError("platform message must be a JSON object")
            return message

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

    # Reads upgrade headers while preserving any already-arrived WebSocket bytes.
    def _read_http_response(self) -> bytes:
        if self._socket is None:
            raise RuntimeError("WebSocket is not connected")

        response = bytearray()
        while True:
            chunk = self._socket.recv(4096)
            if not chunk:
                raise ConnectionError("Fleet Platform closed the WebSocket upgrade")
            response.extend(chunk)

            header_end = response.find(b"\r\n\r\n")
            if header_end >= 0:
                frame_start = header_end + len(b"\r\n\r\n")
                trailing_bytes = response[frame_start:]
                if trailing_bytes:
                    self._receive_buffer.extend(trailing_bytes)
                return bytes(response[:frame_start])

            if len(response) > 65_536:
                raise ConnectionError("WebSocket upgrade response was too large")

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

    # Sends a masked client control frame such as pong.
    def _send_control_frame(self, opcode: int, payload: bytes) -> None:
        if self._socket is None:
            raise RuntimeError("WebSocket is not connected")
        self._socket.settimeout(self.timeout_seconds)
        self._socket.sendall(encode_client_frame(opcode, payload))

    # Reads a complete server frame, returning None when the poll timeout expires.
    def _read_frame(self, timeout_seconds: float) -> WebSocketFrame | None:
        if self._socket is None:
            raise RuntimeError("WebSocket is not connected")

        deadline = time.monotonic() + max(0.0, timeout_seconds)
        while True:
            frame = try_decode_server_frame(self._receive_buffer)
            if frame is not None:
                del self._receive_buffer[: frame.frame_bytes]
                return frame

            remaining_seconds = deadline - time.monotonic()
            if timeout_seconds <= 0.0 or remaining_seconds <= 0.0:
                poll_timeout = 0.0
            else:
                poll_timeout = remaining_seconds

            self._socket.settimeout(poll_timeout)
            try:
                chunk = self._socket.recv(4096)
            except (BlockingIOError, socket.timeout, ssl.SSLWantReadError):
                return None
            if not chunk:
                raise ConnectionError("Fleet Platform closed the WebSocket")
            self._receive_buffer.extend(chunk)


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


# Decodes one complete server frame if enough bytes have arrived.
def try_decode_server_frame(buffer: bytearray) -> WebSocketFrame | None:
    if len(buffer) < 2:
        return None

    first_byte = buffer[0]
    second_byte = buffer[1]
    if (first_byte & 0x80) != 0x80:
        raise ConnectionError("fragmented WebSocket frames are not supported")

    opcode = first_byte & 0x0F
    masked = (second_byte & 0x80) == 0x80
    payload_length = second_byte & 0x7F
    offset = 2

    if payload_length == 126:
        if len(buffer) < offset + 2:
            return None
        payload_length = struct.unpack("!H", buffer[offset : offset + 2])[0]
        offset += 2
    elif payload_length == 127:
        if len(buffer) < offset + 8:
            return None
        payload_length = struct.unpack("!Q", buffer[offset : offset + 8])[0]
        offset += 8

    if payload_length > MAX_WEBSOCKET_FRAME_BYTES:
        raise ConnectionError("WebSocket frame exceeded the maximum supported size")

    mask = b""
    if masked:
        if len(buffer) < offset + 4:
            return None
        mask = bytes(buffer[offset : offset + 4])
        offset += 4

    frame_bytes = offset + payload_length
    if len(buffer) < frame_bytes:
        return None

    payload = bytes(buffer[offset:frame_bytes])
    if masked:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return WebSocketFrame(opcode=opcode, payload=payload, frame_bytes=frame_bytes)


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
        "--command-fixture",
        help=(
            "read one platform.command fixture, print the resulting edge.command_ack, "
            "and exit without opening a WebSocket"
        ),
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
    command_fixture_file = (
        args.command_fixture.strip()
        if args.command_fixture
        else optional_env("ISAAC_EDGE_COMMAND_FIXTURE_FILE")
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
        command_fixture_file=command_fixture_file,
        heartbeat_seconds=read_positive_float_env("ISAAC_EDGE_HEARTBEAT_SECONDS", 1.0),
        command_poll_seconds=read_positive_float_env(
            "ISAAC_EDGE_COMMAND_POLL_SECONDS",
            0.2,
        ),
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


# Returns the current UTC timestamp in the protocol's millisecond ISO shape.
def now_iso_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00",
        "Z",
    )


# Builds the edge hello frame that marks the robot socket online.
def create_hello_message(
    config: SenderConfig,
    state: EdgeAgentState,
) -> dict[str, Any]:
    return {
        "type": "edge.hello",
        "payload": {
            "edgeSessionId": config.edge_session_id,
            "edgeAgentVersion": config.edge_agent_version,
            "lastSeenCommandSequence": state.last_seen_command_sequence,
        },
    }


# Adds edge command state to telemetry before wrapping it for Fleet Platform.
def create_edge_telemetry_message(
    config: SenderConfig,
    state: EdgeAgentState,
    payload: dict[str, Any],
) -> dict[str, Any]:
    enriched_payload = dict(payload)
    payload_sequence = require_non_negative_int(
        enriched_payload,
        "lastSeenCommandSequence",
    )
    enriched_payload["lastSeenCommandSequence"] = max(
        payload_sequence,
        state.last_seen_command_sequence,
    )
    if state.last_acknowledged_command_id:
        enriched_payload["lastAcknowledgedCommandId"] = (
            state.last_acknowledged_command_id
        )
    if state.current_mission_id:
        enriched_payload["currentMissionId"] = state.current_mission_id
    elif (
        state.last_acknowledged_command_id
        and "currentMissionId" in enriched_payload
    ):
        del enriched_payload["currentMissionId"]

    validate_robot_telemetry_payload(enriched_payload, config.robot_id)
    return {"type": EDGE_TELEMETRY_TYPE, "payload": enriched_payload}


# Handles one platform message and returns an edge reply when the protocol needs one.
def handle_platform_message(
    config: SenderConfig,
    state: EdgeAgentState,
    message: dict[str, Any],
) -> dict[str, Any] | None:
    message_type = message.get("type")
    if message_type == PLATFORM_COMMAND_TYPE:
        command = parse_command_envelope(message.get("payload"))
        return create_command_ack_message(config, state, command)

    if message_type == PLATFORM_PING_TYPE:
        return None

    if message_type == PLATFORM_ERROR_TYPE:
        payload = message.get("payload")
        code = payload.get("code") if isinstance(payload, dict) else "PLATFORM_ERROR"
        detail = (
            payload.get("message")
            if isinstance(payload, dict) and isinstance(payload.get("message"), str)
            else "platform sent an error"
        )
        log(f"platform error {code}: {detail}")
        return None

    raise ValueError("unsupported platform message type")


# Builds a protocol-valid command acknowledgement and advances local edge state.
def create_command_ack_message(
    config: SenderConfig,
    state: EdgeAgentState,
    command: dict[str, Any],
) -> dict[str, Any]:
    status, reason = classify_command_ack(config, command)
    command_sequence = require_non_negative_int(command, "sequence")
    last_seen_command_sequence = max(
        state.last_seen_command_sequence,
        command_sequence,
    )

    if command["robotId"] == config.robot_id:
        state.last_seen_command_sequence = last_seen_command_sequence
        if status == "ACCEPTED":
            state.last_acknowledged_command_id = command["commandId"]
            if command["type"] == "GO_TO_POSE":
                state.current_mission_id = command["missionId"]
            elif command["type"] == "CANCEL_MISSION":
                state.current_mission_id = None

    payload = {
        "schemaVersion": COMMAND_ACK_SCHEMA,
        "ackId": f"ack_{uuid.uuid4().hex}",
        "commandId": command["commandId"],
        "missionId": command["missionId"],
        "robotId": command["robotId"],
        "status": status,
        "receivedAt": now_iso_utc(),
        "lastSeenCommandSequence": last_seen_command_sequence,
        **({"reason": reason} if reason else {}),
        "correlationId": command["correlationId"],
        "causationId": command["commandId"],
    }
    validate_command_ack_payload(payload)
    return {"type": EDGE_COMMAND_ACK_TYPE, "payload": payload}


# Keeps Isaac command support explicit until a ROS2 action/topic mapper exists.
def classify_command_ack(
    config: SenderConfig,
    command: dict[str, Any],
) -> tuple[str, str | None]:
    if command["robotId"] != config.robot_id:
        return (
            "REJECTED",
            "command robotId "
            f"{command['robotId']} does not match Isaac robotId {config.robot_id}",
        )
    if command["type"] not in SUPPORTED_COMMAND_TYPES:
        return "REJECTED", f"unsupported Isaac command type: {command['type']}"
    return "ACCEPTED", None


# Parses and validates the platform command envelope before acknowledging it.
def parse_command_envelope(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("command payload must be an object")

    require_equal(value, "schemaVersion", COMMAND_ENVELOPE_SCHEMA)
    command_type = require_member(value, "type", KNOWN_COMMAND_TYPES)
    required_strings = [
        "commandId",
        "missionId",
        "robotId",
        "idempotencyKey",
        "issuedAt",
        "expiresAt",
        "correlationId",
        "causationId",
    ]
    for key in required_strings:
        require_string(value, key)
    sequence = require_positive_int(value, "sequence")
    requires_ack = value.get("requiresAck")
    if not isinstance(requires_ack, bool):
        raise ValueError("requiresAck must be a boolean")
    require_member(value, "safetyClass", SAFETY_CLASSES)
    validate_command_payload(command_type, value.get("payload"))

    return {
        "schemaVersion": COMMAND_ENVELOPE_SCHEMA,
        "commandId": value["commandId"],
        "missionId": value["missionId"],
        "robotId": value["robotId"],
        "type": command_type,
        "idempotencyKey": value["idempotencyKey"],
        "sequence": sequence,
        "issuedAt": value["issuedAt"],
        "expiresAt": value["expiresAt"],
        "requiresAck": requires_ack,
        "safetyClass": value["safetyClass"],
        "correlationId": value["correlationId"],
        "causationId": value["causationId"],
        "payload": value["payload"],
    }


# Checks the command-specific payload shapes Fleet Platform can send today.
def validate_command_payload(command_type: str, payload: Any) -> None:
    if not isinstance(payload, dict):
        raise ValueError("command payload must be an object")

    if command_type == "GO_TO_POSE":
        target = payload.get("target")
        if not isinstance(target, dict):
            raise ValueError("payload.target is required for GO_TO_POSE")
        require_finite_number(target, "x", "payload.target.x")
        require_finite_number(target, "y", "payload.target.y")
        require_finite_number(target, "theta", "payload.target.theta")
        return

    if command_type == "CANCEL_MISSION":
        require_string(payload, "reason")
        return

    reason = payload.get("reason")
    if reason is not None and (not isinstance(reason, str) or not reason):
        raise ValueError("payload.reason must be a non-empty string when present")


# Validates generated acks before they are printed or sent to the platform.
def validate_command_ack_payload(payload: dict[str, Any]) -> None:
    require_equal(payload, "schemaVersion", COMMAND_ACK_SCHEMA)
    require_string(payload, "ackId")
    require_string(payload, "commandId")
    if "missionId" in payload:
        require_string(payload, "missionId")
    require_string(payload, "robotId")
    require_member(
        payload,
        "status",
        {"ACCEPTED", "REJECTED", "EXPIRED", "DUPLICATE", "FAILED"},
    )
    require_string(payload, "receivedAt")
    require_non_negative_int(payload, "lastSeenCommandSequence")
    if "reason" in payload:
        require_string(payload, "reason")
    require_string(payload, "correlationId")
    require_string(payload, "causationId")


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


# Requires a positive integer field for platform command sequences.
def require_positive_int(payload: dict[str, Any], key: str) -> int:
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{key} must be a positive integer")
    return value


# Prints progress to stderr so stdout can remain machine-readable in dry-run mode.
def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


# Processes all platform messages already buffered on the socket.
def drain_platform_messages(
    config: SenderConfig,
    state: EdgeAgentState,
    client: EdgeWebSocketClient,
) -> None:
    while process_one_platform_message(config, state, client, 0.0):
        pass


# Processes platform messages until the next telemetry heartbeat is due.
def process_platform_messages_until(
    config: SenderConfig,
    state: EdgeAgentState,
    client: EdgeWebSocketClient,
    deadline: float,
) -> None:
    while True:
        remaining_seconds = deadline - time.monotonic()
        if remaining_seconds <= 0.0:
            return
        process_one_platform_message(
            config,
            state,
            client,
            min(config.command_poll_seconds, remaining_seconds),
        )


# Receives one platform frame and sends an ack when a valid command arrives.
def process_one_platform_message(
    config: SenderConfig,
    state: EdgeAgentState,
    client: EdgeWebSocketClient,
    timeout_seconds: float,
) -> bool:
    try:
        message = client.receive_json(timeout_seconds)
    except ValueError as exc:
        log(f"ignored invalid platform message: {exc}")
        return True
    if message is None:
        return False

    try:
        outbound = handle_platform_message(config, state, message)
    except ValueError as exc:
        log(f"ignored invalid platform message: {exc}")
        return True

    if outbound is None:
        return True

    client.send_json(outbound)
    payload = outbound["payload"]
    log(
        "sent edge.command_ack "
        f"commandId={payload['commandId']} status={payload['status']}"
    )
    return True


# Builds one command ack from a fixture file without opening a network socket.
def create_command_fixture_ack(config: SenderConfig) -> dict[str, Any]:
    if not config.command_fixture_file:
        raise ValueError("command fixture file is required")
    with open(config.command_fixture_file, "r", encoding="utf-8") as fixture_file:
        message = parse_json_payload(fixture_file.read(), config.command_fixture_file)

    state = EdgeAgentState(
        last_seen_command_sequence=config.last_seen_command_sequence,
    )
    outbound = handle_platform_message(config, state, message)
    if outbound is None or outbound.get("type") != EDGE_COMMAND_ACK_TYPE:
        raise ValueError("command fixture did not produce an edge.command_ack response")
    return outbound


# Runs either one dry-run wrapper or the live WebSocket streaming loop.
def main(argv: list[str]) -> int:
    try:
        args = parse_args(argv)
        config = read_config(args)
        if args.print_url:
            print(config.edge_ws_url)
            return 0

        if config.command_fixture_file:
            print(
                json.dumps(
                    create_command_fixture_ack(config),
                    separators=(",", ":"),
                ),
                flush=True,
            )
            return 0

        state = EdgeAgentState(
            last_seen_command_sequence=config.last_seen_command_sequence,
        )
        if config.dry_run:
            payload = read_telemetry_payload(config)
            print(
                json.dumps(
                    create_edge_telemetry_message(config, state, payload),
                    separators=(",", ":"),
                ),
                flush=True,
            )
            return 0

        client = EdgeWebSocketClient(config.edge_ws_url, config.connect_timeout_seconds)
        client.connect()
        try:
            client.send_json(create_hello_message(config, state))
            log(f"connected to Fleet Platform edge socket: {config.edge_ws_url}")
            process_platform_messages_until(
                config,
                state,
                client,
                time.monotonic() + config.command_poll_seconds,
            )
            while True:
                drain_platform_messages(config, state, client)
                started_at = time.monotonic()
                payload = read_telemetry_payload(config)
                message = create_edge_telemetry_message(config, state, payload)
                client.send_json(message)
                log(f"sent edge.telemetry eventId={message['payload']['eventId']}")
                if config.once:
                    return 0
                elapsed_seconds = time.monotonic() - started_at
                next_heartbeat = time.monotonic() + max(
                    0.0,
                    config.heartbeat_seconds - elapsed_seconds,
                )
                process_platform_messages_until(config, state, client, next_heartbeat)
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
