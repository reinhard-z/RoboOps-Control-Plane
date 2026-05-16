#pragma once

#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace roboops::edge_agent {

/** Runtime settings that identify the robot-near edge process to Fleet Platform. */
struct AgentConfig {
  std::string fleet_platform_url;
  std::string robot_id;
  std::string edge_agent_version;
};

/** Validation-aware config result so CLI startup can report all issues at once. */
struct ConfigLoadResult {
  AgentConfig config;
  std::vector<std::string> issues;

  /** Returns true when the loaded config is ready to use. */
  [[nodiscard]] bool ok() const;
};

/** Small seam that lets tests supply environment variables without mutating the process. */
using EnvironmentReader =
    std::function<std::optional<std::string>(std::string_view name)>;

/** Returns local-demo defaults that keep committed files free of secrets. */
[[nodiscard]] AgentConfig default_agent_config();

/** Reads environment-backed values without validating so ROS parameters can override them. */
[[nodiscard]] AgentConfig read_config_from_environment();

/** Reads FLEET_PLATFORM_URL, ROBOT_ID, and EDGE_AGENT_VERSION from the process env. */
[[nodiscard]] ConfigLoadResult load_config_from_environment();

/** Reads config from a caller-supplied environment source and validates it. */
[[nodiscard]] ConfigLoadResult load_config_from_environment(
    const EnvironmentReader& read_env);

/** Validates config values without reading process state. */
[[nodiscard]] ConfigLoadResult validate_config(const AgentConfig& config);

/** Builds the Fleet Platform edge WebSocket URL without changing the cloud protocol. */
[[nodiscard]] std::string create_edge_connect_url(const AgentConfig& config);

/** Normalizes the platform URL to its HTTP(S) origin for stable WebSocket joins. */
[[nodiscard]] std::string normalize_fleet_platform_url(std::string_view value);

}  // namespace roboops::edge_agent
