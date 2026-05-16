#include "roboops_ros2_edge_agent/config.hpp"

#include <cstdlib>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace roboops::edge_agent {
namespace {

constexpr std::string_view default_fleet_platform_url = "http://127.0.0.1:4010";
constexpr std::string_view default_robot_id = "robot-a";
constexpr std::string_view default_edge_agent_version =
    "ros2-edge-agent-cpp-0.1.0";

/** Removes surrounding ASCII whitespace from operator-provided config values. */
std::string trim(std::string_view value) {
  const auto begin = value.find_first_not_of(" \t\r\n");
  if (begin == std::string_view::npos) {
    return "";
  }
  const auto end = value.find_last_not_of(" \t\r\n");
  return std::string(value.substr(begin, end - begin + 1));
}

/** Reads the process environment without exposing getenv to the rest of the code. */
std::optional<std::string> read_process_environment(std::string_view name) {
  const std::string key(name);
  const char* value = std::getenv(key.c_str());
  if (value == nullptr) {
    return std::nullopt;
  }
  return std::string(value);
}

/** Finds the URL scheme delimiter and rejects missing schemes early. */
std::size_t find_scheme_end(const std::string& value) {
  const auto scheme_end = value.find("://");
  if (scheme_end == std::string::npos || scheme_end == 0) {
    throw std::invalid_argument("Fleet Platform URL must include http:// or https://");
  }
  return scheme_end;
}

/** Rejects whitespace inside URL authority because it cannot form a valid endpoint. */
bool contains_ascii_whitespace(std::string_view value) {
  return value.find_first_of(" \t\r\n") != std::string_view::npos;
}

/** Validates a URL port without accepting partial numeric input. */
void validate_port(std::string_view port) {
  if (port.empty()) {
    throw std::invalid_argument("Fleet Platform URL port must not be empty");
  }

  int value = 0;
  for (const char ch : port) {
    if (ch < '0' || ch > '9') {
      throw std::invalid_argument("Fleet Platform URL port must be numeric");
    }
    value = value * 10 + (ch - '0');
    if (value > 65535) {
      throw std::invalid_argument("Fleet Platform URL port must be between 1 and 65535");
    }
  }
  if (value == 0) {
    throw std::invalid_argument("Fleet Platform URL port must be between 1 and 65535");
  }
}

/** Validates the authority section while keeping credentials out of logs. */
void validate_authority(std::string_view authority) {
  if (authority.empty()) {
    throw std::invalid_argument("Fleet Platform URL host is required");
  }
  if (contains_ascii_whitespace(authority)) {
    throw std::invalid_argument("Fleet Platform URL host must not contain whitespace");
  }
  if (authority.find('@') != std::string_view::npos) {
    throw std::invalid_argument("Fleet Platform URL must not contain user info or credentials");
  }

  if (authority.front() == '[') {
    const auto close = authority.find(']');
    if (close == std::string_view::npos || close == 1) {
      throw std::invalid_argument("Fleet Platform URL IPv6 host is invalid");
    }
    const auto suffix = authority.substr(close + 1);
    if (suffix.empty()) {
      return;
    }
    if (suffix.front() != ':') {
      throw std::invalid_argument("Fleet Platform URL IPv6 host has an invalid suffix");
    }
    validate_port(suffix.substr(1));
    return;
  }

  const auto first_colon = authority.find(':');
  const auto last_colon = authority.rfind(':');
  if (first_colon != last_colon) {
    throw std::invalid_argument("Fleet Platform URL IPv6 hosts must be bracketed");
  }
  if (last_colon == std::string_view::npos) {
    return;
  }
  if (last_colon == 0) {
    throw std::invalid_argument("Fleet Platform URL host is required");
  }
  validate_port(authority.substr(last_colon + 1));
}

/** Extracts the scheme and authority, matching the simulator's path replacement behavior. */
std::pair<std::string, std::string> split_origin(std::string_view input) {
  const std::string value = trim(input);
  const auto scheme_end = find_scheme_end(value);
  const std::string scheme = value.substr(0, scheme_end);
  if (scheme != "http" && scheme != "https") {
    throw std::invalid_argument("Fleet Platform URL scheme must be http or https");
  }

  const auto authority_begin = scheme_end + 3;
  const auto authority_end = value.find_first_of("/?#", authority_begin);
  const std::string authority =
      authority_end == std::string::npos
          ? value.substr(authority_begin)
          : value.substr(authority_begin, authority_end - authority_begin);
  validate_authority(authority);

  return {scheme, authority};
}

/** Percent-encodes query values without pulling in a broader URL dependency. */
std::string url_encode_query_value(std::string_view value) {
  constexpr char hex[] = "0123456789ABCDEF";
  std::string encoded;
  encoded.reserve(value.size());
  for (const unsigned char ch : value) {
    const bool unreserved =
        (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
        (ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.' ||
        ch == '~';
    if (unreserved) {
      encoded.push_back(static_cast<char>(ch));
      continue;
    }
    encoded.push_back('%');
    encoded.push_back(hex[(ch >> 4) & 0x0F]);
    encoded.push_back(hex[ch & 0x0F]);
  }
  return encoded;
}

/** Returns a readable validation issue when normalization fails. */
std::optional<std::string> validate_fleet_platform_url(std::string_view value) {
  try {
    (void)normalize_fleet_platform_url(value);
    return std::nullopt;
  } catch (const std::invalid_argument& error) {
    return error.what();
  }
}

}  // namespace

bool ConfigLoadResult::ok() const { return issues.empty(); }

AgentConfig default_agent_config() {
  return {
      std::string(default_fleet_platform_url),
      std::string(default_robot_id),
      std::string(default_edge_agent_version),
  };
}

AgentConfig read_config_from_environment() {
  AgentConfig config = default_agent_config();

  if (const auto value = read_process_environment("FLEET_PLATFORM_URL")) {
    config.fleet_platform_url = *value;
  }
  if (const auto value = read_process_environment("ROBOT_ID")) {
    config.robot_id = *value;
  }
  if (const auto value = read_process_environment("EDGE_AGENT_VERSION")) {
    config.edge_agent_version = *value;
  }

  return config;
}

ConfigLoadResult load_config_from_environment() {
  return validate_config(read_config_from_environment());
}

ConfigLoadResult load_config_from_environment(
    const EnvironmentReader& read_env) {
  AgentConfig config = default_agent_config();

  if (const auto value = read_env("FLEET_PLATFORM_URL")) {
    config.fleet_platform_url = *value;
  }
  if (const auto value = read_env("ROBOT_ID")) {
    config.robot_id = *value;
  }
  if (const auto value = read_env("EDGE_AGENT_VERSION")) {
    config.edge_agent_version = *value;
  }

  return validate_config(config);
}

ConfigLoadResult validate_config(const AgentConfig& config) {
  ConfigLoadResult result{config, {}};

  if (const auto issue = validate_fleet_platform_url(config.fleet_platform_url)) {
    result.issues.push_back(*issue);
  } else {
    result.config.fleet_platform_url =
        normalize_fleet_platform_url(config.fleet_platform_url);
  }

  result.config.robot_id = trim(result.config.robot_id);
  if (result.config.robot_id.empty()) {
    result.issues.push_back("ROBOT_ID must not be empty");
  }

  result.config.edge_agent_version = trim(result.config.edge_agent_version);
  if (result.config.edge_agent_version.empty()) {
    result.issues.push_back("EDGE_AGENT_VERSION must not be empty");
  }

  return result;
}

std::string normalize_fleet_platform_url(std::string_view value) {
  const auto [scheme, authority] = split_origin(value);
  return scheme + "://" + authority;
}

std::string create_edge_connect_url(const AgentConfig& config) {
  const auto [scheme, authority] = split_origin(config.fleet_platform_url);
  const std::string websocket_scheme = scheme == "https" ? "wss" : "ws";

  std::ostringstream url;
  url << websocket_scheme << "://" << authority
      << "/edge/connect?robotId=" << url_encode_query_value(config.robot_id);
  return url.str();
}

}  // namespace roboops::edge_agent
