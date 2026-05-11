# ADR 0002: Mission And Health State Model

## Status

Accepted

## Decision

Separate mission lifecycle, mission operational status, and robot connection state.

```text
MissionLifecycleState: CREATED, DISPATCHED, ACKNOWLEDGED, RUNNING, SUCCEEDED, FAILED, ...
MissionOperationalStatus: NOMINAL, DEGRADED, RECONNECTING, RECONCILING, RECOVERED
RobotConnectionState: ONLINE, STALE, DEGRADED, OFFLINE, RECONNECTING
```

## Context

`DEGRADED` is not a terminal mission state. A mission can still be running while telemetry is stale or while the robot is reconnecting.

## Consequences

- The UI can explain both mission progress and operational risk.
- Reconnect handling can reconcile mission state without blindly failing the mission.
- Domain rules remain clearer and easier to test.

