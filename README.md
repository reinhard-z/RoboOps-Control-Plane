# RoboOps Control Plane

A cloud-to-edge robot fleet operations platform prototype for dispatching, supervising, reconciling, and auditing missions for intermittently connected ROS 2 robots.

The first milestone is a local incident demo:

```text
operator creates mission
-> command is dispatched
-> edge acknowledges command
-> telemetry becomes stale
-> robot becomes degraded
-> reconnect handshake happens
-> mission is reconciled
-> audit log explains the incident
```

## Development

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Current Status

This repository has been initialized as a pnpm monorepo. The first implementation slice should focus on `packages/fleet-protocol`, `packages/fleet-domain`, and `packages/test-support`.
