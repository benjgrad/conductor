# 10 · Contracts (seam index)

M1-T12 froze every cross-agent seam as exported zod schemas / TS interfaces, each with an in-memory fake, so that groups B–D can be built in parallel. **A change to anything listed here is reported to the lead, never made locally** in a task branch ([M1](../plan/milestones/M1-single-machine.md)). Everything in `shared` is exported from `@conductor/shared`. The orchestrator and daemon contracts are exported from their package index.

## Seams

| Seam | File | Producer → consumers | Fake / fixtures |
|---|---|---|---|
| Domain enums (statuses, kinds, columns, badges, output streams), `OUTPUT_TAIL_BYTES` 16 KB, `OUTPUT_RING_BYTES` 256 KB, `sessionBranch()` | `shared/src/domain.ts` | — → all | — |
| `WorkflowDefinition`, `parseDuration` ([05](05-workflow-engine.md#definition-schema)) | `shared/src/workflow/schema.ts` | T12 → T03 validator, T04 engine, T08 save/list, T09 detail diagram | `docs/design/workflows/*.json` |
| `GuardRegistry`, `GUARD_REGISTRY` (empty in M1), `isRegisteredGuard`, `evaluateGuard` ([Guards](#guards)) | `shared/src/workflow/guards.ts` | T12 → T04 (evaluate on `complete_state`) | unit-tested |
| `TOOL_ALIASES`, `resolveToolPolicy` ([Tools](#tools)) | `shared/src/workflow/tools.ts` | T12 → T03 (unknown names), T05 (→ `DriverStartOptions.tools`) | unit-tested against both reference workflows |
| `SessionSnapshot` (incl. `pending_answer`), `EngineEvent`, `Effect`, `ApplyResult`, `APPLY_IGNORE_REASONS`, `APPLY_REJECT_REASONS`, `apply()` stub | `shared/src/engine/types.ts` | T04 (`engine/apply*.ts`) → T04 wrapper, T07, T08/T11 (reasons) | `SNAPSHOT_FIXTURE` (`engine/fixtures.ts`) |
| `renderPrompt`, `TICKET_TEMPLATE`, `NO_OUTCOME_QUESTION` ([Prompt render](#prompt-render)) | `shared/src/engine/render.ts`, `engine/apply.ts` | T04a → apply (the only prompt renderer, U-040) | unit-tested |
| `commandPayloadForEffect`, `M1_BASE_REF` ([Effect → WS](#effect--ws-fields)) | `shared/src/protocol/commands.ts` | T12 → T04 wrapper (outbox payload) | unit-tested; payloads parse as WS commands |
| Spend accounting `spendDelta` / `applySpend` | `shared/src/engine/spend.ts` | T12 → T04 | unit-tested |
| WS envelope, `DaemonToOrchestrator`, `OrchestratorToDaemon`, `NO_OUTCOME_OUTPUT_CHARS` ([03](03-protocols.md#daemon--orchestrator-websocket)) | `shared/src/protocol/ws.ts` | T05 daemon ⇄ T11 gateway; T04 dispatcher builds commands | `DAEMON_FIXTURES`, `ORCHESTRATOR_FIXTURES`, `SESSION_EVENT_FIXTURES` (`protocol/fixtures.ts`) |
| REST DTOs, `API_PATHS` (incl. `daemonWs`), `CONDUCTOR_PORT` / `conductorPort()`, `columnFor(status)` ([06](06-human-input.md#kanban-columns-queries-not-state)), `ApproveSessionRequest`, `httpForApplyResult` ([REST error map](#rest-error-map)) | `shared/src/api/rest.ts` | T08 → T09; T05 (WS URL), T07 (port) | — |
| `toBoardCard(ticket, session, openInput)`, `toInputRequestDto` (the one card derivation) | `shared/src/api/rest.ts` | T12 → T04 (`card.upserted`), T08 (board, ticket create), T09b | `BOARD_CARD_FIXTURE` = `toBoardCard(ticket, null, null)` |
| `BoardSseEvent`, `boardSseEventToRow` / `boardSseEventFromRow`, `OutputChunk` (`api/output.ts`), `encodeSseFrame` | `shared/src/api/sse.ts` | T04, T08, T11 write rows → T08 SSE → T09 | `BOARD_SSE_FIXTURES`, `BOARD_CARD_FIXTURE`, `OUTPUT_CHUNK_FIXTURE` (`api/fixtures.ts`) |
| `EngineService.applyEvent` | `orchestrator/src/contracts.ts` | T04 → T08 (input/cancel/approve), T11 (claim, session_event, acks) | `FakeEngineService` (`seed`, `respond`, `respondWith`) |
| `OutboxTransport` (+ the outbox state machine in its doc comment), `commandEnvelopeForOutboxRow` | `orchestrator/src/contracts.ts` | T11 → T04 dispatcher | `FakeOutboxTransport` |
| `insertBoardEvents(tx, drafts)`, `BOARD_EVENT_LOCK_KEY` ([Board events](#board-events-and-the-event-table)) | `orchestrator/src/contracts.ts` | T12 → T04, T08, T11 (the only board-row writer) | tested with a recording `Queryable` |
| Composition root: `CreateDb`, `CreateEngineService`, `CreateGateway`, `CreateApi`, `composeOrchestrator` ([Composition root](#composition-root)) | `orchestrator/src/main.ts` | T04 / T11 / T08 each implement one factory → T07 wires `main()` | wiring test with fake factories |
| `BoardBus` | `orchestrator/src/contracts.ts` | T04 (after COMMIT), T08 (ticket create), T11 (badges; claim's `boardEvents`) → T08 SSE | `InMemoryBoardBus` |
| `OutputBus` (256 KB ring per session, U-005) | `orchestrator/src/contracts.ts` | T11 (WS `output`) → T08 (detail + output SSE) | `InMemoryOutputBus` (also the M1 implementation) |
| DB row types ([02](02-data-model.md)) | `orchestrator/src/db/types.ts` | T02 DDL ⇄ T04, T08, T11 | — |
| `ClaudeDriver` / `DriverSession` / `DriverEvent` ([ADR-0005](../adr/0005-claude-code-driver.md) §Contract, verbatim) | `daemon/src/claude/driver.ts` | T05/T07 real driver → T05 daemon core | `FakeClaudeDriver` (`claude/fake-driver.ts`) |
| `CommandRunner`, `CreateCommandRunner` | `daemon/src/commands/runner.ts`; factory `createCommandRunner` in `daemon/src/commands/index.ts` (the real `ProcessCommandRunner`, T06) | T06 → T05 | `FakeCommandRunner` (`commands/fake-runner.ts`) |

## Engine: events in, effects out

`apply(def, snapshot, event, now)` is pure. Ids (`command_id`, `input_request_id`) and `event.id` are assigned by the EngineService wrapper, which writes the event rows, the session row and the outbox rows in one transaction, then publishes the board events to the BoardBus (or returns them in `boardEvents` for a caller-owned `tx` to publish after its COMMIT).

| EngineEvent | Source |
|---|---|
| `session.assigned {machine_id}` | T11 claim, inside the claim transaction (`applyEvent(..., {tx})`). Accepted only from `queued`: sets `machine_id`; enters `def.start` if `workflow_state` is null, else re-emits the current state's command (`start_session` resumes if `claude_session_id` is set, with `prompt = pending_answer.answer` when set). Into an **agent** state: `status = assigned` + `start_session` (`running` comes with `session.started`). Into a **command** state: `status = running` + `run_cmd` directly, since `run_cmd` has no `started` ([U-024](../tracking/UNKNOWNS.md)) |
| `command.refused {command_id, command_kind, reason}` | T11 on **every** `command_ack accepted=false`; T04 dispatcher on a `start_session` ack timeout (`ack_timeout`). See [Refusals](#refusals) (incl. the [U-025](../tracking/UNKNOWNS.md) ignore rule) |
| `session.started {command_id, worktree_path, branch, port_range}`, `agent.claude_session_id`, `agent.complete_state`, `agent.ask_user`, `agent.no_outcome {last_output}`, `agent.exited {command_id, code, signal}`, `command.exited`, `spend.reported` | T11 from `session_event` `started`, `claude_session_id`, `complete_state`, `ask_user`, `no_outcome`, `exit`, `cmd_exit`, `spend`. `agent.no_outcome` ([U-028](../tracking/UNKNOWNS.md), [ADR-0005 addendum](../adr/0005-claude-code-driver.md#addendum-2026-10-22-turns-without-an-outcome-u-028)) is routed exactly like `agent.ask_user` with the question `NO_OUTCOME_QUESTION` ("Agent stopped without reporting an outcome; last output attached") followed by `\n\nLast output:\n<last_output>` when there is output |
| `input.provided {input_request_id, answer, goto?}` | T08 `POST /sessions/:id/input` (`actor` = answered_by) |
| `external.event {name}` | T08 `/approve` (`ui.approve`); connectors later |
| `operator.cancel` | T08 `/cancel` |
| `timer.fired {state, deadline}` | T04 timeout sweep over `session.state_deadline` |
| `budget.exceeded` | nothing in M1 (see defaults) |

`session_event` `build_slot` and `heartbeat` are not engine events: for `build_slot` the gateway, in its own transaction, sets `session.waiting_for_build_slot`, INSERTs the `card.badge` event row and advances `machine.last_seq`, then publishes `card.badge` after COMMIT. `heartbeat` renews leases.

| Effect | Outbox kind / target | WS message (orchestrator → daemon) |
|---|---|---|
| `start_session` | `start_session` / `machine:<id>` | `start_session` (+ ticket, repo, base_ref, branch, env; [fields](#effect--ws-fields)) |
| `send_input` | `send_input` / `machine:<id>` | `send_input` |
| `run_cmd` | `run_cmd` / `machine:<id>` | `run_cmd` |
| `kill` | `kill` / `machine:<id>` | `kill` with `target_command_id: null` |
| `connector_call` | `connector_call` / `connector:<name>` | none (orchestrator-side connectors, not in M1) |
| `create_input_request` | — (INSERT `input_request`) | — → event row + SSE `input.requested` |
| `set_deadline` | — (UPDATE `session.state_deadline`) | — |
| `state_entered` | — (event row `state.entered`, not a board event) | — → SSE `card.upserted` (card's `workflow_state` changed) |
| `session_status` | — | — → event row + SSE `session.status`, plus a **second** row + SSE `card.moved` when `columnFor` changes |
| `ticket_status` | — (UPDATE `ticket.status`) | — |

## EngineService wrapper

Writes `apply()` can't make (it has no ids and doesn't see these columns), all in the apply transaction (T04):

- Assigns `command_id` / `input_request_id`. For a `start_session` effect it also sets `session.agent_command_id` = that `command_id` and `agent_process_live = false`.
- Builds each outbox row with `commandPayloadForEffect(effect, {command_id, snapshot, branch: session.branch})`: `outbox.kind`, `target`, `payload` (the WS payload verbatim) and `outbox.fencing_token` = the session's token after this apply ([Effect → WS](#effect--ws-fields)). It never renders or rewrites a prompt ([Prompt render](#prompt-render)).
- On a non-ignored `session.started`: `UPDATE session SET worktree_path, branch, port_range = int4range(base, base+count)` (`[base, base+count)`). The gateway does **not** write these.
- On `command.refused` for `start_session` that apply did **not** ignore: `session.fencing_token = nextval('fencing_seq')`, so events from a process that command spawned anyway are stale ([Orphaned processes](#orphaned-processes)). An ignored refusal (U-025 rule) bumps nothing.
- On `input.provided`: checks the `input_request` is open, records `answer`, `answered_by` (= `opts.actor`), `answered_at`, and writes the `input.answered` board row.
- After the effects: writes one `card.upserted` row (last) if any `BoardCard` field changed (status, column, `workflow_state`, `machine_id`, `spend_usd`, open input request, `updated_at` on any change). The card is `toBoardCard(ticket, session, openInput)`. It carries the open input request only while the session is `needs_input`: a cancel leaves the row unanswered, but the card drops it (TD-079).
- Writes every board row through `insertBoardEvents(tx, drafts)`, as the last write of the transaction.

## Board events and the event table

**One writer path.** T04, T08 and T11 write board rows only through `insertBoardEvents(tx, drafts)` (`orchestrator/src/contracts.ts`). It takes `pg_advisory_xact_lock(BOARD_EVENT_LOCK_KEY)` before the first INSERT and holds it to COMMIT, so board-writing transactions commit in `event.id` order and a `Last-Event-ID` replay (`id > $1`) can't skip a lower id that commits later. Call it last in the transaction to keep the lock short; publish the returned events after COMMIT. Engine audit rows don't take the lock (they are never replayed).

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

T11, one transaction ([04](04-scheduler.md#2--claim-query-ticket-side)). The partial unique index `session_one_live_per_ticket` ([02](02-data-model.md#session)) enforces step 2's "never a second session":

1. Claim query (`FOR UPDATE OF t SKIP LOCKED`), `UPDATE ticket SET status = 'claimed'`.
2. If the ticket already has a non-terminal session (a `queued` one left by a refused `start_session`), `UPDATE` it: new `fencing_token = nextval('fencing_seq')`, new lease. Otherwise `INSERT session` with `status = 'queued'`, `workflow_state = null`, `machine_id = null`, `agent_command_id = null`, `agent_process_live = false`, a new fencing token and lease, `branch = sessionBranch(ticket_id, session_id)` = `` `conductor/${ticket_id}/${session_id.slice(0, 8)}` ``. Never a second session per ticket.
3. `applyEvent(session_id, {type: 'session.assigned', machine_id}, {tx})`: `queued → assigned`, `machine_id` set, `start_session` outbox row (its `branch` is read from `session.branch` by the dispatcher).
4. `COMMIT`, then publish the result's `boardEvents`, then reply `work_assignment`.

## Daemon seq dedupe

`machine.last_seq` (bigint null) is the highest processed daemon `seq`. For every `session_event`, T11 opens a transaction, runs `UPDATE machine SET last_seq = $seq WHERE id = $machine AND (last_seq IS NULL OR last_seq < $seq)`, and on row count 0 (duplicate or replayed) skips the event. Otherwise it applies the event in the same transaction (`applyEvent(..., {tx, fencingToken})`, or the `build_slot` writes) and commits. `registered.last_seq` = `machine.last_seq` (as a number). A fencing rejection still commits the `last_seq` advance (the event was processed, by rejecting it).

**Daemon side (T05).** The daemon persists its last assigned `seq` locally. After every `registered`, the next `seq` it assigns is `max(local persisted seq + 1, registered.last_seq + 1)` (with `registered.last_seq = null` counting as -1). So a daemon whose local state was lost or is behind the orchestrator never reuses a `seq` the orchestrator has already seen (which would silently drop the event as a duplicate). It replays its buffered events with `seq > registered.last_seq`, in order, before new ones.

## Gateway details (T11)

Choices the gateway makes beyond the rules above ([03](03-protocols.md#daemon--orchestrator-websocket)):

- `register` upserts `machine` (`status = online`, facts, `claude_code_version`) and makes this machine's open outbox rows due now ([Outbox](#outbox-state-machine)); `registered.heartbeat_interval_ms` defaults to **10 s**. A second connection for the same machine id replaces the first (closed with 4000), and the replaced socket's close does not mark the machine offline.
- A daemon socket close marks its machine `offline` (after its queued frames are handled).
- `heartbeat` stores `cpu_free` as `floor()` (int column), renews the leases of the sessions it lists under their current token on this machine, and kills those listed under a lower token ([Orphaned processes](#orphaned-processes) rule 4). A `session_event heartbeat` renews that session's lease.
- `command_ack` UPDATEs only the row with that `command_id` **and** `target = machine:<acking machine>`.
- The `superseded_start` kill (Orphaned processes rule 3) carries the session's current fencing token in its envelope.

## Outbox state machine

`pending → sent → acked | failed`. `acked` and `failed` are terminal. Status writes are partitioned and every UPDATE is guarded, so a fast ack can't be overwritten by the dispatcher. **Every UPDATE that makes a `start_session` row terminal also sets `payload.prompt` to JSON `null`** (`SCRUBBED_PAYLOAD_SQL`, `orchestrator/src/engine/outbox.ts`; other payload fields kept): the prompt can carry the `attach: output` tail, and a terminal row is never sent again (a requeue renders a new prompt from the session) ([U-039](../tracking/UNKNOWNS.md)).

| Who | Transition | Guarded UPDATE |
|---|---|---|
| T04 dispatcher | `pending`/`sent` → `sent` after `OutboxTransport.send` = `sent` | `SET status='sent', attempts=attempts+1, next_attempt_at=now()+backoff WHERE id=$1 AND status IN ('pending','sent')`; backoff after the n-th send 5, 10, 20, 40, then 60 s. `not_connected` changes nothing |
| T04 dispatcher | picks rows | `status IN ('pending','sent') AND next_attempt_at <= now()` for connected targets. Re-sending `sent` rows is safe (the daemon dedupes on `command_id` and re-acks) |
| T04 dispatcher | `sent` → `failed` (`start_session` ack timeout) | a `start_session` due again with `attempts >= 3` (≈ 35 s): `SET status='failed', last_error='ack_timeout' WHERE id=$1 AND status='sent'`; on row count 1 apply `command.refused {reason: 'ack_timeout'}` in the same tx. The command may still have reached the daemon: see [Orphaned processes](#orphaned-processes) |
| T11 gateway | → `acked` / `failed` on `command_ack` | `SET status = CASE WHEN $accepted THEN 'acked' ELSE 'failed' END, last_error = $reason WHERE command_id=$1 AND status IN ('pending','sent')`; a refusal with row count 1 applies `command.refused` in the same tx. Row count 0 = duplicate or late ack, ignored, **except** an `accepted=true` ack whose row is a `start_session` already `failed` and whose `command_id` is not `session.agent_command_id`: the gateway sends the orphan kill ([Orphaned processes](#orphaned-processes)) |
| T04 dispatcher | stale row → `failed` | a picked row with `fencing_token` < the session's current token is not sent: `SET status='failed', last_error='stale_fencing_token' WHERE id=$1 AND status IN ('pending','sent')`. No engine event (the token moved because the session was re-claimed or its start refused) |
| T11 gateway | on `register` | `SET next_attempt_at = now(), attempts = CASE WHEN kind = 'start_session' THEN LEAST(attempts, 2) ELSE attempts END WHERE target = 'machine:<id>' AND status IN ('pending','sent')` (status untouched) so commands are re-sent right after a reconnect, and a `start_session` always gets one more send (the ack timeout then fires ≥ 20 s after the reconnect, not at once) |

## Refusals

`command.refused {command_id, command_kind, reason}` replaces the earlier `session.start_refused`. apply routes it by `command_kind`:

- **U-025**: a `start_session` refusal is ignored (`command_id_mismatch`) unless `command_id == agent_command_id` **and** `agent_process_live = false`. A refusal for a superseded command, or one that arrives after its `started` (the process is up; only the ack was lost, then the ack timeout fired), changes nothing, and the wrapper doesn't bump the token.
- `start_session` → `status = queued`, `machine_id = null`, **`agent_command_id = null`, `agent_process_live = false`**, ticket `ready` (re-claimable; the claim reuses this session). The wrapper also bumps `session.fencing_token = nextval('fencing_seq')` in the same tx. A refused or timed-out `start_session` may still have spawned a process (late ack); the null `agent_command_id` makes apply ignore its `started`/`exit`, and the bumped token makes every other event from it stale. See [Orphaned processes](#orphaned-processes).
- `send_input` with `no_live_process` → `agent_process_live = false`, then re-answer with `start_session {resume_claude_session_id, prompt = pending_answer.answer}` ([Pending answer](#pending-answer)). Other `send_input` reasons → outcome `fail`.
- `run_cmd` → outcome `fail` (e.g. `memory_pressure`, `unknown_session`).
- `kill` → ignored (`kill_refused`; logged as the event row).

## Agent process correlation

`session_event started` and `exit` carry the `command_id` of the `start_session` that spawned the process; `started` is emitted **only for `start_session`, never for `run_cmd`** (both reference workflows start with an agent state). The snapshot keeps `agent_command_id` (set by the wrapper on each `start_session`) and `agent_process_live`. apply ignores `session.started` / `agent.exited` whose `command_id` differs from `agent_command_id`, so a late exit of a previous visit's process (e.g. after `implement → build → fail → implement`) can't fail the current visit. A matching `session.started` sets `agent_process_live = true`; a matching `agent.exited` sets it false (outcome `fail` only while `running` without a prior `complete_state`). While `agent_process_live` is false, `input.provided` resumes with `start_session(resume)` instead of `send_input`. An ignored `session.started` (mismatched `command_id`, including `agent_command_id = null`) means a process is running that the session doesn't own: the gateway sends the orphan kill below.

## Orphaned processes

A Claude process whose `start_session` the orchestrator has given up on (ack timeout, or superseded) must be killed; nothing else will, and a re-claim can put a second process on the same worktree. This is the one place the rule lives:

1. **State**: `command.refused` for `start_session` (any reason, including `ack_timeout`) sets `agent_command_id = null`, `agent_process_live = false`, and the wrapper bumps `fencing_token` ([Refusals](#refusals)). The session can't move `queued → running` from the orphan's `started`, and its other events are rejected as stale.
2. **Late accepted ack**: T11, on `command_ack accepted=true` with row count 0, reads the row by `command_id`; if it is a `start_session` with `status = 'failed'` and `session.agent_command_id` is not that `command_id` (if it still is, the refusal was ignored because `started` came first, so the process is owned), it sends a direct `kill {command_id: null, target_command_id: <that command_id>, reason: 'ack_timeout'}` to the acking machine (envelope `session_id` = the row's, `fencing_token` = the session's current token). Other row-count-0 acks stay ignored.
3. **Ignored `started`**: when apply ignores a `session.started` for a mismatched `command_id` (`ApplyEventResult` `{status: 'ignored', reason: 'command_id_mismatch'}`, a member of `APPLY_IGNORE_REASONS`), T11 sends a direct `kill {command_id: null, target_command_id: <started.command_id>, reason: 'superseded_start'}` to the sending machine, after the commit. (An ignored `agent.exited` needs no kill: the process is gone.)
4. **Stale fencing**: a `session_event` rejected for its fencing token gets the existing direct `kill {command_id: null, target_command_id: null, reason: 'stale_fencing_token'}` with the *event's* fencing token in the envelope. A `heartbeat` that lists a running session under a token lower than `session.fencing_token` gets the same kill (with the listed token); this is the backstop that needs no further event from the orphan.
5. **Daemon kill rule** (T05, `KillPayloadSchema` in `ws.ts`): with `target_command_id` set, kill only the process spawned by that `start_session` (none live → no-op); with it null, kill the session's process only if its fencing token ≤ the envelope `fencing_token`. So no orphan kill can hit the process of a newer claim of the same session on the same machine.

Kills are direct replies, not outbox rows: if the socket drops before one is written, the orphan's next stale-token event or the next heartbeat after reconnect triggers rule 4.

**Accepted gap (U-023, M1).** A `superseded_start` kill (rule 3) lost to a socket drop is not re-triggered: the replayed `started` is deduped on `seq`, and the orphan holds the current fencing token, so rule 4 misses it. Accepted for M1 because it needs a socket drop inside a narrow window on a single machine, and the orphan dies when the session's worktree is cleaned up (its cwd is removed and the daemon kills every process it spawned under that worktree). Revisit with multi-machine (M2).

## Pending answer

`session.pending_answer {input_request_id, answer} | null` ([02](02-data-model.md#session), `SessionSnapshot.pending_answer`) keeps a human answer until an agent is running on it, so no path loses it ([U-026](../tracking/UNKNOWNS.md)):

- **Set** by apply on `input.provided` (alongside the wrapper's `input_request.answer` write).
- **Used**: every `start_session` apply emits while it is set uses `prompt = pending_answer.answer` with `resume_claude_session_id`: the `input.provided` resume when `agent_process_live` is false, the `send_input` `no_live_process` re-answer, the resume after `agent.exited` while parked, and the `session.assigned` re-emit after a refused or timed-out resume requeued the session.
- **Cleared** when the agent is running on it: a matching `session.started`, or, on the live `send_input` path (an accepted ack is not an engine event), the agent's next `agent.complete_state` / `agent.ask_user` / `agent.no_outcome`. Entering a state (apply's `enter`):
  - a **different** state clears it, unless that apply delivers the answer (`input.provided`);
  - an `input.provided` into an **agent** state keeps it: for the live `send_input` (kept until the agent's next outcome, as above), for the `start_session` that uses it (kept until that start's matching `session.started`, so an `ack_timeout` requeue can re-answer), or, when the session has no machine, through the requeue until the `session.assigned` re-emit;
  - re-entering the **same** state (a self-loop) keeps it for the re-answer;
  - entering any non-agent state (command, connector, event, human, terminal) clears it.

  Always cleared on terminal statuses and on `operator.cancel`.

## Prompt render

`apply()` renders every `start_session.prompt` with `renderPrompt` (`shared/src/engine/render.ts`; [05](05-workflow-engine.md#prompt-render)); it is the only renderer ([U-040](../tracking/UNKNOWNS.md), M1-T07 deleted the wrapper's `engine/prompt.ts`). The wrapper and the dispatcher pass the prompt through verbatim. A resume whose prompt is `pending_answer.answer` sends the human's text unrendered.

## Effect → WS fields

`commandPayloadForEffect` (`shared/src/protocol/commands.ts`) is the whole mapping; the wrapper stores its result as `outbox.payload` and the dispatcher sends `commandEnvelopeForOutboxRow(row, msg_id)`.

| WS field | Source |
|---|---|
| envelope `session_id` | `outbox.session_id` |
| envelope `fencing_token` | `outbox.fencing_token`: the session's token **when the row was written** (after that apply), never the current one. A row whose token is below the session's current token is failed `stale_fencing_token`, not sent ([Outbox](#outbox-state-machine)) |
| `command_id` | assigned by the wrapper (= `outbox.command_id`) |
| `start_session.ticket_id`, `repo` | `snapshot.ticket.id`, `snapshot.ticket.repo` |
| `start_session.base_ref` | `M1_BASE_REF` = `HEAD` of the shared clone |
| `start_session.branch` | `session.branch` (set by the claim) |
| `start_session.workflow_state`, `prompt`, `tools`, `resume_claude_session_id`, `model`, `max_turns`, `max_budget_usd` | the effect (`state` → `workflow_state`; optional fields omitted when absent) |
| `start_session.env` | `{CONDUCTOR_SESSION_ID, CONDUCTOR_TICKET_ID}`. The workflow schema has no per-state env in M1; ports and git identity are added by the daemon (ADR-0005 §Spawn) |
| `send_input.input_request_id`, `text` | the effect |
| `run_cmd.workflow_state`, `cmd`, `cwd`, `timeout_ms` | the effect (`state` → `workflow_state`) |
| `kill.target_command_id` | **`null` for every engine-issued kill** (e.g. `operator.cancel`): kill every process of the session at or below the envelope token. Only the gateway's direct orphan kills set it |
| `kill.reason` | the effect |

## Wall time

`session.wall_seconds` is maintained by apply (T04), which gets `now`: on every state transition it adds `now − state_entered_at` for the state being left, then sets `state_entered_at = now`. Time in `human` and `event` states is not added (parked time doesn't count toward `budget.minutes`, [09](09-security-and-budgets.md#budgets)). Nothing else writes it. M1 has no enforcement trigger on it (like `budget.exceeded`, TD-015).

## Guards

A state's `guard` names an evaluator in `GUARD_REGISTRY` (`shared/src/workflow/guards.ts`): `(input: {def, snapshot, result}) => boolean`, pure. apply (T04) calls `evaluateGuard(name, input)` on `agent.complete_state` before leaving the state; false → the state's `fail` outcome, or `needs_input` if the state has no `fail`. **The M1 registry is empty and an unregistered guard fails closed** (`evaluateGuard` returns false → the state's `fail` outcome, or `needs_input` if it has none; TD-017). The validator (T03) accepts any guard name, so both reference workflows validate. `pr_flow`'s `open_pr` therefore always routes to needs_input in M1 (pr_flow isn't an M1 workflow); registering it needs commit facts in the `complete_state` event, and at that point an unregistered guard becomes a validator error.

## Tools

`TOOL_ALIASES` (`shared/src/workflow/tools.ts`) maps each workflow `tools` name to an ADR-0005 `ToolPolicy` fragment: `read` (base only), `edit` (`Edit(./**)`, `Write(./**)`: path-scoped, never bare), `bash` (`npm run:*`, `npm test:*`, exact `npm install` / `npm ci`; no interpreters or general runners), `git` (exact inspection commands, because diff/log/show accept `--output=<file>`, plus `add:*`, `commit:*`, `restore:*`; Claude Code also auto-allows commands it classifies as read-only), `pr_skill` (`Skill`, `gh pr view:*`; `gh pr create` is denied because it can push, so the PR is opened by a trusted state, TD-020). `resolveToolPolicy(tools)` merges `BASE_TOOL_POLICY` (worktree-scoped `Read(./**)`/`Glob(./**)`/`Grep(./**)`, deny `Bash(git push:*)`) with each fragment, de-duplicates, and drops any allow rule that is also denied; it throws `UnknownToolAliasError` on a name not in `TOOL_ALIAS_NAMES` (T03 validates against the same list). `git push` is always denied. **These rules narrow the agent; they are not a sandbox**: `npm run` executes repo scripts the agent can edit (TD-019), so the security boundary is the OS-level sandbox (U-004, slice 3). The daemon (T05) calls it on `start_session.tools`; the driver adds the conductor MCP tools.

## REST error map

T08 maps a non-applied `applyEvent` result with `httpForApplyResult(route, result)` (`shared/src/api/rest.ts`); `applied` → **202** `{ok: true}` on `/input`, `/approve` and `/cancel`.

| Result | HTTP | `ApiError.code` |
|---|---|---|
| rejected `unknown_session` | 404 | `not_found` |
| rejected `input_request_not_found` | 404 | `not_found` |
| rejected `input_already_answered` | 409 | `input_already_answered` |
| rejected `invalid_goto` | 400 | `bad_request` |
| rejected `stale_fencing_token` (not reachable from REST) | 409 | `conflict` |
| ignored (any `APPLY_IGNORE_REASONS`) on `/input` | 409 | `input_not_pending` |
| ignored on `/approve`, `/cancel` | 409 | `conflict` |

`POST /api/sessions/:id/approve` body `ApproveSessionRequest {comment?}` → `external.event {name: 'ui.approve', data: {comment}}` (no `data` without a comment). `/cancel` body `{reason?}` → `operator.cancel {reason}`. Request-body validation failures are 400 `bad_request` with `details`.

## Composition root

`packages/orchestrator/src/main.ts` defines the factory signatures and `composeOrchestrator(factories, config)`, which wires db → buses (`InMemoryBoardBus`, `InMemoryOutputBus`) → `createEngineService` → `createGateway({engine})` → `createApi` → `gateway.attach(api.server)`; `start()` runs `engine.startWorkers({transport: gateway.transport})` (outbox dispatcher + timeout sweep) then `api.listen(port, '127.0.0.1')`. Ownership: **T04** implements `createEngineService` in `src/engine/index.ts`, **T11** `createGateway` in `src/gateway/index.ts` (WS on `API_PATHS.daemonWs` = `/ws/daemon`, via the HTTP server's `upgrade`), **T08** `createApi` in `src/api/index.ts`, and **T07** adds `main()` (env, real factories, signals). `createDb` (a `pg.Pool`) lives in `main.ts`.

**Process entry (T07).** `main(opts?)` in `main.ts`, run by `src/bin.ts` (the package's `conductor-orchestrator` bin, `dist/bin.js`): reads `DATABASE_URL` (required), `CONDUCTOR_PORT` and `CONDUCTOR_WEB_DIR` (default `packages/web/dist`), calls `composeOrchestrator(REAL_FACTORIES, …)` where `REAL_FACTORIES.createDb` is `src/db`'s pool with an idle-error listener ([U-038](../tracking/UNKNOWNS.md); `main.ts`'s bare default stays for fakes), `start()`s it (outbox dispatcher + timeout sweep + listen on 127.0.0.1), and on SIGINT/SIGTERM `stop()`s and exits. When the web dir holds an `index.html`, the API server also serves the built web app ([01](01-architecture.md#deployment-target)): any GET/HEAD outside `/api/*` and `/ws/*` is a file from that dir, an extensionless path with no file gets `index.html`, everything else falls through to the API (`src/web-static.ts`). `main()` does not migrate: run `pnpm db:migrate` first. The port is `CONDUCTOR_PORT` (default **7400**, `conductorPort(env)`); the daemon (T05) dials `ws://<host>:<port>/ws/daemon`.

## Defaults recorded here (workshop reconciliation)

- The engine event is **`input.provided`**; the SSE board event is **`input.answered`**. They are distinct on purpose.
- **`waiting_for_build_slot` is a card badge, not a `session.status`.** A session waiting for a build slot stays `running` (Running column) with the badge set (`session_event build_slot` → `session.waiting_for_build_slot` → SSE `card.badge`).
- **`budget.exceeded`** is in the contract and its routing is implemented in T04, but **there is no enforcement trigger in M1** (TD-015: nothing emits it). The driver's `--max-budget-usd` is the only hard stop in M1.
- **No compute release / `park_release_after` in M1.** A parked `needs_input` session keeps its live process; `send_input` goes to stdin. If the process is gone (`agent.exited` while parked, or `command.refused` `no_live_process`), apply resumes with `start_session` ([Refusals](#refusals)).
- **Validator rule 3 stays "terminal or human"** ([05](05-workflow-engine.md#validation-on-save-m1-t03)).
- **Spend** is cumulative per `claude_session_id`; the last total lives in `session.claude_spend_totals` (jsonb map), and only positive deltas reach `spend_usd`.
- **Tools**: `start_session` carries the workflow's raw `tools` list; the daemon (T05) maps it to the ADR-0005 `ToolPolicy` with `resolveToolPolicy` ([Tools](#tools)).
- **Claude session id**: new sessions get it pre-assigned by the daemon (`resume_claude_session_id: null`); the orchestrator learns it from `session_event claude_session_id`.
- `base_ref` is `HEAD` of the shared clone in M1. The output tail for `cmd_exit` / `attach: output` is 16 KB.
- An unclaimed ticket (no session) shows in Queued: `columnFor(null) = 'queued'`, `BoardCard.session_id = null`.
- `ticket.repo_allow_machines` is kept as a nullable `text[]` (null = any machine) ([U-009](../tracking/UNKNOWNS.md)).

## Conventions

- Wire and DB names are snake_case. The ADR-0005 driver contract is camelCase (it's in-process); the daemon snake_cases when forwarding.
- DB row types follow node-postgres defaults (`bigint`/`numeric` → string, `timestamptz` → Date). Engine and API shapes use numbers and ISO-8601 strings.
- Workflow definitions are parsed strictly: unknown keys are errors.
