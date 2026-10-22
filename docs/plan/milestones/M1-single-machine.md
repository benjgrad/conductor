# M1 · Single machine (slice 1)

**Goal**: one daemon on one machine runs a ticket through [`m1_basic.v1`](../../design/workflows/m1_basic.v1.json) (`implement → build → test → done`), with a `needs_input` round trip answered from the kanban board, all live over SSE.

**Exit criteria**: M1-T10 E2E test is green locally (`pnpm test:e2e`); every task below is `done` and has passed QA ([QA_CHECKLIST](../../qa/QA_CHECKLIST.md)); STATUS updated.

**Not in M1**: scheduler scoring/short hold, leases/fencing/reaper (stub: single machine, session never "lost"), disk buffering + seq replay, connectors, PR/Slack/approval states, budget enforcement triggers (the `budget.exceeded` routing exists in the engine, but nothing fires it in M1), compute release of parked sessions, auth (localhost only).

**Blocking unknowns**: [U-001](../../tracking/UNKNOWNS.md), [U-002](../../tracking/UNKNOWNS.md) must be resolved (spike → ADR) before T05/T07. [U-003](../../tracking/UNKNOWNS.md) defaults to manual ticket entry for M1.

## Task board

Status values: `todo` · `in_progress` · `in_review` (QA) · `done` · `blocked` (link B-###).

| ID | Task | Depends on | Parallel group | Status | Branch / owner |
|---|---|---|---|---|---|
| M1-T00 | Spike: drive Claude Code from a daemon; resolve U-001 + U-002 → ADR-0005 | — | A | done | `m1-t00-claude-driver-spike` @ a903c5a, merged to main (QA: PASS WITH DEBT). ADR-0005 accepted by Ben 2026-10-22 |
| M1-T01 | Monorepo scaffold | — | A | done | `m1-t01-scaffold` @ 8c05d14, merged to main (QA: PASS WITH DEBT) |
| M1-T12 | **Contracts**: shared zod/TS interfaces + fakes for every seam (see below) | T00, T01 | A2 | in_progress | `m1-t12-contracts` |
| M1-T13 | Toolchain: Node 22 + current tool majors (U-019, TD-005); shared Postgres cluster with a DB per worktree/test run (U-020); `DATABASE_URL` loading for vitest + orchestrator (U-021) | T01 | A2 | in_progress | `m1-t13-toolchain` |
| M1-T02 | DB schema + migrations | T12 | B | todo | |
| M1-T03 | Workflow validator (`shared`; schema itself is in T12) | T12 | B | todo | |
| M1-T05 | Daemon core: WS register/heartbeat, worktree, spawn Claude Code (real driver per ADR-0005), stream events | T12 | B | todo | |
| M1-T09 | Web kanban vs mock API (columns, needs-input card, detail panel, answer box). Wiring is T09b | T12 | B | todo | |
| M1-T04 | FSM `apply()` + transactional apply w/ outbox + outbox dispatcher + timeout sweep + prompt render | T02, T03 | C | todo | |
| M1-T06 | Command states in daemon (build/test, semaphore, exit outcomes) | T05 | C | todo | |
| M1-T08 | Orchestrator REST + SSE board feed (Last-Event-ID replay) + output stream | T02 (+ `EngineService` fake) | C | todo | |
| M1-T11 | **Orchestrator daemon gateway**: WS server, register/heartbeat → `machine`, `request_work` → single-machine FIFO claim, `command_ack`, outbox transport, `session_event` → engine | T02 (+ `EngineService` fake) | C | todo | |
| M1-T07 | `complete_state` / `ask_user` plumbing end to end | T04, T05, T11 | D | todo | |
| M1-T09b | Wire web to the real API | T08, T09 | D | todo | |
| M1-T10 | E2E: happy path + needs_input round trip (fake & real Claude modes) | all | E | todo | |

Groups run in order A → A2 → B → C → D → E. Tasks within a group own disjoint files and are given to parallel implementer agents (see [CLAUDE.md](../../../CLAUDE.md) › Orchestrate). Groups B–D code against the T12 contracts and their fakes; a needed contract change is reported, not made locally.

**Gates (Ben)**: after A, accept ADR-0005. After A2, review `docs/design/10-contracts.md`, which freezes the interfaces.

---

## Task details

### M1-T00 · Spike: driving Claude Code
- **Scope**: throwaway script in `spikes/claude-driver/` (not shipped). Try headless `claude -p --output-format stream-json` with `--resume`, and the Claude Agent SDK. Find: how to get the session id, how to inject a structured `complete_state` / `ask_user` tool (MCP server exposed by the daemon vs. parsing), how to deliver an answer mid-session (stdin vs resume with new message), how to read cost/usage, how to restrict tools.
- **Hard requirement** (workshop, PDF p.13): while waiting for an answer the Claude process stays alive but idle, and the daemon feeds the answer **into the live process**. A one-shot `claude -p` that can only `--resume` doesn't satisfy this on its own. Resume is the fallback for when the process is gone.
- **Acceptance**: ADR-0005 written and accepted by Ben. It covers the `ClaudeDriver` shape T12 will pin: start, the session-id event, output stream, `complete_state` / `ask_user` delivery, live answer injection, spend, kill, and the tool allow-list. U-001, U-002 marked resolved with links. Any limits found are filed as U-### or TD-###. The spike scripts show each mechanism working against the real CLI/SDK.

### M1-T13 · Toolchain
- **Scope**:
  - **Node 22**: `.nvmrc` (22), `engines.node >=22`, and `.npmrc` `use-node-version=22.22.0`, so pnpm scripts run Node 22 even when the shell's PATH has Node 20.
  - Bump vitest, vite, @vitejs/plugin-react, eslint (+ typescript-eslint) and typescript to current stable majors; remove the pnpm override (TD-005).
  - **DB (U-020)**: `db:up` starts ONE shared cluster on 54329 (idempotent: no-op if already running, from any worktree; data dir in a stable location outside worktrees, e.g. `~/.local/share/conductor/pgdata`).
  - A test helper (`packages/orchestrator/test/db.ts` or a shared vitest setup) creates a uniquely named database per test run/worktree, runs migrations into it, and drops it afterwards.
  - **U-021**: one documented way for vitest and the orchestrator to get `DATABASE_URL`; fix the CLAUDE.md claim.
- **Files owned**: root package.json, `.nvmrc`, `.npmrc`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `packages/*/package.json`, eslint/vitest/vite configs, `scripts/**`, `packages/orchestrator/test/**` (DB helper only), `.env.example`, and the CLAUDE.md Commands/toolchain lines. **Not** `packages/*/src/**` (T12 owns those in parallel).
- **Acceptance**:
  - `pnpm exec node -v` prints v22.
  - `scripts/ci.sh` is green on a clean `pnpm i`.
  - Two worktrees can run `pnpm db:up` and DB tests at the same time without colliding: a demo test creates, uses and drops its own DB.
  - TD-005 closed.

### M1-T12 · Contracts
- **Scope**: freeze every cross-agent seam as exported zod schemas / TS interfaces, each with an in-memory fake, before the parallel groups start. Files (only this task creates them):
  - `packages/shared/src/workflow/schema.ts`: `WorkflowDefinition` per [05](../../design/05-workflow-engine.md#definition-schema), plus `parseDuration`.
  - `packages/shared/src/engine/types.ts`: `SessionSnapshot`, `EngineEvent` union, `Effect` union, `ApplyResult`, and the `apply(def, snapshot, event, now)` signature (a stub that throws).
  - `packages/shared/src/protocol/ws.ts`: the envelope, plus the `DaemonToOrchestrator` / `OrchestratorToDaemon` unions with a concrete payload for every message in [03](../../design/03-protocols.md#daemon--orchestrator-websocket) and one fixture per type.
  - `packages/shared/src/api/{rest,sse}.ts`: board/session/answer/ticket DTOs, `BoardSseEvent`, `OutputChunk`, and `columnFor(status)` per [06](../../design/06-human-input.md#kanban-columns-queries-not-state).
  - `packages/orchestrator/src/contracts.ts`: `EngineService`, `OutboxTransport`, `BoardBus`, `OutputBus` (256 KB ring, U-005), plus fakes.
  - `packages/orchestrator/src/db/types.ts`: row types for [02](../../design/02-data-model.md) plus the new session columns `return_to`, `state_visits`, `state_entered_at`, `state_deadline`, and the nullable `ticket.repo_allow_machines` (resolves U-009).
  - `packages/daemon/src/claude/driver.ts`: the `ClaudeDriver` / `DriverSession` / `DriverEvent` shape from ADR-0005, plus a scripted `FakeClaudeDriver`.
  - `packages/daemon/src/commands/runner.ts`: the `CommandRunner` interface only.
  - `docs/design/10-contracts.md`: a one-page index of seams, producers and consumers, with the defaults below. Update 02-data-model for the new columns.
- **Defaults to record in 10-contracts** (from the workshop reconciliation):
  - The engine event is `input.provided`; the SSE board event is `input.answered`. They are distinct on purpose.
  - `waiting_for_build_slot` is a card badge, not a `session.status`.
  - `budget.exceeded` is in the contract and its routing is implemented in T04, but **no enforcement trigger in M1** (TD).
  - No compute release / `park_release_after` in M1.
  - Validator rule 3 stays "terminal or human".
- **Acceptance**:
  - Every WS and SSE fixture round-trips through its schema.
  - Both reference workflows parse with `WorkflowDefinition`.
  - The fakes have smoke tests.
  - The gates are green.
  - The interface-review agent finds that T02–T11 can each be built from the contracts plus fakes alone.
  - Ben approves 10-contracts.

### M1-T11 · Orchestrator daemon gateway
- **Scope**:
  - `packages/orchestrator/src/gateway/**`: a WS server, envelope validation, `register` (upsert `machine`), `heartbeat` (update live resources), `repo_inventory` (upsert `machine_repo`).
  - `request_work` → a minimal claim: FIFO by priority/age, tags filter, `FOR UPDATE SKIP LOCKED`, no scoring/short-hold. The claim inserts the session, bumps the fencing token and writes the `start_session` outbox row in one transaction.
  - `command_ack` handling. A refusal returns the ticket to `ready`.
  - `OutboxTransport` implementation over live sockets.
  - `session_event` → `EngineService.applyEvent`.
  - `output` → `OutputBus`.
  - Dedupe on `(machine_id, seq)`.
- **Acceptance**: integration tests with a fake daemon WS client against real Postgres: register → request_work → `work_assignment` and `start_session` delivered; a refused ack requeues; a duplicate seq is ignored; a stale fencing token is rejected with `kill`.

### M1-T01 · Monorepo scaffold
- **Scope**: pnpm workspace per [ADR-0004](../../adr/0004-typescript-monorepo.md); `packages/{shared,orchestrator,daemon,web}`; strict tsconfig base; eslint + prettier; vitest workspace; `docker-compose.yml` with Postgres 16; root scripts `build`, `test`, `lint`, `typecheck`, `db:up`, `db:migrate`, `test:e2e`; minimal CI script `scripts/ci.sh` running all gates. **No Docker runtime on Ben's Mac**: `db:up`/`db:down` use docker-compose if `docker info` succeeds. Otherwise they run Homebrew `postgresql@16` (`/opt/homebrew/opt/postgresql@16/bin`, `initdb` into a gitignored `.pgdata/`, port 54329). Tests and migrations read `DATABASE_URL` (documented in `.env.example`). Pin `packageManager: pnpm@10.x`.
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
