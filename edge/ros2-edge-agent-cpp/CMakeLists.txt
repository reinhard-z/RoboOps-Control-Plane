cmake_minimum_required(VERSION 3.20)
project(roboops_ros2_edge_agent VERSION 0.1.0 LANGUAGES CXX)

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)

add_library(edge_agent_core
  src/config.cpp
  src/protocol.cpp
)
target_include_directories(edge_agent_core
  PUBLIC
    "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>"
    "$<INSTALL_INTERFACE:include>"
)
target_compile_features(edge_agent_core PUBLIC cxx_std_17)

add_executable(roboops_ros2_edge_agent
  src/main.cpp
)
target_link_libraries(roboops_ros2_edge_agent edge_agent_core)
ament_target_dependencies(roboops_ros2_edge_agent rclcpp)
target_compile_features(roboops_ros2_edge_agent PRIVATE cxx_std_17)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(edge_agent_core PRIVATE -Wall -Wextra -Wpedantic)
  target_compile_options(roboops_ros2_edge_agent PRIVATE -Wall -Wextra -Wpedantic)
endif()

install(DIRECTORY include/
  DESTINATION include
)

install(TARGETS edge_agent_core
  EXPORT export_${PROJECT_NAME}
  ARCHIVE DESTINATION lib
  LIBRARY DESTINATION lib
  RUNTIME DESTINATION bin
)

install(TARGETS roboops_ros2_edge_agent
  RUNTIME DESTINATION lib/${PROJECT_NAME}
)

install(DIRECTORY config launch
  DESTINATION share/${PROJECT_NAME}
)

if(BUILD_TESTING)
  find_package(ament_cmake_gtest REQUIRED)
  ament_add_gtest(config_protocol_smoke test/config_protocol_smoke.cpp)
  target_compile_definitions(config_protocol_smoke PRIVATE ROBOOPS_USE_GTEST=1)
  target_link_libraries(config_protocol_smoke edge_agent_core)
  target_compile_features(config_protocol_smoke PRIVATE cxx_std_17)
endif()

ament_export_include_directories(include)
ament_export_targets(export_${PROJECT_NAME} HAS_LIBRARY_TARGET)
ament_package()
