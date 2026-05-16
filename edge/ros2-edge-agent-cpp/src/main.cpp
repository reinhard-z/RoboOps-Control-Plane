#include "roboops_ros2_edge_agent/config.hpp"
#include "roboops_ros2_edge_agent/protocol.hpp"

#include <rclcpp/rclcpp.hpp>

#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace {

/** Applies ROS parameter overrides after environment-backed defaults are loaded. */
roboops::edge_agent::AgentConfig read_ros_config(
    const std::shared_ptr<rclcpp::Node>& node,
    const roboops::edge_agent::AgentConfig& defaults) {
  node->declare_parameter<std::string>("fleet_platform_url",
                                       defaults.fleet_platform_url);
  node->declare_parameter<std::string>("robot_id", defaults.robot_id);
  node->declare_parameter<std::string>("edge_agent_version",
                                       defaults.edge_agent_version);

  return {
      node->get_parameter("fleet_platform_url").as_string(),
      node->get_parameter("robot_id").as_string(),
      node->get_parameter("edge_agent_version").as_string(),
  };
}

/** Logs config validation failures in a compact startup-friendly format. */
void log_config_issues(const rclcpp::Logger& logger,
                       const std::vector<std::string>& issues) {
  for (const auto& issue : issues) {
    RCLCPP_ERROR(logger, "config error: %s", issue.c_str());
  }
}

}  // namespace

int main(int argc, char* argv[]) {
  rclcpp::init(argc, argv);
  const auto node = rclcpp::Node::make_shared("roboops_ros2_edge_agent");
  const auto logger = node->get_logger();

  const auto parameter_config =
      read_ros_config(node, roboops::edge_agent::read_config_from_environment());
  const auto config_result =
      roboops::edge_agent::validate_config(parameter_config);
  if (!config_result.ok()) {
    log_config_issues(logger, config_result.issues);
    rclcpp::shutdown();
    return 2;
  }

  const auto config = config_result.config;
  const auto edge_connect_url =
      roboops::edge_agent::create_edge_connect_url(config);
  const auto now = roboops::edge_agent::now_iso_utc();
  const roboops::edge_agent::EdgeSessionState session{
      config.robot_id,
      roboops::edge_agent::make_local_id("edge_session"),
      config.edge_agent_version,
      0,
      std::nullopt,
      std::nullopt,
      std::nullopt,
      now,
  };
  const auto hello = roboops::edge_agent::to_json(
      roboops::edge_agent::make_hello_message(session));

  RCLCPP_INFO(logger, "starting RoboOps ROS2 edge agent skeleton");
  RCLCPP_INFO(logger, "robot_id=%s edge_agent_version=%s",
              config.robot_id.c_str(), config.edge_agent_version.c_str());
  RCLCPP_INFO(logger, "intended outbound Fleet Platform WebSocket: %s",
              edge_connect_url.c_str());
  RCLCPP_INFO(logger,
              "cloud contract remains Fleet Platform /edge/connect; no "
              "cloud-to-ROS2/DDS bridge is started");
  RCLCPP_INFO(logger, "sample edge.hello message: %s", hello.c_str());

  rclcpp::shutdown();
  return 0;
}
