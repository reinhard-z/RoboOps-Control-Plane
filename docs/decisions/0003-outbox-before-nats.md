# ADR 0003: Outbox Before NATS

## Status

Accepted

## Decision

Use Postgres plus a transactional outbox instead of adding a separate event bus.

## Context

The prototype needs durable commands, audit events, and replayable incident history, but it does not need a separate event bus for the vertical demo.

## Consequences

- Postgres remains the system of record.
- The initial deployment has fewer moving parts.
- Event consumers must be idempotent because outbox processing is at least once.
- A separate event bus is outside the current portfolio scope.
