from launch import LaunchDescription
from launch_ros.actions import Node


def generate_launch_description():
    """Launches the skeleton as a one-shot ROS2 node for local wiring checks."""
    return LaunchDescription(
        [
            Node(
                package="roboops_ros2_edge_agent",
                executable="roboops_ros2_edge_agent",
                name="roboops_ros2_edge_agent",
                output="screen",
            )
        ]
    )
