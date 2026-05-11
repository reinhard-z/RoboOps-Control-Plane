# Current Architecture

Snapshot date: 2026-05-11.

The important thing to know: the runtime apps are mostly placeholders right now. The real implemented core is:

- `packages/fleet-protocol`: shared message contracts and JSON Schema objects.
- `packages/fleet-domain`: pure domain state machine.
- `packages/test-support`: fake clock/test helpers.
- Phase 1 tests proving the incident path without API, DB, UI, or simulator.

## What Exists Today

Read this as the current working code, not the final product.

```mermaid
flowchart LR
  subgraph Implemented["Implemented now"]
    Tests["Phase 1 tests<br/>prove behavior"]
    Domain["fleet-domain<br/>pure reducers"]
    Protocol["fleet-protocol<br/>contracts + schemas"]
    Tests --> Domain
    Tests --> Protocol
    Domain --> Protocol
  end

  subgraph Placeholders["Scaffolded for later phases"]
    Platform["fleet-platform"]
    UI["operator-ui"]
    Simulator["cloud-edge-simulator"]
    Persistence["fleet-persistence"]
    Worker["event-worker"]
    Observability["observability"]
  end
```

At the moment, the domain tests are the executable demo. The app boxes exist so Phase 2 has somewhere to land.

## Phase 2 Target

Read this as the next architecture to build.

```mermaid
flowchart LR
  Operator["Operator"] --> UI["Operator UI"]
  UI -->|"REST<br/>create/read missions"| API["Fleet Platform API"]
  API -->|"SSE<br/>live updates"| UI

  API --> Domain["fleet-domain<br/>business rules"]
  Domain -->|"DomainTransition"| API
  API --> Store["In-memory state<br/>Phase 2"]

  API -->|"WebSocket<br/>commands"| Edge["Cloud Edge Simulator"]
  Edge -->|"acks, telemetry,<br/>reconnect handshakes"| API

  API --> Protocol["fleet-protocol<br/>validate payloads"]
  Edge --> Protocol
  UI --> Protocol
```

Phase 2 should make `apps/fleet-platform` the coordinator. It should expose HTTP/SSE/WebSocket edges, but keep mission decisions inside `fleet-domain`.

## Mission Incident Flow

Read this as the story the demo needs to show.

```mermaid
flowchart TB
  Request["Operator requests mission"] --> Dispatch["dispatchMissionCommand"]
  Dispatch --> Dispatched["Mission DISPATCHED<br/>command created"]

  Dispatched --> Ack["applyCommandAck"]
  Ack --> Running["Mission RUNNING"]

  Running --> Telemetry["ingestRobotTelemetry"]
  Telemetry --> Fresh["Telemetry fresh<br/>mission NOMINAL"]

  Fresh --> StaleCheck["evaluateTelemetryFreshness"]
  StaleCheck --> Degraded["Robot DEGRADED<br/>mission still RUNNING"]

  Degraded --> Blocked["New risky commands<br/>are safety-blocked"]
  Degraded --> ReconnectStart["beginReconnect"]

  ReconnectStart --> Reconnecting["Robot RECONNECTING<br/>mission RECONNECTING"]
  Reconnecting --> Handshake["processReconnectHandshake"]
  Handshake --> Recovered["Recovered<br/>mission RUNNING"]
  Handshake --> ManualReview["Conflict<br/>MANUAL_REVIEW"]
```

The key modeling point is that stale telemetry changes operational risk. It does not automatically fail the mission lifecycle.

## Domain Package Shape

Read this as file ownership inside `packages/fleet-domain/src`.

```mermaid
flowchart TB
  Barrel["index.ts<br/>public exports"]

  State["state.ts<br/>DomainState, snapshots"]
  Reducers["Reducer modules<br/>dispatch, ack,<br/>telemetry, reconnect"]
  Helpers["Shared helpers<br/>events, policies, time"]

  Barrel --> State
  Barrel --> Reducers
  Reducers --> State
  Reducers --> Helpers
  Helpers --> Protocol["fleet-protocol<br/>types + versions"]
  State --> Protocol
```

Use the barrel for app code:

```ts
import {
  createInitialDomainState,
  dispatchMissionCommand,
  applyCommandAck,
  ingestRobotTelemetry,
  evaluateTelemetryFreshness,
  beginReconnect,
  processReconnectHandshake
} from "@roboops/fleet-domain";
```

Only domain modules should import helper files like `events.ts`, `policies.ts`, or `time.ts` directly.

## Phase 2 Build Notes

- Start in `apps/fleet-platform`; it is still a placeholder.
- Keep a single in-memory `DomainState` behind small repository/service functions.
- Validate incoming command, telemetry, ack, and reconnect payloads using `fleet-protocol`.
- Call `fleet-domain` reducers for state changes.
- Publish reducer-produced `domainEvents` and `auditEvents` to API responses/SSE.
- Keep command delivery separate from UI streaming:
  - REST for operator commands and reads
  - SSE for browser live updates
  - WebSocket for edge commands, acks, telemetry, and reconnect handshakes
