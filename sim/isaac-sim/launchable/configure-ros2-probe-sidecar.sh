#!/usr/bin/env bash
set -euo pipefail

# Installs the Compose override that adds the RoboOps ROS2 probe sidecar.
launchable_dir="${ISAAC_LAUNCHABLE_DIR:-${HOME}/isaac-launchable/isaac-lab}"
roboops_dir="${ROBOOPS_DIR:-${HOME}/RoboOps-Control-Plane}"

if [ ! -f "${launchable_dir}/docker-compose.yml" ]; then
  echo "Isaac Launchable compose file not found at ${launchable_dir}" >&2
  exit 1
fi

if [ ! -f "${roboops_dir}/sim/isaac-sim/scripts/send-odom-telemetry-edge.sh" ]; then
  echo "RoboOps checkout not found at ${roboops_dir}" >&2
  exit 1
fi

cd "${launchable_dir}"

cat > roboops-fastdds.xml <<'FASTDDS'
<?xml version="1.0" encoding="UTF-8" ?>
<profiles xmlns="http://www.eprosima.com/XMLSchemas/fastRTPS_Profiles">
  <transport_descriptors>
    <transport_descriptor>
      <transport_id>UdpTransport</transport_id>
      <type>UDPv4</type>
    </transport_descriptor>
  </transport_descriptors>
  <participant profile_name="udp_transport_profile" is_default_profile="true">
    <rtps>
      <userTransports>
        <transport_id>UdpTransport</transport_id>
      </userTransports>
      <useBuiltinTransports>false</useBuiltinTransports>
    </rtps>
  </participant>
</profiles>
FASTDDS

cat > docker-compose.override.yml <<EOF
services:
  vscode:
    image: isaac-lab-vscode
    ipc: shareable
    volumes:
      - ./roboops-fastdds.xml:/etc/roboops/fastdds.xml:ro
    environment:
      RMW_IMPLEMENTATION: rmw_fastrtps_cpp
      FASTRTPS_DEFAULT_PROFILES_FILE: /etc/roboops/fastdds.xml

  nginx:
    image: isaac-lab-nginx

  ros2-probe:
    image: osrf/ros:humble-desktop
    profiles:
      - probe
    depends_on:
      - vscode
    network_mode: host
    ipc: service:vscode
    volumes:
      - ${roboops_dir}:/roboops:ro
      - ./roboops-fastdds.xml:/etc/roboops/fastdds.xml:ro
    environment:
      RMW_IMPLEMENTATION: rmw_fastrtps_cpp
      FASTRTPS_DEFAULT_PROFILES_FILE: /etc/roboops/fastdds.xml
      ROS2_POSE_TOPIC_CANDIDATES: "/chassis/odom /tf /odom /robot/pose /pose"
      ROS2_PROBE_TIMEOUT_SECONDS: "10"
EOF

docker compose up -d --force-recreate
docker compose config --services | grep -qx "ros2-probe"

echo "ros2-probe sidecar configured in ${launchable_dir}"
