# 00 · Overview

> Source: design workshop, 2026-10-21 (transcript + Excalidraw board). This doc is the source of truth from now on; the board is not.

## Problem

Run Claude Code autonomously across a fleet of machines. A central **orchestrator** picks up tickets and finds a machine that can work each one. The choice depends on hardware headroom, the agents already running there, and the repos already checked out. Claude Code sessions run on client machines that **subscribe** to the orchestrator. A **web UI kanban board** shows every session. When an agent needs a human, its card moves to a *needs input* column. The user answers there and the agent continues.

Users design a **finite-state-machine workflow** that guides each ticket: implement, build, test, plan/break down, open a PR, notify, wait for approval, update external systems.

## Scale assumptions (agreed)

| Dimension | Assumption |
|---|---|
| Tenancy | One organization |
| Machines | ~50 (mostly dev workstations behind NAT that sleep, plus a few build servers) |
| Concurrent sessions | up to ~200 |
| Session lifetime | minutes to hours, mostly blocked on model or human |
| Event rate | ~2k events/s peak (mostly terminal output) |
| Durable writes | < 100/s (state transitions) |
| Ticket sources | Jira / Linear / GitHub Issues via webhook (v1: see [U-003](../tracking/UNKNOWNS.md)) |

From these numbers, one Postgres instance is enough as the system of record. A light pub/sub covers live streaming. No Kafka on day one ([ADR-0003](../adr/0003-postgres-outbox-no-kafka.md)).

## Principles

1. **The orchestrator is the single decider.** Everything else reports or executes ([ADR-0002](../adr/0002-orchestrator-single-decider.md)).
2. **Daemons dial out.** No inbound ports. A missed heartbeat *is* the liveness signal.
3. **Postgres holds the truth.** A state change and the commands it emits commit in one transaction (outbox).
4. **Transitions fire on outcomes, not on the model's say-so.** Exit codes, structured tool results, external events. An agent may name one of the transitions its prompt offers ([ADR-0011](../adr/0011-transition-rules.md)); the engine checks the name, the ticket's kind and the transition's requirements (checks, review, actions, conditions) before the ticket moves.
5. **Workflow state lives in the orchestrator, not in the agent.** The agent works *inside* a state.
6. **Human input is just another state.** Kanban columns are the workflow's states ([ADR-0010](../adr/0010-one-workflow-columns-are-states.md)); a card's column is derived from its session, never stored by the UI.
7. **Every failure path ends at a human.** Retries are bounded. Budgets and timeouts route to `needs_input`.
8. **Start simple.** Pull-based scheduler first ([ADR-0001](../adr/0001-pull-scheduler.md)); add central scoring only when placement quality visibly hurts.

## Design index

| Doc | Covers |
|---|---|
| [01-architecture](01-architecture.md) | Components and how they connect |
| [02-data-model](02-data-model.md) | Tables and relationships |
| [03-protocols](03-protocols.md) | UI API, daemon stream, idempotency |
| [04-scheduler](04-scheduler.md) | Pull model, claim query, leases, fencing |
| [05-workflow-engine](05-workflow-engine.md) | Workflow JSON, engine, outbox, validation |
| [06-human-input](06-human-input.md) | ask_user → kanban → answer → resume |
| [07-multi-session-isolation](07-multi-session-isolation.md) | Many agents on one machine |
| [08-failure-modes](08-failure-modes.md) | Laptop sleep, crashes, side effects |
| [09-security-and-budgets](09-security-and-budgets.md) | Permissions, sandboxing, secrets, spend |
| [workflows/conductor.v2.json](workflows/conductor.v2.json) | The one workflow, v2 (ADR-0011): rules on named transitions |
| [workflows/conductor.v3.json](workflows/conductor.v3.json) | The one workflow, current default (ADR-0025): v2 with green PR CI required before review and longer state timeouts; seeded on startup, and an unedited v1 or v2 is upgraded to it |
| [workflows/conductor.v1.json](workflows/conductor.v1.json) | The one workflow's first version (ADR-0010); its states are the board columns. Old tickets still pin it |
| [workflows/pr_flow.v1.json](workflows/pr_flow.v1.json) | Reference workflow from the workshop |

## Delivery slices

See [ROADMAP](../plan/ROADMAP.md). In short: (1) one machine, one workflow, the kanban board. (2) A multi-machine pull scheduler with leases and reconnect replay. (3) Connectors, budgets, sandboxing, the visual editor.
