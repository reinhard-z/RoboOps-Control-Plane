# ADR 0001: Edge Transport

## Status

Accepted

## Decision

Use separate transports for operator UI updates and robot-edge communication.

```text
Operator UI live updates: SSE first
Edge runtime connection: outbound WebSocket first
```

## Context

The UI only needs server-to-browser updates for the first demo. Robot-edge runtimes need bidirectional flow: commands from the Fleet Platform and acknowledgements, telemetry, and reconnect handshakes from the edge.

## Consequences

- SSE remains simple for dashboard updates.
- Edge agents do not need inbound public ports.
- The edge protocol can later move to gRPC streaming, MQTT, or NATS JetStream without changing the domain model.

