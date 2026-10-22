# 10 · Contracts (seam index)

M1-T12 froze every cross-agent seam as exported zod schemas / TS interfaces, each with an in-memory fake, so that groups B–D can be built in parallel. **A change to anything listed here is reported to the lead, never made locally** in a task branch ([M1](../plan/milestones/M1-single-machine.md)). Everything in `shared` is exported from `@conductor/shared`. The orchestrator and daemon contracts are exported from their package index.

## Seams

| Seam | File | Producer → consumers | Fake / fixtures |
|---|---|---|---|
| Domain enums (statuses, kinds, columns, badges, output streams), `OUTPUT_TAIL_BYTES` 16 KB, `OUTPUT_RING_BYTES` 256 KB | `shared/src/domain.ts` | — → all | — |
| `WorkflowDefinition`, `parseDuration` ([05](05-workflow-engine.md#definition-schema)) | `shared/src/workflow/schema.ts` | T12 → T03 validator, T04 engine, T08 save/list, T09 detail diagram | `docs/design/workflows/*.json` |
| `SessionSnapshot`, `EngineEvent`, `Effect`, `ApplyResult`, `apply()` stub | `shared/src/engine/types.ts` | T04 (`engine/apply*.ts`) → T04 wrapper, T07 | `SNAPSHOT_FIXTURE` (`engine/fixtures.ts`) |
| Spend accounting `spendDelta` / `applySpend` | `shared/src/engine/spend.ts` | T12 → T04 | unit-tested |
| WS envelope, `DaemonToOrchestrator`, `OrchestratorToDaemon` ([03](03-protocols.md#daemon--orchestrator-websocket)) | `shared/src/protocol/ws.ts` | T05 daemon ⇄ T11 gateway; T04 dispatcher builds commands | `DAEMON_FIXTURES`, `ORCHESTRATOR_FIXTURES`, `SESSION_EVENT_FIXTURES` (`protocol/fixtures.ts`) |
| REST DTOs, `API_PATHS`, `columnFor(status)` ([06](06-human-input.md#kanban-columns-queries-not-state)) | `shared/src/api/rest.ts` | T08 → T09 | — |
| `BoardSseEvent`, `OutputChunk`, `encodeSseFrame` | `shared/src/api/sse.ts` | T08 → T09 | `BOARD_SSE_FIXTURES`, `OUTPUT_CHUNK_FIXTURE` (`api/fixtures.ts`) |
| `EngineService.applyEvent` | `orchestrator/src/contracts.ts` | T04 → T08 (input/cancel/approve), T11 (claim, session_event, acks) | `FakeEngineService` |
| `OutboxTransport` | `orchestrator/src/contracts.ts` | T11 → T04 dispatcher | `FakeOutboxTransport` |
| `BoardBus` | `orchestrator/src/contracts.ts` | T04 (after COMMIT), T11 (badges) → T08 SSE | `InMemoryBoardBus` |
| `OutputBus` (256 KB ring per session, U-005) | `orchestrator/src/contracts.ts` | T11 (WS `output`) → T08 (detail + output SSE) | `InMemoryOutputBus` (also the M1 implementation) |
| DB row types ([02](02-data-model.md)) | `orchestrator/src/db/types.ts` | T02 DDL ⇄ T04, T08, T11 | — |
| `ClaudeDriver` / `DriverSession` / `DriverEvent` ([ADR-0005](../adr/0005-claude-code-driver.md) §Contract, verbatim) | `daemon/src/claude/driver.ts` | T05/T07 real driver → T05 daemon core | `FakeClaudeDriver` (`claude/fake-driver.ts`) |
| `CommandRunner` | `daemon/src/commands/runner.ts` | T06 → T05 | — (interface only) |

## Engine: events in, effects out

`apply(def, snapshot, event, now)` is pure. Ids (`command_id`, `input_request_id`) and `event.id` are assigned by the EngineService wrapper, which writes the event row, the session row and the outbox rows in one transaction, then publishes to the BoardBus.

| EngineEvent | Source |
|---|---|
| `session.assigned {machine_id}` | T11 claim, inside the claim transaction (`applyEvent(..., {tx})`). Enters `def.start` if `workflow_state` is null |
| `session.start_refused {reason}` | T11 on `command_ack accepted=false` for `start_session` |
| `session.started`, `agent.claude_session_id`, `agent.complete_state`, `agent.ask_user`, `agent.exited`, `command.exited`, `spend.reported` | T11 from `session_event` `started`, `claude_session_id`, `complete_state`, `ask_user`, `exit`, `cmd_exit`, `spend` |
| `input.provided {input_request_id, answer, goto?}` | T08 `POST /sessions/:id/input` (`actor` = answered_by) |
| `external.event {name}` | T08 `/approve` (`ui.approve`); connectors later |
| `operator.cancel` | T08 `/cancel` |
| `timer.fired {state, deadline}` | T04 timeout sweep over `session.state_deadline` |
| `budget.exceeded` | nothing in M1 (see defaults) |

`session_event` `build_slot` and `heartbeat` are not engine events: the gateway sets `session.waiting_for_build_slot` + publishes `card.badge`, and renews leases.

| Effect | Outbox kind / target | WS message (orchestrator → daemon) |
|---|---|---|
| `start_session` | `start_session` / `machine:<id>` | `start_session` (+ ticket, repo, base_ref, branch from the DB) |
| `send_input` | `send_input` / `machine:<id>` | `send_input` |
| `run_cmd` | `run_cmd` / `machine:<id>` | `run_cmd` |
| `kill` | `kill` / `machine:<id>` | `kill` |
| `connector_call` | `connector_call` / `connector:<name>` | none (orchestrator-side connectors, not in M1) |
| `create_input_request` | — (INSERT `input_request`) | — → SSE `input.requested` |
| `set_deadline` | — (UPDATE `session.state_deadline`) | — |
| `state_entered` | — (event row `state.entered`) | — |
| `session_status` | — (event row `session.status`) | — → SSE `session.status` (+ `card.moved` when `columnFor` changes) |
| `ticket_status` | — (UPDATE `ticket.status`) | — |

## Defaults recorded here (workshop reconciliation)

- The engine event is **`input.provided`**; the SSE board event is **`input.answered`**. They are distinct on purpose.
- **`waiting_for_build_slot` is a card badge, not a `session.status`.** A session waiting for a build slot stays `running` (Running column) with the badge set (`session_event build_slot` → `session.waiting_for_build_slot` → SSE `card.badge`).
- **`budget.exceeded`** is in the contract and its routing is implemented in T04, but **there is no enforcement trigger in M1** (TD: nothing emits it). The driver's `--max-budget-usd` is the only hard stop in M1.
- **No compute release / `park_release_after` in M1.** A parked `needs_input` session keeps its live process; `send_input` goes to stdin. `command_ack no_live_process` is the hook for the resume path (T07).
- **Validator rule 3 stays "terminal or human"** ([05](05-workflow-engine.md#validation-on-save-m1-t03)).
- **Spend** is cumulative per `claude_session_id`; the last total lives in `session.claude_spend_totals` (jsonb map), and only positive deltas reach `spend_usd`.
- **Tools**: `start_session` carries the workflow's raw `tools` list; the daemon (T05) maps it to the ADR-0005 `ToolPolicy`.
- **Claude session id**: new sessions get it pre-assigned by the daemon (`resume_claude_session_id: null`); the orchestrator learns it from `session_event claude_session_id`.
- `base_ref` is `HEAD` of the shared clone in M1. The output tail for `cmd_exit` / `attach: output` is 16 KB.
- An unclaimed ticket (no session) shows in Queued: `columnFor(null) = 'queued'`, `BoardCard.session_id = null`.
- `ticket.repo_allow_machines` is kept as a nullable `text[]` (null = any machine) ([U-009](../tracking/UNKNOWNS.md)).

## Conventions

- Wire and DB names are snake_case. The ADR-0005 driver contract is camelCase (it's in-process); the daemon snake_cases when forwarding.
- DB row types follow node-postgres defaults (`bigint`/`numeric` → string, `timestamptz` → Date). Engine and API shapes use numbers and ISO-8601 strings.
- Workflow definitions are parsed strictly: unknown keys are errors.
