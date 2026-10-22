# ADR-0002 · Orchestrator is the single decider; daemons dial out

- **Status**: accepted
- **Date**: 2026-10-21 (workshop), recorded 2026-10-22

## Context
Machines are developer laptops behind NAT that sleep, plus a few build servers. Agents are non-deterministic, but we need workflows that are deterministic and auditable.

## Decision
1. Only the orchestrator decides: claims, workflow transitions, retries, budgets, and connector calls.
2. Daemons are reporters and executors. They **dial out** over one persistent WebSocket, so there are no inbound ports, and a missing heartbeat is the liveness signal.
3. Workflow state lives in the orchestrator. The agent works inside a state and signals outcomes through structured tools. It never chooses the next state.

## Alternatives considered
| Option | Why not |
|---|---|
| Orchestrator SSHes into machines | NAT and sleep break it, and it needs inbound access and credentials for every machine |
| Agent drives its own workflow (prompt says "then open a PR…") | Not deterministic, not auditable, and retries and budgets can't be enforced |

## Consequences
- Good: one audit trail, deterministic routing, and it works behind NAT.
- Bad: the orchestrator is a central dependency. Daemons must buffer and replay while it's away.

## Revisit when
We go multi-tenant or need to shard (thousands of machines).
