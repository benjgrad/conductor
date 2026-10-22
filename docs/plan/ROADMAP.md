# Roadmap

Three slices from the workshop. Each milestone has a file in `milestones/` once it is planned; only the current one is broken into tasks.

| Milestone | Slice | Status | Exit criteria |
|---|---|---|---|
| [M1 · Single machine](milestones/M1-single-machine.md) | 1 | **complete, pending Ben's sign-off** (2026-10-22) | One daemon on one machine runs a ticket through `implement → build → test → done` (M1 workflow), with a `needs_input` round trip answered from the kanban board, all visible live over SSE. E2E test green. |
| M2 · Fleet | 2 | not planned | ≥ 2 machines; pull scheduler with claim query, short hold, leases, fencing, reaper; daemon disk buffer + seq replay; laptop-sleep chaos test green; daemon enrollment tokens. |
| M3 · Production workflow | 3 | not planned | Full `pr_flow.v1` incl. `open_pr`, `notify`, `await_approval` (webhook + UI approve), connectors with idempotency (ticket, Azure, Jira), budgets enforced, sandboxing where available, ticket webhooks. |
| M4 · Authoring & reach | 3 | not planned | Visual workflow editor emitting the JSON, Slack answering of input requests, triage/plan states with child tickets. |

## Out of scope (until a decision says otherwise)
- Multi-tenancy, sharded schedulers, thousands of machines.
- Central (push) scheduler ([ADR-0001](../adr/0001-pull-scheduler.md)).
- Persisting terminal output history.

## How milestones are planned
See the *Plan* phase in [CLAUDE.md](../../CLAUDE.md). Before a milestone starts, its file is written with tasks, dependencies, parallelism and the unknowns it depends on.
