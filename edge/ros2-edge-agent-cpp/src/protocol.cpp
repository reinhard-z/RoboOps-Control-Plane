#include "roboops_ros2_edge_agent/protocol.hpp"

#include <atomic>
#include <chrono>
#include <cmath>
#include <ctime>
#include <iomanip>
#include <locale>
#include <sstream>
#include <stdexcept>
#include <utility>
#include <vector>

namespace roboops::edge_agent {
namespace {

std::atomic<std::uint64_t> local_id_counter{0};

/** Formats a double for JSON while avoiding locale-sensitive output. */
std::string json_number(double value) {
  if (!std::isfinite(value)) {
    throw std::invalid_argument("protocol numbers must be finite");
  }

  std::ostringstream stream;
  stream.imbue(std::locale::classic());
  stream << std::setprecision(12) << value;
  return stream.str();
}

/** Escapes a string using the JSON escapes needed by protocol values. */
std::string json_string(std::string_view value) {
  std::ostringstream stream;
  stream << '"';
  for (const unsigned char ch : value) {
    switch (ch) {
      case '"':
        stream << "\\\"";
        break;
      case '\\':
        stream << "\\\\";
        break;
      case '\b':
        stream << "\\b";
        break;
      case '\f':
        stream << "\\f";
        break;
      case '\n':
        stream << "\\n";
        break;
      case '\r':
        stream << "\\r";
        break;
      case '\t':
        stream << "\\t";
        break;
      default:
        if (ch < 0x20) {
          stream << "\\u" << std::hex << std::uppercase << std::setw(4)
                 << std::setfill('0') << static_cast<int>(ch) << std::dec
                 << std::nouppercase << std::setfill(' ');
        } else {
          stream << static_cast<char>(ch);
        }
    }
  }
  stream << '"';
  return stream.str();
}

/** Combines already-serialized object fields into a JSON object. */
std::string json_object(const std::vector<std::string>& fields) {
  std::ostringstream stream;
  stream << '{';
  for (std::size_t index = 0; index < fields.size(); ++index) {
    if (index > 0) {
      stream << ',';
    }
    stream << fields[index];
  }
  stream << '}';
  return stream.str();
}

/** Serializes a string field with a stable key order. */
std::string string_field(std::string_view key, std::string_view value) {
  return json_string(key) + ":" + json_string(value);
}

/** Serializes an integer field with a stable key order. */
std::string integer_field(std::string_view key, std::int64_t value) {
  return json_string(key) + ":" + std::to_string(value);
}

/** Serializes a numeric field with a stable key order. */
std::string number_field(std::string_view key, double value) {
  return json_string(key) + ":" + json_number(value);
}

/** Serializes a pose object in the shape expected by robot.telemetry.v1. */
std::string pose_json(const Pose2D& pose) {
  return json_object({
      number_field("x", pose.x),
      number_field("y", pose.y),
      number_field("theta", pose.theta),
  });
}

/** Returns a UTC tm value using the platform's thread-safe conversion API. */
std::tm utc_time(std::time_t value) {
  std::tm result{};
#if defined(_WIN32)
  gmtime_s(&result, &value);
#else
  gmtime_r(&value, &result);
#endif
  return result;
}

/** Rejects telemetry poses that would serialize to invalid JSON or nonsense. */
void validate_pose(const Pose2D& pose) {
  if (!std::isfinite(pose.x) || !std::isfinite(pose.y) ||
      !std::isfinite(pose.theta)) {
    throw std::invalid_argument("telemetry pose values must be finite");
  }
}

/** Keeps battery telemetry inside the robot.telemetry.v1 schema range. */
void validate_battery_percent(double battery_percent) {
  if (!std::isfinite(battery_percent) || battery_percent < 0.0 ||
      battery_percent > 100.0) {
    throw std::invalid_argument("batteryPercent must be finite and between 0 and 100");
  }
}

}  // namespace

std::string to_wire_value(CommandType value) {
  switch (value) {
    case CommandType::go_to_pose:
      return "GO_TO_POSE";
    case CommandType::cancel_mission:
      return "CANCEL_MISSION";
    case CommandType::pause_mission:
      return "PAUSE_MISSION";
    case CommandType::resume_mission:
      return "RESUME_MISSION";
    case CommandType::emergency_stop:
      return "EMERGENCY_STOP";
  }
  throw std::invalid_argument("unknown command type");
}

std::string to_wire_value(SafetyClass value) {
  switch (value) {
    case SafetyClass::normal:
      return "NORMAL";
    case SafetyClass::risky:
      return "RISKY";
    case SafetyClass::emergency_stop:
      return "EMERGENCY_STOP";
  }
  throw std::invalid_argument("unknown safety class");
}

std::string to_wire_value(CommandAckStatus value) {
  switch (value) {
    case CommandAckStatus::accepted:
      return "ACCEPTED";
    case CommandAckStatus::rejected:
      return "REJECTED";
    case CommandAckStatus::expired:
      return "EXPIRED";
    case CommandAckStatus::duplicate:
      return "DUPLICATE";
    case CommandAckStatus::failed:
      return "FAILED";
  }
  throw std::invalid_argument("unknown command ack status");
}

std::string to_wire_value(RobotHealthState value) {
  switch (value) {
    case RobotHealthState::ok:
      return "OK";
    case RobotHealthState::warn:
      return "WARN";
    case RobotHealthState::error:
      return "ERROR";
    case RobotHealthState::estop:
      return "ESTOP";
  }
  throw std::invalid_argument("unknown robot health state");
}

std::string to_wire_value(RobotConnectionState value) {
  switch (value) {
    case RobotConnectionState::online:
      return "ONLINE";
    case RobotConnectionState::stale:
      return "STALE";
    case RobotConnectionState::degraded:
      return "DEGRADED";
    case RobotConnectionState::offline:
      return "OFFLINE";
    case RobotConnectionState::reconnecting:
      return "RECONNECTING";
  }
  throw std::invalid_argument("unknown robot connection state");
}

std::string to_wire_value(MissionLifecycleState value) {
  switch (value) {
    case MissionLifecycleState::created:
      return "CREATED";
    case MissionLifecycleState::validated:
      return "VALIDATED";
    case MissionLifecycleState::rejected:
      return "REJECTED";
    case MissionLifecycleState::safety_blocked:
      return "SAFETY_BLOCKED";
    case MissionLifecycleState::assigned:
      return "ASSIGNED";
    case MissionLifecycleState::dispatched:
      return "DISPATCHED";
    case MissionLifecycleState::acknowledged:
      return "ACKNOWLEDGED";
    case MissionLifecycleState::running:
      return "RUNNING";
    case MissionLifecycleState::cancel_requested:
      return "CANCEL_REQUESTED";
    case MissionLifecycleState::cancelled:
      return "CANCELLED";
    case MissionLifecycleState::succeeded:
      return "SUCCEEDED";
    case MissionLifecycleState::failed:
      return "FAILED";
    case MissionLifecycleState::timed_out:
      return "TIMED_OUT";
    case MissionLifecycleState::manual_review:
      return "MANUAL_REVIEW";
  }
  throw std::invalid_argument("unknown mission lifecycle state");
}

std::string make_local_id(std::string_view prefix) {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  const auto millis =
      std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
  const auto counter = local_id_counter.fetch_add(1, std::memory_order_relaxed);

  std::ostringstream stream;
  stream << prefix << "_" << millis << "_" << counter;
  return stream.str();
}

std::string now_iso_utc() {
  const auto now = std::chrono::system_clock::now();
  const auto millis_since_epoch =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          now.time_since_epoch());
  const auto seconds_since_epoch =
      std::chrono::duration_cast<std::chrono::seconds>(millis_since_epoch);
  const auto millis = millis_since_epoch - seconds_since_epoch;
  const std::time_t time_value = seconds_since_epoch.count();
  const std::tm utc = utc_time(time_value);

  std::ostringstream stream;
  stream << std::put_time(&utc, "%Y-%m-%dT%H:%M:%S") << '.' << std::setw(3)
         << std::setfill('0') << millis.count() << 'Z';
  return stream.str();
}

EdgeWireMessage make_hello_message(const EdgeSessionState& state) {
  return {
      "edge.hello",
      json_object({
          string_field("edgeSessionId", state.edge_session_id),
          string_field("edgeAgentVersion", state.edge_agent_version),
          integer_field("lastSeenCommandSequence",
                        state.last_seen_command_sequence),
      }),
  };
}

CommandAckV1 make_command_ack(
    const CommandEnvelopeV1& command,
    CommandAckStatus status,
    std::string_view received_at,
    std::optional<std::string> reason) {
  return {
      make_local_id("ack"),
      command.command_id,
      command.mission_id,
      command.robot_id,
      status,
      std::string(received_at),
      command.sequence,
      std::move(reason),
      command.correlation_id,
      command.command_id,
  };
}

RobotTelemetryEventV1 make_telemetry_event(
    const EdgeSessionState& state,
    const Pose2D& pose,
    double battery_percent,
    RobotHealthState health,
    RobotConnectionState connection_state,
    std::string_view observed_at,
    std::string_view received_at) {
  validate_pose(pose);
  validate_battery_percent(battery_percent);

  return {
      make_local_id("telemetry"),
      state.robot_id,
      std::string(observed_at),
      std::string(received_at),
      pose,
      battery_percent,
      health,
      connection_state,
      state.current_mission_id,
      state.last_acknowledged_command_id,
      state.last_seen_command_sequence,
      state.edge_agent_version,
  };
}

ReconnectHandshakeV1 make_reconnect_handshake(
    const EdgeSessionState& state,
    std::string_view connected_at,
    std::string_view last_telemetry_observed_at) {
  return {
      state.robot_id,
      state.edge_session_id,
      std::string(connected_at),
      state.last_seen_command_sequence,
      state.last_acknowledged_command_id,
      state.current_mission_id,
      state.reported_mission_lifecycle_state,
      std::string(last_telemetry_observed_at),
      state.edge_agent_version,
  };
}

std::string to_json(const CommandAckV1& message) {
  std::vector<std::string> fields = {
      string_field("schemaVersion", ProtocolSchemaVersions::command_ack),
      string_field("ackId", message.ack_id),
      string_field("commandId", message.command_id),
  };
  if (message.mission_id) {
    fields.push_back(string_field("missionId", *message.mission_id));
  }
  fields.push_back(string_field("robotId", message.robot_id));
  fields.push_back(string_field("status", to_wire_value(message.status)));
  fields.push_back(string_field("receivedAt", message.received_at));
  fields.push_back(integer_field("lastSeenCommandSequence",
                                 message.last_seen_command_sequence));
  if (message.reason) {
    fields.push_back(string_field("reason", *message.reason));
  }
  fields.push_back(string_field("correlationId", message.correlation_id));
  fields.push_back(string_field("causationId", message.causation_id));
  return json_object(fields);
}

std::string to_json(const RobotTelemetryEventV1& message) {
  std::vector<std::string> fields = {
      string_field("schemaVersion", ProtocolSchemaVersions::robot_telemetry),
      string_field("eventId", message.event_id),
      string_field("robotId", message.robot_id),
      string_field("observedAt", message.observed_at),
      string_field("receivedAt", message.received_at),
      json_string("pose") + ":" + pose_json(message.pose),
      number_field("batteryPercent", message.battery_percent),
      string_field("health", to_wire_value(message.health)),
      string_field("connectionState", to_wire_value(message.connection_state)),
  };
  if (message.current_mission_id) {
    fields.push_back(
        string_field("currentMissionId", *message.current_mission_id));
  }
  if (message.last_acknowledged_command_id) {
    fields.push_back(string_field("lastAcknowledgedCommandId",
                                  *message.last_acknowledged_command_id));
  }
  fields.push_back(integer_field("lastSeenCommandSequence",
                                 message.last_seen_command_sequence));
  fields.push_back(string_field("edgeAgentVersion", message.edge_agent_version));
  return json_object(fields);
}

std::string to_json(const ReconnectHandshakeV1& message) {
  std::vector<std::string> fields = {
      string_field("schemaVersion",
                   ProtocolSchemaVersions::reconnect_handshake),
      string_field("robotId", message.robot_id),
      string_field("edgeSessionId", message.edge_session_id),
      string_field("connectedAt", message.connected_at),
      integer_field("lastSeenCommandSequence",
                    message.last_seen_command_sequence),
  };
  if (message.last_acknowledged_command_id) {
    fields.push_back(string_field("lastAcknowledgedCommandId",
                                  *message.last_acknowledged_command_id));
  }
  if (message.reported_mission_id) {
    fields.push_back(
        string_field("reportedMissionId", *message.reported_mission_id));
  }
  if (message.reported_mission_lifecycle_state) {
    fields.push_back(string_field(
        "reportedMissionLifecycleState",
        to_wire_value(*message.reported_mission_lifecycle_state)));
  }
  fields.push_back(
      string_field("lastTelemetryObservedAt", message.last_telemetry_observed_at));
  fields.push_back(string_field("edgeAgentVersion", message.edge_agent_version));
  return json_object(fields);
}

std::string to_json(const EdgeWireMessage& message) {
  return json_object({
      string_field("type", message.type),
      json_string("payload") + ":" + message.payload_json,
  });
}

EdgeWireMessage make_command_ack_wire_message(const CommandAckV1& message) {
  return {"edge.command_ack", to_json(message)};
}

EdgeWireMessage make_telemetry_wire_message(
    const RobotTelemetryEventV1& message) {
  return {"edge.telemetry", to_json(message)};
}

EdgeWireMessage make_reconnect_handshake_wire_message(
    const ReconnectHandshakeV1& message) {
  return {"edge.reconnect_handshake", to_json(message)};
}

}  // namespace roboops::edge_agent
