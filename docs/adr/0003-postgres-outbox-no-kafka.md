# ADR-0003 · Postgres + transactional outbox; no message broker on day one

- **Status**: accepted
- **Date**: 2026-10-21 (workshop), recorded 2026-10-22

## Context
~200 sessions emit up to ~2k events/s at peak, mostly terminal output. Durable state transitions run < 100 writes/s.

## Decision
- Postgres is the system of record.
- The engine writes the event, the session update and the outgoing commands (`outbox`) in **one transaction**. A dispatcher delivers outbox rows (at least once, deduped by `command_id`).
- Raw terminal output is **not** persisted in Postgres. It goes through an in-memory broadcaster with a bounded ring buffer per session ([U-005](../tracking/UNKNOWNS.md)).
- No Kafka, Redis or NATS in v1.

## Consequences
- Good: one dependency, exactly-once state changes, simple local dev (docker-compose).
- Bad: output history is lost on orchestrator restart, and there's a single-node fan-out limit.

## Revisit when
We need more than one orchestrator serving SSE output, or need durable output history. Then add Redis Streams or NATS.
