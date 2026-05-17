# Isaac Launchable Environment

This is the target environment for the first RoboOps Isaac Sim smoke test.

## Compute

Use a Brev Launchable backed by an RTX-capable Linux instance. Prefer the
upstream Isaac Launchable defaults for the first run before customizing GPU,
driver, or disk choices.

Minimum expectations:

| Requirement | Target |
| --- | --- |
| OS | Linux x86_64 managed by the Launchable |
| GPU | RTX-capable NVIDIA GPU with RT cores |
| Runtime | Docker Compose from `isaac-sim/isaac-launchable` |
| Isaac Sim | Upstream Launchable version, currently documented as `5.1` |
| Isaac Lab | Upstream Launchable version, currently documented as `2.3` |
| ROS2 | Use Isaac's bundled bridge; use Humble CLI tools on the Jammy Brev host |

## Workspace Layout

Keep the upstream Launchable and RoboOps as sibling checkouts:

```text
/home/ubuntu/isaac-launchable
/home/ubuntu/RoboOps-Control-Plane
```

## Environment Variables

`sim/isaac-sim/launchable/setup.sh` supports these overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WORKSPACE_DIR` | `$HOME` | Parent directory for checkouts |
| `ISAAC_LAUNCHABLE_REPO` | `https://github.com/isaac-sim/isaac-launchable.git` | Upstream template repo |
| `ISAAC_LAUNCHABLE_DIR` | `$HOME/isaac-launchable` | Upstream checkout path |
| `ROBOOPS_DIR` | `$HOME/RoboOps-Control-Plane` | RoboOps checkout path |
| `ROBOOPS_REPO_URL` | unset | Optional clone URL for this repo |

Do not put tokens, passwords, or private registry credentials in committed
Launchable scripts. Configure secrets through Brev or the shell session.

## Observed Brev Layout

The tested Launchable used two Ubuntu environments:

| Environment | User | OS | Notes |
| --- | --- | --- | --- |
| Brev host over SSH | `ubuntu` | Ubuntu 22.04 Jammy | Has `sudo`; install ROS2 CLI tools here |
| Browser VS Code container | `isaac-sim` | Ubuntu 24.04 Noble | Has Isaac Sim and the bundled bridge, but no `sudo` |

Do not install ROS2 Jazzy packages on the Jammy host. Jazzy packages target
Ubuntu 24.04 and fail with unmet dependencies on the host. Use ROS2 Humble CLI
tools on the host for first DDS/topic inspection, matching the bridge libraries
bundled under `/isaac-sim/exts/isaacsim.ros2.bridge/humble`.

Topic discovery from the Jammy host was validated, but sample delivery was not.
The adapter should eventually run inside the Isaac runtime container or a
Launchable-supported ROS2 sidecar so it shares the runtime assumptions of the
Isaac ROS2 bridge.
