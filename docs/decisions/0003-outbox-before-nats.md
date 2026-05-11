# ADR 0003: Outbox Before NATS

## Status

Accepted

## Decision

Use Postgres plus a transactional outbox before introducing NATS JetStream.

## Context

The first prototype needs durable commands, audit events, and replayable incident history, but it does not need a separate event bus before the vertical demo works.

## Consequences

- Postgres remains the system of record.
- The initial deployment has fewer moving parts.
- Event consumers must be idempotent because outbox processing is at least once.
- NATS JetStream can be added later if replay and stream semantics become valuable.

