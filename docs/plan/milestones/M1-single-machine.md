# M1 · Single machine (slice 1)

**Goal**: one daemon on one machine runs a ticket through [`m1_basic.v1`](../../design/workflows/m1_basic.v1.json) (`implement → build → test → done`), with a `needs_input` round trip answered from the kanban board, all live over SSE.

**Exit criteria**: M1-T10 E2E test is green locally (`pnpm test:e2e`); every task below is `done` and has passed QA ([QA_CHECKLIST](../../qa/QA_CHECKLIST.md)); STATUS updated.

**Not in M1**: scheduler scoring/short hold, leases/fencing/reaper (stub: single machine, session never "lost"), disk buffering + seq replay, connectors, PR/Slack/approval states, budgets enforcement beyond retry caps, auth (localhost only).

**Blocking unknowns**: [U-001](../../tracking/UNKNOWNS.md), [U-002](../../tracking/UNKNOWNS.md) must be resolved (spike → ADR) before T05/T07. [U-003](../../tracking/UNKNOWNS.md) defaults to manual ticket entry for M1.

## Task board

Status values: `todo` · `in_progress` · `in_review` (QA) · `done` · `blocked` (link B-###).

| ID | Task | Depends on | Parallel group | Status | Branch / owner |
|---|---|---|---|---|---|
| M1-T00 | Spike: drive Claude Code from a daemon; resolve U-001 + U-002 → ADR-0005 | — | A | todo | |
| M1-T01 | Monorepo scaffold | — | A | todo | |
| M1-T02 | DB schema + migrations | T01 | B | todo | |
| M1-T03 | Workflow schema + validator (`shared`) | T01 | B | todo | |
| M1-T04 | FSM `apply()` + transactional apply w/ outbox | T02, T03 | C | todo | |
| M1-T05 | Daemon core: WS register/heartbeat, worktree, spawn Claude Code, stream events | T00, T01 | B | todo | |
| M1-T06 | Command states in daemon (build/test, semaphore, exit outcomes) | T05 | C | todo | |
| M1-T07 | `complete_state` / `ask_user` plumbing end to end | T00, T04, T05 | D | todo | |
| M1-T08 | Orchestrator REST + SSE board feed (Last-Event-ID replay) + output stream | T02, T04 | C | todo | |
| M1-T09 | Web kanban (columns, needs-input card, detail panel, answer box) | T01 (mock API), T08 for wiring | B→D | todo | |
| M1-T10 | E2E: happy path + needs_input round trip (fake & real Claude modes) | all | E | todo | |

Groups run in order A → B → C → D → E. Tasks within a group can be given to parallel implementer agents (see [CLAUDE.md](../../../CLAUDE.md) › Orchestrate).

---

## Task details

### M1-T00 · Spike: driving Claude Code
- **Scope**: throwaway script in `spikes/claude-driver/` (not shipped). Try headless `claude -p --output-format stream-json` with `--resume`, and the Claude Agent SDK. Find: how to get the session id, how to inject a structured `complete_state` / `ask_user` tool (MCP server exposed by the daemon vs. parsing), how to deliver an answer mid-session (stdin vs resume with new message), how to read cost/usage, how to restrict tools.
- **Acceptance**: ADR-0005 written and accepted by Ben; U-001, U-002 marked resolved with links; any limits found filed as U-### or TD-###.

### M1-T01 · Monorepo scaffold
- **Scope**: pnpm workspace per [ADR-0004](../../adr/0004-typescript-monorepo.md); `packages/{shared,orchestrator,daemon,web}`; strict tsconfig base; eslint + prettier; vitest workspace; `docker-compose.yml` with Postgres 16; root scripts `build`, `test`, `lint`, `typecheck`, `db:up`, `db:migrate`, `test:e2e`; minimal CI script `scripts/ci.sh` running all gates.
- **Acceptance**: `pnpm i && pnpm build && pnpm lint && pnpm typecheck && pnpm test` all pass on a clean clone; `pnpm db:up` starts Postgres; CLAUDE.md Commands section verified/updated.

### M1-T02 · DB schema + migrations
- **Scope**: tables from [02-data-model](../../design/02-data-model.md) incl. `outbox`, enums, indexes for `ticket(status, priority)`, `session(status)`, `input_request(session_id) WHERE answer IS NULL`, `event(session_id, id)`. Decide `repo_allow_machines` ([U-009](../../tracking/UNKNOWNS.md)).
- **Acceptance**: migrate up/down on empty DB; integration test inserts one row per table; 02-data-model updated to match actual DDL.

### M1-T03 · Workflow schema + validator
- **Scope**: zod schema for the definition in [05](../../design/05-workflow-engine.md); validator implementing all six rules in *Validation on save*.
- **Acceptance**: both reference workflows validate; table-driven tests with ≥1 failing fixture per rule (unreachable state, dead end, unbudgeted loop, bad `$ref`, missing target, release_machine w/o timeout).

### M1-T04 · FSM engine
- **Scope**: pure `apply(session, event) → {session, effects}` in `shared` covering agent/command/human/terminal types, retry counters, `attach: output`, `needs_input` with `return_to`, budget-exceeded routing; orchestrator wrapper doing the single-transaction write (event + session + outbox) and an outbox dispatcher.
- **Acceptance**: unit tests enumerate every transition in `m1_basic` and `pr_flow` agent/command parts; property test: no event sequence leaves a session in an undefined state; integration test: crash after commit before send → dispatcher re-sends on restart.

### M1-T05 · Daemon core
- **Scope**: config (orchestrator URL, root dir, budgets); WS client with reconnect/backoff; `register`, `heartbeat` (live cpu/mem/disk), `repo_inventory`; on `start_session` create worktree + per-session branch from shared clone, allocate port range, spawn Claude Code per ADR-0005, forward `output` and `session_event`s; `kill`; dedupe `command_id`.
- **Acceptance**: integration test with a fake orchestrator WS; a real-mode manual check documented in the task's QA notes.

### M1-T06 · Command states
- **Scope**: `run_cmd` in worktree with timeout, build semaphore (`max_concurrent_builds`), `waiting_for_build_slot` event, output capture (tail N KB attached to outcome for `attach: output`).
- **Acceptance**: tests for exit 0, non-zero, timeout, semaphore queueing with 3 concurrent requests and limit 2.

### M1-T07 · complete_state / ask_user plumbing
- **Scope**: per ADR-0005, the agent-facing tools; daemon → `session_event`; orchestrator → engine; answer path `send_input` back into the live session, and resume path if process is gone.
- **Acceptance**: integration test: agent asks, input_request row created, answer posted via REST, agent receives it and continues.

### M1-T08 · Orchestrator API + SSE
- **Scope**: REST from [03](../../design/03-protocols.md) needed for M1 (board, session detail, input, tickets create, workflows list/save); SSE board stream with Last-Event-ID replay; per-session output stream with ring buffer.
- **Acceptance**: API tests; SSE reconnect test proves no missed events.

### M1-T09 · Web kanban
- **Scope**: Vite + React; columns per [06](../../design/06-human-input.md#kanban-columns-queries-not-state); needs-input cards sorted oldest first with question badge; detail panel (state, output, input box); create-ticket form. Build against a mock API first, wire to T08.
- **Acceptance**: component tests for column mapping + answer flow; manual check screenshot in QA notes.

### M1-T10 · E2E
- **Scope**: `pnpm test:e2e` boots Postgres, orchestrator, one daemon, and a **fake Claude** (scripted binary obeying ADR-0005 contract) against a fixture repo whose build/test can be made to fail; scenarios: happy path; test fails twice then passes; agent asks a question, test answers via REST. Optional `E2E_REAL_CLAUDE=1` mode.
- **Acceptance**: all scenarios green; runtime < 3 min in fake mode.
