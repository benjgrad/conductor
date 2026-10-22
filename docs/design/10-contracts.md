# 10 · Contracts (seam index)

M1-T12 froze every cross-agent seam as exported zod schemas / TS interfaces, each with an in-memory fake, so that groups B–D can be built in parallel. **A change to anything listed here is reported to the lead, never made locally** in a task branch ([M1](../plan/milestones/M1-single-machine.md)). Everything in `shared` is exported from `@conductor/shared`. The orchestrator and daemon contracts are exported from their package index.

## Seams

| Seam | File | Producer → consumers | Fake / fixtures |
|---|---|---|---|
| Domain enums (statuses, kinds, columns, badges, output streams), `OUTPUT_TAIL_BYTES` 16 KB, `OUTPUT_RING_BYTES` 256 KB, `sessionBranch()` | `shared/src/domain.ts` | — → all | — |
| `WorkflowDefinition`, `parseDuration` ([05](05-workflow-engine.md#definition-schema)) | `shared/src/workflow/schema.ts` | T12 → T03 validator, T04 engine, T08 save/list, T09 detail diagram | `docs/design/workflows/*.json` |
| `SessionSnapshot`, `EngineEvent`, `Effect`, `ApplyResult`, `apply()` stub | `shared/src/engine/types.ts` | T04 (`engine/apply*.ts`) → T04 wrapper, T07 | `SNAPSHOT_FIXTURE` (`engine/fixtures.ts`) |
| Spend accounting `spendDelta` / `applySpend` | `shared/src/engine/spend.ts` | T12 → T04 | unit-tested |
| WS envelope, `DaemonToOrchestrator`, `OrchestratorToDaemon` ([03](03-protocols.md#daemon--orchestrator-websocket)) | `shared/src/protocol/ws.ts` | T05 daemon ⇄ T11 gateway; T04 dispatcher builds commands | `DAEMON_FIXTURES`, `ORCHESTRATOR_FIXTURES`, `SESSION_EVENT_FIXTURES` (`protocol/fixtures.ts`) |
| REST DTOs, `API_PATHS`, `columnFor(status)` ([06](06-human-input.md#kanban-columns-queries-not-state)) | `shared/src/api/rest.ts` | T08 → T09 | — |
| `BoardSseEvent`, `boardSseEventToRow` / `boardSseEventFromRow`, `OutputChunk` (`api/output.ts`), `encodeSseFrame` | `shared/src/api/sse.ts` | T04, T08, T11 write rows → T08 SSE → T09 | `BOARD_SSE_FIXTURES`, `BOARD_CARD_FIXTURE`, `OUTPUT_CHUNK_FIXTURE` (`api/fixtures.ts`) |
| `EngineService.applyEvent` | `orchestrator/src/contracts.ts` | T04 → T08 (input/cancel/approve), T11 (claim, session_event, acks) | `FakeEngineService` |
| `OutboxTransport` (+ the outbox state machine in its doc comment) | `orchestrator/src/contracts.ts` | T11 → T04 dispatcher | `FakeOutboxTransport` |
| `BoardBus` | `orchestrator/src/contracts.ts` | T04 (after COMMIT), T08 (ticket create), T11 (badges; claim's `boardEvents`) → T08 SSE | `InMemoryBoardBus` |
| `OutputBus` (256 KB ring per session, U-005) | `orchestrator/src/contracts.ts` | T11 (WS `output`) → T08 (detail + output SSE) | `InMemoryOutputBus` (also the M1 implementation) |
| DB row types ([02](02-data-model.md)) | `orchestrator/src/db/types.ts` | T02 DDL ⇄ T04, T08, T11 | — |
| `ClaudeDriver` / `DriverSession` / `DriverEvent` ([ADR-0005](../adr/0005-claude-code-driver.md) §Contract, verbatim) | `daemon/src/claude/driver.ts` | T05/T07 real driver → T05 daemon core | `FakeClaudeDriver` (`claude/fake-driver.ts`) |
| `CommandRunner` | `daemon/src/commands/runner.ts` | T06 → T05 | — (interface only) |

## Engine: events in, effects out

`apply(def, snapshot, event, now)` is pure. Ids (`command_id`, `input_request_id`) and `event.id` are assigned by the EngineService wrapper, which writes the event rows, the session row and the outbox rows in one transaction, then publishes the board events to the BoardBus (or returns them in `boardEvents` for a caller-owned `tx` to publish after its COMMIT).

| EngineEvent | Source |
|---|---|
| `session.assigned {machine_id}` | T11 claim, inside the claim transaction (`applyEvent(..., {tx})`). Accepted only from `queued`: sets `machine_id`, `status = assigned`; enters `def.start` if `workflow_state` is null, else re-emits `start_session` for the current state (resume if `claude_session_id` is set) |
| `command.refused {command_id, command_kind, reason}` | T11 on **every** `command_ack accepted=false`; T04 dispatcher on a `start_session` ack timeout (`ack_timeout`). See [Refusals](#refusals) |
| `session.started {command_id, worktree_path, branch, port_range}`, `agent.claude_session_id`, `agent.complete_state`, `agent.ask_user`, `agent.exited {command_id, code, signal}`, `command.exited`, `spend.reported` | T11 from `session_event` `started`, `claude_session_id`, `complete_state`, `ask_user`, `exit`, `cmd_exit`, `spend` |
| `input.provided {input_request_id, answer, goto?}` | T08 `POST /sessions/:id/input` (`actor` = answered_by) |
| `external.event {name}` | T08 `/approve` (`ui.approve`); connectors later |
| `operator.cancel` | T08 `/cancel` |
| `timer.fired {state, deadline}` | T04 timeout sweep over `session.state_deadline` |
| `budget.exceeded` | nothing in M1 (see defaults) |

`session_event` `build_slot` and `heartbeat` are not engine events: for `build_slot` the gateway, in its own transaction, sets `session.waiting_for_build_slot`, INSERTs the `card.badge` event row and advances `machine.last_seq`, then publishes `card.badge` after COMMIT. `heartbeat` renews leases.

| Effect | Outbox kind / target | WS message (orchestrator → daemon) |
|---|---|---|
| `start_session` | `start_session` / `machine:<id>` | `start_session` (+ ticket, repo, base_ref, branch from the DB) |
| `send_input` | `send_input` / `machine:<id>` | `send_input` |
| `run_cmd` | `run_cmd` / `machine:<id>` | `run_cmd` |
| `kill` | `kill` / `machine:<id>` | `kill` |
| `connector_call` | `connector_call` / `connector:<name>` | none (orchestrator-side connectors, not in M1) |
| `create_input_request` | — (INSERT `input_request`) | — → event row + SSE `input.requested` |
| `set_deadline` | — (UPDATE `session.state_deadline`) | — |
| `state_entered` | — (event row `state.entered`, not a board event) | — → SSE `card.upserted` (card's `workflow_state` changed) |
| `session_status` | — | — → event row + SSE `session.status`, plus a **second** row + SSE `card.moved` when `columnFor` changes |
| `ticket_status` | — (UPDATE `ticket.status`) | — |

## EngineService wrapper

Writes `apply()` can't make (it has no ids and doesn't see these columns), all in the apply transaction (T04):

- Assigns `command_id` / `input_request_id`. For a `start_session` effect it also sets `session.agent_command_id` = that `command_id` and `agent_process_live = false`.
- On a non-ignored `session.started`: `UPDATE session SET worktree_path, branch, port_range = int4range(base, base+count)` (`[base, base+count)`). The gateway does **not** write these.
- On `command.refused` for `start_session`: `session.fencing_token = nextval('fencing_seq')`, so events from a process that command spawned anyway are stale ([Orphaned processes](#orphaned-processes)).
- On `input.provided`: checks the `input_request` is open, records `answer`, `answered_by` (= `opts.actor`), `answered_at`, and writes the `input.answered` board row.
- After the effects: writes one `card.upserted` row (last) if any `BoardCard` field changed (status, column, `workflow_state`, `machine_id`, `spend_usd`, open input request, `updated_at` on any change).

## Board events and the event table

Every `BoardSseEvent` is backed by **exactly one** `event` row: `type` = the SSE `type`, `session_id` = the SSE `session_id`, `payload` = the SSE event minus `{type, id, ts, session_id}`, and the row's `id`/`ts` are the SSE `id`/`ts`. Writers build rows with `boardSseEventToRow(draft)` and decode `INSERT … RETURNING *` with `boardSseEventFromRow(row)`, which T08 also uses for `Last-Event-ID` replay (`WHERE id > $1 AND type = ANY(BOARD_SSE_EVENT_TYPES) ORDER BY id`); it returns null for non-board rows. Engine-event rows (`type` = `EngineEvent.type`) and `state.entered` are audit rows, never replayed to the board.

| SSE event | Written by | When |
|---|---|---|
| `card.upserted` (`session_id` null for a sessionless ticket) | T08 (with the ticket INSERT, same tx); T04 wrapper (see above, incl. the claim's `session.assigned`) | new ticket; any card change |
| `card.moved` | T04 wrapper | `columnFor(status)` changed (own row, separate from `session.status`) |
| `session.status` | T04 wrapper | `session_status` effect |
| `input.requested` | T04 wrapper | `create_input_request` effect |
| `input.answered` | T04 wrapper | `input.provided` applied |
| `card.badge` | T11 gateway, its own tx | `session_event build_slot` |

The client keeps one card per `ticket_id`; `card.upserted` replaces it wholesale. New cards appear only via `card.upserted`, so `card.moved.from` is never null.

## Claim

T11, one transaction ([04](04-scheduler.md#2--claim-query-ticket-side)):

1. Claim query (`FOR UPDATE OF t SKIP LOCKED`), `UPDATE ticket SET status = 'claimed'`.
2. If the ticket already has a non-terminal session (a `queued` one left by a refused `start_session`), `UPDATE` it: new `fencing_token = nextval('fencing_seq')`, new lease. Otherwise `INSERT session` with `status = 'queued'`, `workflow_state = null`, `machine_id = null`, `agent_command_id = null`, `agent_process_live = false`, a new fencing token and lease, `branch = sessionBranch(ticket_id, session_id)` = `` `conductor/${ticket_id}/${session_id.slice(0, 8)}` ``. Never a second session per ticket.
3. `applyEvent(session_id, {type: 'session.assigned', machine_id}, {tx})`: `queued → assigned`, `machine_id` set, `start_session` outbox row (its `branch` is read from `session.branch` by the dispatcher).
4. `COMMIT`, then publish the result's `boardEvents`, then reply `work_assignment`.

## Daemon seq dedupe

`machine.last_seq` (bigint null) is the highest processed daemon `seq`. For every `session_event`, T11 opens a transaction, runs `UPDATE machine SET last_seq = $seq WHERE id = $machine AND (last_seq IS NULL OR last_seq < $seq)`, and on row count 0 (duplicate or replayed) skips the event. Otherwise it applies the event in the same transaction (`applyEvent(..., {tx, fencingToken})`, or the `build_slot` writes) and commits. `registered.last_seq` = `machine.last_seq` (as a number). A fencing rejection still commits the `last_seq` advance (the event was processed, by rejecting it).

## Outbox state machine

`pending → sent → acked | failed`. `acked` and `failed` are terminal. Status writes are partitioned and every UPDATE is guarded, so a fast ack can't be overwritten by the dispatcher:

| Who | Transition | Guarded UPDATE |
|---|---|---|
| T04 dispatcher | `pending`/`sent` → `sent` after `OutboxTransport.send` = `sent` | `SET status='sent', attempts=attempts+1, next_attempt_at=now()+backoff WHERE id=$1 AND status IN ('pending','sent')`; backoff after the n-th send 5, 10, 20, 40, then 60 s. `not_connected` changes nothing |
| T04 dispatcher | picks rows | `status IN ('pending','sent') AND next_attempt_at <= now()` for connected targets. Re-sending `sent` rows is safe (the daemon dedupes on `command_id` and re-acks) |
| T04 dispatcher | `sent` → `failed` (`start_session` ack timeout) | a `start_session` due again with `attempts >= 3` (≈ 35 s): `SET status='failed', last_error='ack_timeout' WHERE id=$1 AND status='sent'`; on row count 1 apply `command.refused {reason: 'ack_timeout'}` in the same tx. The command may still have reached the daemon: see [Orphaned processes](#orphaned-processes) |
| T11 gateway | → `acked` / `failed` on `command_ack` | `SET status = CASE WHEN $accepted THEN 'acked' ELSE 'failed' END, last_error = $reason WHERE command_id=$1 AND status IN ('pending','sent')`; a refusal with row count 1 applies `command.refused` in the same tx. Row count 0 = duplicate or late ack, ignored, **except** an `accepted=true` ack whose row is a `start_session` already `failed`: the gateway sends the orphan kill ([Orphaned processes](#orphaned-processes)) |
| T11 gateway | on `register` | `SET next_attempt_at = now(), attempts = CASE WHEN kind = 'start_session' THEN LEAST(attempts, 2) ELSE attempts END WHERE target = 'machine:<id>' AND status IN ('pending','sent')` (status untouched) so commands are re-sent right after a reconnect, and a `start_session` always gets one more send (the ack timeout then fires ≥ 20 s after the reconnect, not at once) |

## Refusals

`command.refused {command_id, command_kind, reason}` replaces the earlier `session.start_refused`. apply routes it by `command_kind`:

- `start_session` → `status = queued`, `machine_id = null`, **`agent_command_id = null`, `agent_process_live = false`**, ticket `ready` (re-claimable; the claim reuses this session). The wrapper also bumps `session.fencing_token = nextval('fencing_seq')` in the same tx. A refused or timed-out `start_session` may still have spawned a process (late ack); the null `agent_command_id` makes apply ignore its `started`/`exit`, and the bumped token makes every other event from it stale. See [Orphaned processes](#orphaned-processes).
- `send_input` with `no_live_process` → `agent_process_live = false`, then re-answer the open request with `start_session {resume_claude_session_id, prompt = answer}`. Other `send_input` reasons → outcome `fail`.
- `run_cmd` → outcome `fail` (e.g. `memory_pressure`, `unknown_session`).
- `kill` → ignored (logged as the event row).

## Agent process correlation

`session_event started` and `exit` carry the `command_id` of the `start_session` that spawned the process; `started` is emitted **only for `start_session`, never for `run_cmd`** (both reference workflows start with an agent state). The snapshot keeps `agent_command_id` (set by the wrapper on each `start_session`) and `agent_process_live`. apply ignores `session.started` / `agent.exited` whose `command_id` differs from `agent_command_id`, so a late exit of a previous visit's process (e.g. after `implement → build → fail → implement`) can't fail the current visit. A matching `session.started` sets `agent_process_live = true`; a matching `agent.exited` sets it false (outcome `fail` only while `running` without a prior `complete_state`). While `agent_process_live` is false, `input.provided` resumes with `start_session(resume)` instead of `send_input`. An ignored `session.started` (mismatched `command_id`, including `agent_command_id = null`) means a process is running that the session doesn't own: the gateway sends the orphan kill below.

## Orphaned processes

A Claude process whose `start_session` the orchestrator has given up on (ack timeout, or superseded) must be killed; nothing else will, and a re-claim can put a second process on the same worktree. This is the one place the rule lives:

1. **State**: `command.refused` for `start_session` (any reason, including `ack_timeout`) sets `agent_command_id = null`, `agent_process_live = false`, and the wrapper bumps `fencing_token` ([Refusals](#refusals)). The session can't move `queued → running` from the orphan's `started`, and its other events are rejected as stale.
2. **Late accepted ack**: T11, on `command_ack accepted=true` with row count 0, reads the row by `command_id`; if it is a `start_session` with `status = 'failed'`, it sends a direct `kill {command_id: null, target_command_id: <that command_id>, reason: 'ack_timeout'}` to the acking machine (envelope `session_id` = the row's, `fencing_token` = the session's current token). Other row-count-0 acks stay ignored.
3. **Ignored `started`**: when apply ignores a `session.started` for a mismatched `command_id` (`ApplyOutcome` `{status: 'ignored', reason: 'command_id_mismatch'}`), T11 sends a direct `kill {command_id: null, target_command_id: <started.command_id>, reason: 'superseded_start'}` to the sending machine, after the commit. (An ignored `agent.exited` needs no kill: the process is gone.)
4. **Stale fencing**: a `session_event` rejected for its fencing token gets the existing direct `kill {command_id: null, target_command_id: null, reason: 'stale_fencing_token'}` with the *event's* fencing token in the envelope. A `heartbeat` that lists a running session under a token lower than `session.fencing_token` gets the same kill (with the listed token); this is the backstop that needs no further event from the orphan.
5. **Daemon kill rule** (T05, `KillPayloadSchema` in `ws.ts`): with `target_command_id` set, kill only the process spawned by that `start_session` (none live → no-op); with it null, kill the session's process only if its fencing token ≤ the envelope `fencing_token`. So no orphan kill can hit the process of a newer claim of the same session on the same machine.

Kills are direct replies, not outbox rows: if the socket drops before one is written, the orphan's next stale-token event or the next heartbeat after reconnect triggers rule 4.

## Defaults recorded here (workshop reconciliation)

- The engine event is **`input.provided`**; the SSE board event is **`input.answered`**. They are distinct on purpose.
- **`waiting_for_build_slot` is a card badge, not a `session.status`.** A session waiting for a build slot stays `running` (Running column) with the badge set (`session_event build_slot` → `session.waiting_for_build_slot` → SSE `card.badge`).
- **`budget.exceeded`** is in the contract and its routing is implemented in T04, but **there is no enforcement trigger in M1** (TD: nothing emits it). The driver's `--max-budget-usd` is the only hard stop in M1.
- **No compute release / `park_release_after` in M1.** A parked `needs_input` session keeps its live process; `send_input` goes to stdin. If the process is gone (`agent.exited` while parked, or `command.refused` `no_live_process`), apply resumes with `start_session` ([Refusals](#refusals)).
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
