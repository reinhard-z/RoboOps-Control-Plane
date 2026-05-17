# Isaac Launchable Ports

Use Brev secure links for browser access and keep raw streaming ports restricted
to your IP whenever the UI allows it.

## Secure Link

| Name | Port | Purpose |
| --- | ---: | --- |
| `isaac` | `80/tcp` | Browser VS Code and `/viewer` route from the upstream Launchable |

## Streaming Ports

| Port | Protocol | Purpose |
| ---: | --- | --- |
| `1024` | TCP | Isaac Launchable streaming support |
| `47998` | UDP | Kit App Streaming media path |
| `49100` | TCP | Kit App Streaming control path |

Open only one viewer tab at a time. The upstream template is designed for a
single streamed Isaac Sim UI session.

## RoboOps Connectivity

For the first smoke test, keep Fleet Platform on the Mac or hosted demo stack
and let the edge adapter connect outbound:

```text
Brev Isaac runtime -> outbound WebSocket -> Fleet Platform /edge/connect
```

Do not expose ROS2/DDS, Isaac internals, or the edge adapter as public inbound
services.
