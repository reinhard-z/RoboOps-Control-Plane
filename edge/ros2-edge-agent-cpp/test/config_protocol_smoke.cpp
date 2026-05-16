#include "roboops_ros2_edge_agent/config.hpp"
#include "roboops_ros2_edge_agent/protocol.hpp"

#include <cstdlib>
#include <limits>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

#ifdef ROBOOPS_USE_GTEST
#include <gtest/gtest.h>
#endif

namespace {

using roboops::edge_agent::AgentConfig;
using roboops::edge_agent::CommandAckStatus;
using roboops::edge_agent::CommandEnvelopeV1;
using roboops::edge_agent::CommandType;
using roboops::edge_agent::EdgeSessionState;
using roboops::edge_agent::MissionLifecycleState;
using roboops::edge_agent::Pose2D;
using roboops::edge_agent::RobotConnectionState;
using roboops::edge_agent::RobotHealthState;
using roboops::edge_agent::SafetyClass;

/** Fails the standalone smoke binary without requiring a test framework. */
void require(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

/** Verifies expected defensive exceptions without depending on gtest assertions. */
template <typename Function>
void require_throws(Function function, const char* message) {
  try {
    function();
  } catch (const std::invalid_argument&) {
    return;
  }
  throw std::runtime_error(message);
}

/** Creates a deterministic environment reader for config parsing checks. */
roboops::edge_agent::EnvironmentReader make_env_reader(
    std::map<std::string, std::string> values) {
  return [values = std::move(values)](
             std::string_view name) -> std::optional<std::string> {
    const auto match = values.find(std::string(name));
    if (match == values.end()) {
      return std::nullopt;
    }
    return match->second;
  };
}

/** Verifies URL normalization, query encoding, and required config fields. */
void config_parsing_smoke() {
  const auto parsed = roboops::edge_agent::load_config_from_environment(
      make_env_reader({
          {"FLEET_PLATFORM_URL", "https://fleet.example.test/base/path?x=1"},
          {"ROBOT_ID", "robot a/1"},
          {"EDGE_AGENT_VERSION", "test-agent-0.1.0"},
      }));

  require(parsed.ok(), "expected config to parse");
  require(parsed.config.fleet_platform_url == "https://fleet.example.test",
          "expected URL origin normalization");
  require(roboops::edge_agent::create_edge_connect_url(parsed.config) ==
              "wss://fleet.example.test/edge/connect?robotId=robot%20a%2F1",
          "expected encoded edge connect URL");

  const auto invalid = roboops::edge_agent::validate_config(
      AgentConfig{"file:///tmp/not-cloud", "", ""});
  require(!invalid.ok(), "expected invalid config to report issues");
  require(invalid.issues.size() == 3, "expected all config issues");

  require_throws(
      [] {
        (void)roboops::edge_agent::create_edge_connect_url(
            AgentConfig{"https://token@example.test", "robot-a", "agent"});
      },
      "expected URL credentials to be rejected");
  require_throws(
      [] {
        (void)roboops::edge_agent::create_edge_connect_url(
            AgentConfig{"https://fleet.example.test:bad", "robot-a", "agent"});
      },
      "expected invalid URL port to be rejected");
}

/** Verifies the C++ helpers construct the current Fleet Platform wire shapes. */
void protocol_message_smoke() {
  const std::string observed_at = "2026-05-10T12:00:03.000Z";
  const std::string received_at = "2026-05-10T12:00:04.000Z";
  const EdgeSessionState session{
      "robot-a",
      "edge_session_cpp_smoke",
      "ros2-edge-agent-cpp-0.1.0",
      42,
      std::string("cmd_01JPROTO000000000000000001"),
      std::string("mission_01JPROTO00000000000001"),
      MissionLifecycleState::running,
      observed_at,
  };

  const auto hello_json = roboops::edge_agent::to_json(
      roboops::edge_agent::make_hello_message(session));
  require(hello_json.find("\"type\":\"edge.hello\"") != std::string::npos,
          "expected edge.hello type");
  require(hello_json.find("\"lastSeenCommandSequence\":42") != std::string::npos,
          "expected hello sequence");

  CommandEnvelopeV1 command{
      "cmd_01JPROTO000000000000000001",
      "mission_01JPROTO00000000000001",
      "robot-a",
      CommandType::go_to_pose,
      "operator-123:mission_01JPROTO00000000000001:create",
      42,
      "2026-05-10T12:00:00.000Z",
      "2026-05-10T12:00:10.000Z",
      true,
      SafetyClass::normal,
      "corr_01JPROTO0000000000000001",
      "evt_01JPROTO00000000000000001",
      Pose2D{2.0, 4.5, 1.57},
      std::nullopt,
  };
  const auto ack = roboops::edge_agent::make_command_ack(
      command, CommandAckStatus::accepted, received_at);
  const auto ack_json = roboops::edge_agent::to_json(
      roboops::edge_agent::make_command_ack_wire_message(ack));
  require(ack_json.find("\"type\":\"edge.command_ack\"") != std::string::npos,
          "expected command ack wire type");
  require(ack_json.find("\"schemaVersion\":\"command.ack.v1\"") !=
              std::string::npos,
          "expected command ack schema");
  require(ack_json.find("\"status\":\"ACCEPTED\"") != std::string::npos,
          "expected accepted ack");

  const auto telemetry = roboops::edge_agent::make_telemetry_event(
      session, Pose2D{1.7, 4.1, 1.51}, 71.0, RobotHealthState::ok,
      RobotConnectionState::online, observed_at, received_at);
  const auto telemetry_json = roboops::edge_agent::to_json(
      roboops::edge_agent::make_telemetry_wire_message(telemetry));
  require(telemetry_json.find("\"type\":\"edge.telemetry\"") != std::string::npos,
          "expected telemetry wire type");
  require(telemetry_json.find("\"schemaVersion\":\"robot.telemetry.v1\"") !=
              std::string::npos,
          "expected telemetry schema");
  require(telemetry_json.find("\"batteryPercent\":71") != std::string::npos,
          "expected telemetry battery");
  require_throws(
      [&] {
        (void)roboops::edge_agent::make_telemetry_event(
            session,
            Pose2D{std::numeric_limits<double>::quiet_NaN(), 4.1, 1.51},
            71.0, RobotHealthState::ok, RobotConnectionState::online,
            observed_at, received_at);
      },
      "expected non-finite pose to be rejected");
  require_throws(
      [&] {
        (void)roboops::edge_agent::make_telemetry_event(
            session, Pose2D{1.7, 4.1, 1.51}, 101.0, RobotHealthState::ok,
            RobotConnectionState::online, observed_at, received_at);
      },
      "expected out-of-range battery to be rejected");

  const auto reconnect = roboops::edge_agent::make_reconnect_handshake(
      session, "2026-05-10T12:01:30.000Z", "2026-05-10T12:01:29.000Z");
  const auto reconnect_json = roboops::edge_agent::to_json(
      roboops::edge_agent::make_reconnect_handshake_wire_message(reconnect));
  require(reconnect_json.find("\"type\":\"edge.reconnect_handshake\"") !=
              std::string::npos,
          "expected reconnect wire type");
  require(reconnect_json.find("\"schemaVersion\":\"reconnect.handshake.v1\"") !=
              std::string::npos,
          "expected reconnect schema");
  require(reconnect_json.find("\"reportedMissionLifecycleState\":\"RUNNING\"") !=
              std::string::npos,
          "expected reported mission state");
}

}  // namespace

#ifdef ROBOOPS_USE_GTEST
TEST(RoboOpsRos2EdgeAgent, ConfigParsingSmoke) { config_parsing_smoke(); }

TEST(RoboOpsRos2EdgeAgent, ProtocolMessageSmoke) { protocol_message_smoke(); }
#else
int main() {
  config_parsing_smoke();
  protocol_message_smoke();
  return EXIT_SUCCESS;
}
#endif
