# 10 · Contracts (seam index)

M1-T12 froze every cross-agent seam as exported zod schemas / TS interfaces, each with an in-memory fake, so that groups B–D can be built in parallel. **A change to anything listed here is reported to the lead, never made locally** in a task branch ([M1](../plan/milestones/M1-single-machine.md)). Everything in `shared` is exported from `@conductor/shared`. The orchestrator and daemon contracts are exported from their package index.

## Seams

| Seam | File | Producer → consumers | Fake / fixtures |
|---|---|---|---|
| Domain enums (statuses, kinds, columns, badges, output streams), `OUTPUT_TAIL_BYTES` 16 KB, `OUTPUT_RING_BYTES` 256 KB, `sessionBranch()` | `shared/src/domain.ts` | — → all | — |
| `WorkflowDefinition`, `parseDuration` ([05](05-workflow-engine.md#definition-schema)) | `shared/src/workflow/schema.ts` | T12 → T03 validator, T04 engine, T08 save/list, T09 detail diagram | `docs/design/workflows/*.json` |
| **Transitions ([ADR-0011](../adr/0011-transition-rules.md), M1b-T01; [§Transitions](#transitions-adr-0011))**: `TransitionObjectSchema` fields `title`, `when`, `actor`, `kinds`, `question`, `requires` (`TransitionRequiresSchema`), `on_unmet`; `ConditionSchema` / `ConditionTypeSchema` / `CONDITION_TYPES`, `AVAILABLE_CONDITION_TYPES`, `conditionLabel`, `conditionEnabled`, `DEFAULT_CONDITION_POLL`, `MAX_CONDITION_POLL`; `TransitionActionSchema`, `AVAILABLE_TRANSITION_ACTIONS`; `TicketKindSchema`, `TransitionActorSchema`, `RETURN_TO` | `shared/src/workflow/schema.ts` | T01 → T02 validator, T03/T08 engine, T06 editor, T09 v2 | `CONDUCTOR_V2_DRAFT` / `CONDUCTOR_V2_DRAFT_DEF` (`workflow/fixtures.ts`) |
| `transitionActor`, `transitionMatchesKind`, `transitionsOf`, `transitionObject`, `transitionGoto`, `transitionTitle`, `transitionNeedsText`, `agentTransitionOptions` / `AgentTransitionOptionSchema`, `humanTransitionOptions` / `HumanTransitionOptionSchema`, `SYSTEM_TRANSITION_NAMES`, `FALLBACK_TRANSITION_NAMES` | `shared/src/workflow/transition-rules.ts` | T01 → T02, T03 (prompt, `start_session.transitions`, filters), T06, card derivation | unit-tested on the draft v2 |
| `foldLegacyRequirements(def)` | `shared/src/workflow/fold.ts` | T01 → T06 (on save), T02 (validates its output) | unit-tested on conductor v1 and `m1_reviewed` |
| `CompleteStateInputSchema`, `COMPLETE_STATE_INPUT_SHAPE`, `TRANSITION_NAME_MAX` 100, `TRANSITION_REASON_MAX` 4 000 | `shared/src/protocol/outcome.ts` | T01 → T05 outcome server, fake claude | unit-tested |
| `GuardRegistry`, `GUARD_REGISTRY` (empty in M1), `isRegisteredGuard`, `evaluateGuard` ([Guards](#guards)) | `shared/src/workflow/guards.ts` | T12 → T04 (evaluate on `complete_state`) | unit-tested |
| `TOOL_ALIASES`, `resolveToolPolicy` ([Tools](#tools)) | `shared/src/workflow/tools.ts` | T12 → T03 (unknown names), T05 (→ `DriverStartOptions.tools`) | unit-tested against both reference workflows |
| `SessionSnapshot` (incl. `pending_answer`; ADR-0011 `ticket.kind`), `EngineEvent` (ADR-0011: `agent.complete_state {transition, reason}`, `human.transition`), `Effect` (ADR-0011: `start_session.transitions`, `state_entered {transition, reason, actor}`), `ApplyResult`, `APPLY_IGNORE_REASONS` (+ `unknown_transition`, `transition_not_allowed`), `APPLY_REJECT_REASONS`, `apply()` stub; ADR-0011 `GateStep` kind `move` (`ConditionStatusSchema`), `moveCounterKey`, `moveStateLabel`, `unknownTransitionQuestion`, `CONDITIONS_NO_MACHINE_NOTE`, `StateEnteredPayloadSchema` | `shared/src/engine/types.ts` | T04 (`engine/apply*.ts`) → T04 wrapper, T07, T08/T11 (reasons) | `SNAPSHOT_FIXTURE`; ADR-0011 `MOVE_STEP_FIXTURE`, `SNAPSHOT_V2_FIXTURE`, `SNAPSHOT_V2_CONDITIONS_FIXTURE`, `M1B_EVENT_FIXTURES` (`engine/fixtures.ts`) |
| `renderPrompt`, `TICKET_TEMPLATE`, `NO_OUTCOME_QUESTION` ([Prompt render](#prompt-render)) | `shared/src/engine/render.ts`, `engine/apply.ts` | T04a → apply (the only prompt renderer, U-040) | unit-tested |
| Requirements review ([Requirements review](#requirements-review-adr-0009)): `ReviewStepSchema` / `SessionSnapshot.review`, `renderReviewPrompt`, `parseVerdict`, `renderReviewFeedback`, `reviewStateLabel`, `reviewCounterKey`, `REVIEW_TOOLS`, `REVIEW_TIMEOUT`, `REVIEW_CONTEXT_KEY`, `REVIEW_PROMPT_HEADING`; `REVIEW_GIT_COMMANDS` + the `review` tool alias | `shared/src/engine/review.ts`, `engine/types.ts`, `workflow/tools.ts` | ADR-0009 → apply, validator (reserved name), orchestrator rows (`splitReview` / `joinReview`), daemon (`start_session.review`) | `engine/apply.review.test.ts`; e2e fake `<name>_review` scenarios |
| `commandPayloadForEffect`, `M1_BASE_REF` ([Effect → WS](#effect--ws-fields)) | `shared/src/protocol/commands.ts` | T12 → T04 wrapper (outbox payload) | unit-tested; payloads parse as WS commands |
| Spend accounting `spendDelta` / `applySpend` | `shared/src/engine/spend.ts` | T12 → T04 | unit-tested |
| WS envelope, `DaemonToOrchestrator`, `OrchestratorToDaemon`, `NO_OUTCOME_OUTPUT_CHARS`, `fetch_transcript` / `transcript` + `TRANSCRIPT_RESULT_CHARS` / `TRANSCRIPT_MAX_BYTES` ([03](03-protocols.md#daemon--orchestrator-websocket), [ADR-0008](../adr/0008-transcript-history-and-reopen.md)) | `shared/src/protocol/ws.ts` | T05 daemon ⇄ T11 gateway; T04 dispatcher builds commands. ADR-0011: `complete_state.transition/reason`, `start_session.transitions`, `run_action evaluate_conditions` + `EvaluateConditionsArgsSchema`, `EvaluateConditionsResultSchema`, `ConditionResultSchema` | `DAEMON_FIXTURES`, `ORCHESTRATOR_FIXTURES`, `SESSION_EVENT_FIXTURES`, ADR-0011 `M1B_WS_FIXTURES` (`protocol/fixtures.ts`) |
| REST DTOs (incl. ADR-0008 `TranscriptResponse`, `ReopenSessionRequest` / `ReopenSessionResponse`; ADR-0009 `WorkflowDetail` with `versions`), `API_PATHS` (incl. `daemonWs`, `sessionTranscript`, `sessionReopen`, `workflow(id)`), `CONDUCTOR_PORT` / `conductorPort()`, `columnFor(status)` ([06](06-human-input.md#kanban-columns-queries-not-state)), `ApproveSessionRequest`, `httpForApplyResult` ([REST error map](#rest-error-map)) | `shared/src/api/rest.ts` | T08 → T09; T05 (WS URL), T07 (port) | — |
| `toBoardCard(ticket, session, openInput, view)`, `toInputRequestDto` (the one card derivation). ADR-0011: card `kind`, `pending` (`pendingOfStep`, `BoardPendingSchema`), `human_transitions` (`humanTransitionsOfCard`), `actionLabel`; `SessionDetail.moves` (`MoveDtoSchema`, `toMoveDto`, `SESSION_MOVES_LIMIT` 50); `TransitionSessionRequestSchema`, `API_PATHS.sessionTransition`; `CreateTicketRequest.kind`, `TicketDto.kind` | `shared/src/api/rest.ts` | T12 → T04 (`card.upserted`), T08 (board, ticket create), T09b; M1b-T04 (route, moves), T07 (board) | `BOARD_CARD_FIXTURE` = `toBoardCard(ticket, null, null)`; ADR-0011 `BOARD_CARD_PENDING_FIXTURE`, `BOARD_CARD_NEEDS_INPUT_FIXTURE` (both = `toBoardCard` output, asserted), `SESSION_MOVES_FIXTURE`, `TRANSITION_REQUEST_FIXTURES` (`api/fixtures.ts`) |
| `BoardSseEvent`, `boardSseEventToRow` / `boardSseEventFromRow`, `OutputChunk` (`api/output.ts`), `encodeSseFrame` | `shared/src/api/sse.ts` | T04, T08, T11 write rows → T08 SSE → T09 | `BOARD_SSE_FIXTURES`, `BOARD_CARD_FIXTURE`, `OUTPUT_CHUNK_FIXTURE` (`api/fixtures.ts`) |
| `EngineService.applyEvent` | `orchestrator/src/contracts.ts` | T04 → T08 (input/cancel/approve/messages), T11 (claim, session_event, acks) | `FakeEngineService` (`seed`, `respond`, `respondWith`) |
| `OutboxTransport` (+ the outbox state machine in its doc comment), `commandEnvelopeForOutboxRow` | `orchestrator/src/contracts.ts` | T11 → T04 dispatcher | `FakeOutboxTransport` |
| `insertBoardEvents(tx, drafts)`, `BOARD_EVENT_LOCK_KEY` ([Board events](#board-events-and-the-event-table)) | `orchestrator/src/contracts.ts` | T12 → T04, T08, T11 (the only board-row writer) | tested with a recording `Queryable` |
| Composition root: `CreateDb`, `CreateEngineService`, `CreateGateway`, `CreateApi`, `composeOrchestrator` ([Composition root](#composition-root)) | `orchestrator/src/main.ts` | T04 / T11 / T08 each implement one factory → T07 wires `main()` | wiring test with fake factories |
| `BoardBus` | `orchestrator/src/contracts.ts` | T04 (after COMMIT), T08 (ticket create), T11 (badges; claim's `boardEvents`) → T08 SSE | `InMemoryBoardBus` |
| `OutputBus` (256 KB ring per session, U-005) | `orchestrator/src/contracts.ts` | T11 (WS `output`) → T08 (detail + output SSE) | `InMemoryOutputBus` (also the M1 implementation) |
| `TranscriptSource`, `TranscriptFetchResult`, `TRANSCRIPT_TIMEOUT_MS` 10 s ([ADR-0008](../adr/0008-transcript-history-and-reopen.md)) | `orchestrator/src/contracts.ts` | gateway (`GatewayHandle.transcripts`) → T08 `GET /transcript` (`CreateApi` deps `transcripts?`) | `FakeTranscriptSource` |
| `reopenSession(db, sessionId, text, actor)`, `REOPENABLE_STATUSES` ([Reopen](#reopen)) | `orchestrator/src/engine/reopen.ts` | → T08 `POST /reopen` | tested on real Postgres |
| Transcript reading: `findTranscript`, `transcriptChunks`, `claudeProjectSlug` ([ADR-0008](../adr/0008-transcript-history-and-reopen.md)) | `daemon/src/claude/transcript.ts` | → daemon `fetch_transcript` handler | fixture `daemon/test/fixtures/transcript.jsonl` |
| DB row types ([02](02-data-model.md)) | `orchestrator/src/db/types.ts` | T02 DDL ⇄ T04, T08, T11 | — |
| `ClaudeDriver` / `DriverSession` / `DriverEvent` ([ADR-0005](../adr/0005-claude-code-driver.md) §Contract, verbatim, plus `DriverSession.sendMessage` from [ADR-0007](../adr/0007-live-messages-to-agents.md)) | `daemon/src/claude/driver.ts` | T05/T07 real driver → T05 daemon core | `FakeClaudeDriver` (`claude/fake-driver.ts`) |
| `CommandRunner`, `CreateCommandRunner` | `daemon/src/commands/runner.ts`; factory `createCommandRunner` in `daemon/src/commands/index.ts` (the real `ProcessCommandRunner`, T06) | T06 → T05 | `FakeCommandRunner` (`commands/fake-runner.ts`) |

## Engine: events in, effects out

`apply(def, snapshot, event, now)` is pure. Ids (`command_id`, `input_request_id`) and `event.id` are assigned by the EngineService wrapper, which writes the event rows, the session row and the outbox rows in one transaction, then publishes the board events to the BoardBus (or returns them in `boardEvents` for a caller-owned `tx` to publish after its COMMIT).

| EngineEvent | Source |
|---|---|
| `session.assigned {machine_id}` | T11 claim, inside the claim transaction (`applyEvent(..., {tx})`). Accepted only from `queued`: sets `machine_id`; enters `def.start` if `workflow_state` is null (delivering `pending_answer` when set: a reopened session, [Reopen](#reopen)), else re-emits the current state's command (`start_session` resumes if `claude_session_id` is set, with `prompt = pending_answer.answer` when set). Into an **agent** state: `status = assigned` + `start_session` (`running` comes with `session.started`). Into a **command** state: `status = running` + `run_cmd` directly, since `run_cmd` has no `started` ([U-024](../tracking/UNKNOWNS.md)) |
| `command.refused {command_id, command_kind, reason}` | T11 on **every** `command_ack accepted=false`; T04 dispatcher on a `start_session` ack timeout (`ack_timeout`). See [Refusals](#refusals) (incl. the [U-025](../tracking/UNKNOWNS.md) ignore rule) |
| `session.started {command_id, worktree_path, branch, port_range}`, `agent.claude_session_id`, `agent.complete_state`, `agent.ask_user`, `agent.no_outcome {last_output}`, `agent.exited {command_id, code, signal}`, `command.exited`, `spend.reported` | T11 from `session_event` `started`, `claude_session_id`, `complete_state`, `ask_user`, `no_outcome`, `exit`, `cmd_exit`, `spend`. `agent.no_outcome` ([U-028](../tracking/UNKNOWNS.md), [ADR-0005 addendum](../adr/0005-claude-code-driver.md#addendum-2026-10-22-turns-without-an-outcome-u-028)) is routed exactly like `agent.ask_user` with the question `NO_OUTCOME_QUESTION` ("Agent stopped without reporting an outcome; last output attached") followed by `\n\nLast output:\n<last_output>` when there is output |
| `input.provided {input_request_id, answer, goto?}` | T08 `POST /sessions/:id/input` (`actor` = answered_by) |
| `human.transition {name, text, actor}` | M1b-T04 `POST /sessions/:id/transition` (`actor: 'ui'`), [ADR-0011](../adr/0011-transition-rules.md). See [§Transitions](#transitions-adr-0011) |
| `external.event {name}` | T08 `/approve` (`ui.approve`); connectors later. Its `data` is merged into `context.<state>` (keeping an entry action's `pr_url`) |
| `action.completed {command_id, action, result, error}` | T11 from `session_event action_result` ([ADR-0010](../adr/0010-one-workflow-columns-are-states.md)): an entry step's action finished. Accepted only in the step's `actions` phase for that action; otherwise `unexpected_event` |
| `operator.cancel` | T08 `/cancel` |
| `operator.message {text}` | T08 `POST /sessions/:id/messages` ([ADR-0007](../adr/0007-live-messages-to-agents.md)). Accepted only while `status = running` in an **agent** state with `agent_process_live`; otherwise ignored `wrong_status` (a `needs_input` session is answered through `/input`). Accepted → exactly one `send_message` effect: no transition, no status, deadline or snapshot change (transitions only on outcomes). The event row keeps `text`: it is the record of what the human said |
| `timer.fired {state, deadline}` | T04 timeout sweep over `session.state_deadline` |
| `budget.exceeded` | nothing in M1 (see defaults) |

`session_event` `build_slot` and `heartbeat` are not engine events: for `build_slot` the gateway, in its own transaction, sets `session.waiting_for_build_slot`, INSERTs the `card.badge` event row and advances `machine.last_seq`, then publishes `card.badge` after COMMIT. `heartbeat` renews leases.

| Effect | Outbox kind / target | WS message (orchestrator → daemon) |
|---|---|---|
| `start_session` | `start_session` / `machine:<id>` | `start_session` (+ ticket, repo, base_ref, branch, env; [fields](#effect--ws-fields)) |
| `send_input` | `send_input` / `machine:<id>` | `send_input` |
| `send_message` | `send_message` / `machine:<id>` | `send_message` with `target_command_id = agent_command_id` ([ADR-0007](../adr/0007-live-messages-to-agents.md)) |
| `run_cmd` | `run_cmd` / `machine:<id>` | `run_cmd` (a command state, or an entry check) |
| `run_action` | `run_action` / `machine:<id>`, `outbox.idempotency_key` = the effect's | `run_action` ([ADR-0010](../adr/0010-one-workflow-columns-are-states.md); + `branch` = `session.branch`) |
| `kill` | `kill` / `machine:<id>` | `kill` with `target_command_id: null` |
| `connector_call` | `connector_call` / `connector:<name>` | none (orchestrator-side connectors, not in M1) |
| `create_input_request` | — (INSERT `input_request`) | — → event row + SSE `input.requested` |
| `set_deadline` | — (UPDATE `session.state_deadline`) | — |
| `state_entered` | — (event row `state.entered`, not a board event) | — → SSE `card.upserted` (card's `workflow_state` changed) |
| `session_status` | — | — → event row + SSE `session.status` |
| `ticket_status` | — (UPDATE `ticket.status`) | — |

## EngineService wrapper

Writes `apply()` can't make (it has no ids and doesn't see these columns), all in the apply transaction (T04):

- Assigns `command_id` / `input_request_id`. For a `start_session` effect it also sets `session.agent_command_id` = that `command_id` and `agent_process_live = false`.
- Builds each outbox row with `commandPayloadForEffect(effect, {command_id, snapshot, branch: session.branch})`: `outbox.kind`, `target`, `payload` (the WS payload verbatim) and `outbox.fencing_token` = the session's token after this apply ([Effect → WS](#effect--ws-fields)). It never renders or rewrites a prompt ([Prompt render](#prompt-render)).
- On a non-ignored `session.started`: `UPDATE session SET worktree_path, branch, port_range = int4range(base, base+count)` (`[base, base+count)`). The gateway does **not** write these.
- On `command.refused` for `start_session` that apply did **not** ignore: `session.fencing_token = nextval('fencing_seq')`, so events from a process that command spawned anyway are stale ([Orphaned processes](#orphaned-processes)). An ignored refusal (U-025 rule) bumps nothing.
- **Gate-step fencing** ([ADR-0010](../adr/0010-one-workflow-columns-are-states.md), security review 2026-10-23): when apply enters, leaves or switches a gate step (`step` null ↔ set, or a different step label), the token is bumped the same way. The worker (between its `complete_state` and its exit) and a finished reviewer run under the old token, so none of their events can reach the step or the next visit: the gateway refuses them `stale_fencing_token` and kills the process. The one exception is `spend`: a fenced-off process's last `spend` from the session's machine is still applied (cumulative per Claude session, it never moves the ticket), without a kill. The ADR-0009 path on `main` had the same gap (worker and reviewer shared a token) and is fixed by the same bump.
- On `input.provided`: checks the `input_request` is open, records `answer`, `answered_by` (= `opts.actor`), `answered_at`, and writes the `input.answered` board row.
- On an applied `human.transition` ([ADR-0011](../adr/0011-transition-rules.md)): answers the session's open `input_request` (answer = `text` ?? `"[<name>]"`, `answered_by` = the event's `actor`) and writes its `input.answered` row. Nothing on an ignored one.
- `state_entered` → the `state.entered` event row's payload `StateEnteredPayload` `{from, to, visit, transition?, reason?, actor?}` (the ADR-0011 fields only when apply set them; `toMoveDto` reads absent as null).
- After the effects: writes a `card.moved {from, to}` row when the card's column changed, then one `card.upserted` row (last) if any `BoardCard` field changed (status, column, badges, `checking`, `pr_url`, `workflow_state`, `machine_id`, `spend_usd`, open input request, `updated_at` on any change). The card is `toBoardCard(ticket, session, openInput, view)`, `view` = `{columns: boardColumns(<latest conductor>), def: <the session's pinned definition>}` (`orchestrator/src/engine/board-view.ts`; the column rule is `placeCard`, [06](06-human-input.md#kanban-columns-the-workflows-states)). It carries the open input request only while the session is `needs_input`: a cancel leaves the row unanswered, but the card drops it (TD-079).
- Writes every board row through `insertBoardEvents(tx, drafts)`, as the last write of the transaction.

## Board events and the event table

**One writer path.** T04, T08 and T11 write board rows only through `insertBoardEvents(tx, drafts)` (`orchestrator/src/contracts.ts`). It takes `pg_advisory_xact_lock(BOARD_EVENT_LOCK_KEY)` before the first INSERT and holds it to COMMIT, so board-writing transactions commit in `event.id` order and a `Last-Event-ID` replay (`id > $1`) can't skip a lower id that commits later. Call it last in the transaction to keep the lock short; publish the returned events after COMMIT. Engine audit rows don't take the lock (they are never replayed).

Every `BoardSseEvent` is backed by **exactly one** `event` row: `type` = the SSE `type`, `session_id` = the SSE `session_id`, `payload` = the SSE event minus `{type, id, ts, session_id}`, and the row's `id`/`ts` are the SSE `id`/`ts`. Writers build rows with `boardSseEventToRow(draft)` and decode `INSERT … RETURNING *` with `boardSseEventFromRow(row)`, which T08 also uses for `Last-Event-ID` replay (`WHERE id > $1 AND type = ANY(BOARD_SSE_EVENT_TYPES) ORDER BY id`); it returns null for non-board rows. Engine-event rows (`type` = `EngineEvent.type`) and `state.entered` are audit rows, never replayed to the board.

| SSE event | Written by | When |
|---|---|---|
| `card.upserted` (`session_id` null for a sessionless ticket) | T08 (with the ticket INSERT, same tx); T04 wrapper (see above, incl. the claim's `session.assigned`) | new ticket; any card change |
| `card.moved` | T04 wrapper; reopen | the card's column (`placeCard`) changed; `from` / `to` are column ids ([ADR-0010](../adr/0010-one-workflow-columns-are-states.md)) |
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

## Reopen

[ADR-0008](../adr/0008-transcript-history-and-reopen.md). `POST /api/sessions/:id/reopen {text}` → `reopenSession` (`orchestrator/src/engine/reopen.ts`), one transaction, no engine event and no outbox row:

1. `SELECT … FOR UPDATE` the ticket (serializes concurrent reopens and the claim), then the old session. 404 if unknown; 409 unless it is `done` / `failed` (`REOPENABLE_STATUSES`; `lost` is excluded) **and** the ticket's latest session (`ORDER BY created_at DESC`).
2. `INSERT session`: `status = 'queued'`, `workflow_state = null`, `machine_id = null`, `agent_command_id = null`, `agent_process_live = false`, a lease; **carried**: `workflow_id`/`workflow_version`, `branch`, `claude_session_id`, `context`, `claude_spend_totals`; `pending_answer = {input_request_id: null, answer: text}`; everything else default (retry counters, visits, spend, wall time). The old session stays terminal, so `session_one_live_per_ticket` allows the new row.
3. `UPDATE ticket SET status = 'ready'`; INSERT an `operator.reopen` audit row on the new session (`{text, reopened_from, actor}`, the durable record of the text).
4. `insertBoardEvents`: `card.moved` (old column → `queued`), then `card.upserted` (the new session's card). COMMIT, publish; T08 appends `text` to the new session's `OutputBus` as a `user` chunk and answers 202 `{session_id}`.

The first command comes from the claim, by the usual path: the [Claim](#claim) reuses the queued session, only on the machine the branch ran on (the [04 reopen pin](04-scheduler.md#2--claim-query-ticket-side)), and `session.assigned` enters `def.start` with the pending answer, so the `start_session` is `{resume_claude_session_id: <old id>, prompt: text}` (or the rendered start prompt with the text in it when the old session never got a Claude id). [Pending answer](#pending-answer) then holds as for any resume: kept through an ack-timeout requeue, cleared by the matching `started`; a resumed process that exits before reporting fails to a human. The daemon reuses the worktree that has the branch checked out (`Workspace.ensureWorktree`), refusing the start while another session's process still runs in it.

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

`pending → sent → acked | failed`. `acked` and `failed` are terminal. Status writes are partitioned and every UPDATE is guarded, so a fast ack can't be overwritten by the dispatcher. **Every UPDATE that makes a `start_session` row terminal also sets `payload.prompt` to JSON `null`** (`SCRUBBED_PAYLOAD_SQL`, `orchestrator/src/engine/outbox.ts`; other payload fields kept): the prompt can carry the `attach: output` tail, and a terminal row is never sent again (a requeue renders a new prompt from the session) ([U-039](../tracking/UNKNOWNS.md)). The same UPDATE nulls a `send_message` row's `payload.text` (up to 20 000 chars of human text; its record is the `operator.message` event row, [ADR-0007](../adr/0007-live-messages-to-agents.md)). `send_message` rows are retried like `send_input` (no ack timeout); the daemon dedupes them on `command_id`, so a message is written at most once.

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
- `run_cmd` → outcome `fail` (e.g. `memory_pressure`, `unknown_session`). In an entry step's checks phase (ADR-0010) → `on_unmet.else` instead (the machine could not run the check: not the agent's fault).
- `run_action` (ADR-0010) → `on_unmet.else` with the reason; outside an entry step's actions phase `unexpected_event`.
- `kill` → ignored (`kill_refused`; logged as the event row).
- `send_message` (any reason: `no_live_process`, `agent_parked`, …) → ignored (`message_refused`). A live message is best effort and never re-routes the workflow, unlike `send_input`'s `no_live_process` re-answer. After the commit the gateway appends a `debug` output chunk `conductor: message not delivered to the agent (<reason>)` so the board shows it ([ADR-0007](../adr/0007-live-messages-to-agents.md)).

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

- **Set** by apply on `input.provided` (alongside the wrapper's `input_request.answer` write), or by [Reopen](#reopen) on the new session's INSERT (`input_request_id: null`: it answers no request, and is never sent through `send_input`).
- **Used**: every `start_session` apply emits while it is set uses `prompt = pending_answer.answer` with `resume_claude_session_id`: the `input.provided` resume when `agent_process_live` is false, the `send_input` `no_live_process` re-answer, the resume after `agent.exited` while parked, and the `session.assigned` re-emit after a refused or timed-out resume requeued the session.
- **Cleared** when the agent is running on it: a matching `session.started`, or, on the live `send_input` path (an accepted ack is not an engine event), the agent's next `agent.complete_state` / `agent.ask_user` / `agent.no_outcome`. Entering a state (apply's `enter`):
  - a **different** state clears it, unless that apply delivers the answer (`input.provided`);
  - an `input.provided` into an **agent** state keeps it: for the live `send_input` (kept until the agent's next outcome, as above), for the `start_session` that uses it (kept until that start's matching `session.started`, so an `ack_timeout` requeue can re-answer), or, when the session has no machine, through the requeue until the `session.assigned` re-emit;
  - re-entering the **same** state (a self-loop) keeps it for the re-answer;
  - entering any non-agent state (command, connector, event, human, terminal) clears it.

  Always cleared on terminal statuses and on `operator.cancel`.

## Prompt render

`apply()` renders every `start_session.prompt` with `renderPrompt` (`shared/src/engine/render.ts`; [05](05-workflow-engine.md#prompt-render)); it is the only renderer ([U-040](../tracking/UNKNOWNS.md), M1-T07 deleted the wrapper's `engine/prompt.ts`). The wrapper and the dispatcher pass the prompt through verbatim. A resume whose prompt is `pending_answer.answer` sends the human's text unrendered.

## Requirements review (ADR-0009) and entry steps (ADR-0010)

Semantics: [05 §Requirements gates](05-workflow-engine.md#requirements-gates-adr-0009) and [05 §Requirements to enter a column](05-workflow-engine.md#requirements-to-enter-a-column-adr-0010). One representation, the gate step. The contract points:
- **Snapshot.** `SessionSnapshot.step: GateStep | null` (`{kind: 'transition'|'entry', from, outcome, to, attachment, subject, claude_session_id, nudged, phase, index}`). While set, `workflow_state` is `reviewStateLabel(from, to)` = `"<from> → <to> (review)"` or `entryStateLabel(from, to)` = `"<from> → <to> (entry)"`, and `apply` routes every event through its step handler (anything else is ignored with the existing reasons: `unexpected_event`, `wrong_status`, `command_id_mismatch`, `stale_timer`). Stored in `session.context[STEP_CONTEXT_KEY = "__entry"]` by `writeSession`, lifted out by `toSnapshot` (`orchestrator/src/engine/rows.ts` `joinStep` / `splitStep`, which also reads the pre-ADR-0010 `__review`); never in `GET /api/sessions/:id`'s `context`, never carried by a reopen.
- **Entry checks / actions.** A check is a `run_cmd {state: <label>, cwd: null, timeout_ms}` whose `command.exited` is the check's outcome; an action is a `run_action {state: <label>, target_state, action, idempotency_key: "<session>:<to>:<visit>", args}` whose `action.completed` is its outcome (`result` merged into `context.<to>`). Unmet counter `entryCounterKey(to)` = `"entry:<to>"`; feedback heading "Requirements to enter <title> were not met:" (`feedbackHeading`). Deadlines: none during checks (the daemon times them out), `REVIEW_TIMEOUT` (10m) for the review, `ENTRY_ACTION_TIMEOUT` (10m) for an action. Checks carry `run_cmd.checkout = {sha: step.head_sha (null for the first), setup: entry.setup ?? null, last}` (not the implicit pin check) and run in a fresh checkout of that commit; `command.exited.setup_failed` → unmet, item "Setup". Checks also carry `run_cmd.require_clean: true`; `command.exited.dirty` (the status lines) means the tree had uncommitted changes and the check did not run: unmet, item "Committed work". `command.exited.head_sha` (optional) is the commit a check ran on: recorded from the first check as `step.head_sha`, compared on later ones, passed as `run_action.expected_sha`, and named in the review prompt. open_pr's URL goes only to `context.__pr` (`PR_CONTEXT_KEY`), validated against `GITHUB_PR_URL_RE` by the daemon, the engine and `BoardCardSchema` (invalid → null).
- **Reviewer start.** `start_session {state: <label>, tools: REVIEW_TOOLS = ['review'], resume_claude_session_id: null, model: gate.model?, max_budget_usd: remaining, review: true}`, prompt `renderReviewPrompt` (first line `REVIEW_PROMPT_HEADING`). The one nudge resumes `review.claude_session_id` (the reviewer's) with `reviewNudge(why, items)`. The wrapper treats it like any start (new `agent_command_id`, `agent_process_live = false`).
- **Claude sessions.** `agent.claude_session_id` during a review sets `review.claude_session_id`, never `claude_session_id`; the daemon does not store a `review: true` start's id as the session's (`PersistedSession.claudeSessionId`), so transcripts (ADR-0008) and reopen stay on the worker's conversation. `spend.reported` is per Claude session id as always, so reviewer spend adds to `spend_usd`.
- **Verdict.** `parseVerdict(result, items)`; kept as `context[<label>] = {verdict: [{item, met, reason}]}`. Unmet loop counter `reviewCounterKey(from, outcome)` = `"requirements:<from>:<outcome>"`. The worker's next prompt gets `renderReviewFeedback` via `RenderPromptInput.feedback`.
- **Leaving.** `workflow_state` goes back to `from`, `agent_command_id = null`, `agent_process_live = false` (the reviewer's late `exit` is then a `command_id_mismatch`), then the next state is entered with `state_entered.from = <label>`. A `kill` is emitted on the timeout, no-verdict and budget paths.
- **Timeout.** `REVIEW_TIMEOUT` = `10m`, armed as `state_deadline` with `set_deadline(<label>, …)`; the sweep's `timer.fired {state: <label>}` matches it.

## Transitions (ADR-0011)

Semantics: [ADR-0011](../adr/0011-transition-rules.md) (accepted, with Ben's answers to U-058, U-059, U-061..U-063) and [05 §Transition object](05-workflow-engine.md#transition-object-adr-0011). Frozen by M1b-T01; groups B–D report a needed change to the lead. The contract points:
- **Definition.** `on` keys are transition names. Transition object: `goto` (a state or `RETURN_TO` = `"$return_to"`), `title?`, `when?`, `actor?`, `kinds?`, `question?`, `requires?` `{checks?, setup?, review?, actions?, conditions?, condition_timeout?, condition_poll?}`, `on_unmet?`, plus the M1 / ADR-0009 fields. `ConditionSchema` is a union on `type`: `pr_checks_green`, `pr_approvals {min ≥ 1}`, `pr_merged`, `azure_pipeline_succeeded {pipeline}`, `jira_fields_set {fields[1..20]}`, each with `enabled?` (default true) and `label?`. `AVAILABLE_CONDITION_TYPES` (the first three) and `AVAILABLE_TRANSITION_ACTIONS` (`open_pr`) are what M1b runs; the rest parse, the validator refuses the actions (rule 14), and the daemon answers the conditions `unsupported`.
- **Actor and kind.** `transitionActor` infers the actor ([05](05-workflow-engine.md#transition-object-adr-0011)); `transitionMatchesKind(t, kind)`: `kinds` omitted → both, ticket kind null → both (U-062). `agentTransitionOptions(def, state, kind)` is the one list of what an agent may name: the prompt's "How to finish" (T03) and `start_session.transitions` are both built from it. `humanTransitionOptions(def, state, kind, return_to)` is the one list of buttons.
- **Agent outcome.** The tool input is `CompleteStateInputSchema {transition?, reason?, result}` (caps at the tool call; the WS event is uncapped). `session_event complete_state {result, transition?, reason?}` → `agent.complete_state {result, transition?, reason?}` (the gateway passes them only when present; absent ≡ null ≡ `done`). An agent naming a transition it may not take is **not** an ignore: apply routes it to needs_input (`agent_question`, question `unknownTransitionQuestion(name)`). `unknown_transition` / `transition_not_allowed` are ignore reasons for `human.transition` only.
- **Human move.** `POST /api/sessions/:id/transition` `TransitionSessionRequest {name, text?}` → `human.transition {name, text: text ?? null, actor: 'ui'}`. Accepted from a human state, or an event state for an `actor: human` transition; `RETURN_TO` resolves to `return_to`. The wrapper answers the open input_request ([EngineService wrapper](#engineservice-wrapper)). `/input` keeps working (T03 maps it onto the same path).
- **Move step.** `requires` on a taken transition runs as `GateStep {kind: 'move', transition, actor, reason, …}`, phases `checks → review → actions → conditions`, label `moveStateLabel(from, to, name)` = `"<from> → <to> (move: <name>)"`, counter `moveCounterKey(from, name)` = `"move:<from>:<name>"`, feedback heading `feedbackHeading({kind: 'move', title})` = "Requirements for <title> were not met:". Old versions keep `entry` / `transition` steps. New step fields all default (`transition`, `actor`, `reason` null; `conditions` []; `conditions_deadline`, `conditions_poll_ms`, `conditions_note` null), so M1 rows parse.
- **Conditions phase** (U-058, U-059, U-063). Status `waiting_external`, card in the source column, worker ended, no wall time, machine slot held (TD). The engine emits `run_action {action: 'evaluate_conditions', args: EvaluateConditionsArgs {conditions (enabled ones, in order), pr_url: context.__pr.pr_url ?? null, branch}}` on the session's machine; no new outbox kind. The daemon acks, then reports `action_result {result: EvaluateConditionsResult {results: [{type, status: met|pending|failed|unsupported, value, detail}]}}`, one per condition in order → `action.completed`. `step.conditions` holds one `ConditionStatus {type, label, status, value, detail, checked_at}` per **declared** condition (disabled ones `disabled`). All met → enter `to`; any `failed` → `on_unmet.goto` with the evidence, counted; `condition_timeout` (`step.conditions_deadline`) → `on_unmet.else`; else re-poll after `conditions_poll_ms` (from `condition_poll`, default `DEFAULT_CONDITION_POLL` 2m, doubling to `MAX_CONDITION_POLL` 15m). A refused or timed-out evaluation keeps it pending with `conditions_note = CONDITIONS_NO_MACHINE_NOTE`.
- **Card.** `BoardCard.kind` (null for older tickets); `pending` `{transition, to, title, items: [{label, status, detail}], note}` from `pendingOfStep(def, step)` for any gate step (supersedes `checking`, which is kept for one release; `checking.phase` gains `conditions`); `human_transitions` `[{name, title, goto, needs_text}]` while `needs_input` in a human state or `waiting_external` in an event state, outside a step. `needs_text` (`transitionNeedsText`): `RETURN_TO` or an event-state target.
- **Moves.** `SessionDetail.moves?` = the last 50 `state.entered` rows as `MoveDto {at, from, to, transition, reason, actor}` (`toMoveDto`; optional on the wire so older servers parse).
- **Ticket kind.** `TicketKindSchema` `work | personal`. `ticket.kind` is M1b-T04's migration; `TicketRow.kind` lands with it (the schema test holds row types equal to the DDL), and until then readers use `kind ?? null` (`toSnapshot`, `CardTicketLike.kind?`). `CreateTicketRequest.kind` is optional in the schema (TD, until T04 and T07 merge); the route requires it.
- **Legacy fold.** `foldLegacyRequirements(def)`: `entry` → every non-fallback transition into the state; ADR-0009 `requirements` → `requires.review` + `on_unmet`; gate items first, gate model and `on_unmet` win, existing `requires` fields win. The engine never folds.

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
| `start_session.workflow_state`, `prompt`, `tools`, `resume_claude_session_id`, `model`, `max_turns`, `max_budget_usd`, `review`, `transitions` | the effect (`state` → `workflow_state`; optional fields omitted when absent; `transitions` also omitted when empty). `review: true` only on a requirements reviewer's start ([ADR-0009](../adr/0009-transition-requirements-review.md)) |
| `start_session.env` | `{CONDUCTOR_SESSION_ID, CONDUCTOR_TICKET_ID}`. The workflow schema has no per-state env in M1; ports and git identity are added by the daemon (ADR-0005 §Spawn) |
| `send_input.input_request_id`, `text` | the effect |
| `send_message.target_command_id` | `snapshot.agent_command_id` after apply (the live process the message is for; the daemon refuses it for any other process) |
| `send_message.text` | the effect |
| `run_cmd.workflow_state`, `cmd`, `cwd`, `timeout_ms` | the effect (`state` → `workflow_state`) |
| `run_action.workflow_state`, `target_state`, `action`, `idempotency_key`, `args` | the effect (`state` → `workflow_state`). `action` is `open_pr` or `evaluate_conditions` (ADR-0011); anything else throws |
| `run_action.branch` | `session.branch` (informational: the daemon pushes the branch it recorded for the session) |
| `run_action.expected_sha` | the effect (`step.head_sha`, the commit the checks ran on) |
| `kill.target_command_id` | the effect's `target_command_id`, else `null`: kill every process of the session at or below the envelope token (e.g. `operator.cancel`). Set by the engine only when a gate step starts (the worker's own `start_session`, ADR-0010) and by the gateway's direct orphan kills |
| `kill.reason` | the effect |

## Wall time

`session.wall_seconds` is maintained by apply (T04), which gets `now`: on every state transition it adds `now − state_entered_at` for the state being left, then sets `state_entered_at = now`. Time in `human` and `event` states is not added (parked time doesn't count toward `budget.minutes`, [09](09-security-and-budgets.md#budgets)). A requirements review's time is added when the review step is left, as part of its source state's ([ADR-0009](../adr/0009-transition-requirements-review.md)). Nothing else writes it. M1 has no enforcement trigger on it (like `budget.exceeded`, TD-015).

## Guards

A state's `guard` names an evaluator in `GUARD_REGISTRY` (`shared/src/workflow/guards.ts`): `(input: {def, snapshot, result}) => boolean`, pure. apply (T04) calls `evaluateGuard(name, input)` on `agent.complete_state` before leaving the state; false → the state's `fail` outcome, or `needs_input` if the state has no `fail`. **The M1 registry is empty and an unregistered guard fails closed** (`evaluateGuard` returns false → the state's `fail` outcome, or `needs_input` if it has none; TD-017). The validator (T03) accepts any guard name, so both reference workflows validate. `pr_flow`'s `open_pr` therefore always routes to needs_input in M1 (pr_flow isn't an M1 workflow); registering it needs commit facts in the `complete_state` event, and at that point an unregistered guard becomes a validator error.

## Tools

`TOOL_ALIASES` (`shared/src/workflow/tools.ts`) maps each workflow `tools` name to an ADR-0005 `ToolPolicy` fragment: `read` (base only), `edit` (`Edit(./**)`, `Write(./**)`: path-scoped, never bare), `bash` (`npm run:*`, `npm test:*`, exact `npm install` / `npm ci`; no interpreters or general runners), `git` (exact inspection commands, because diff/log/show accept `--output=<file>`, plus `add:*`, `commit:*`, `restore:*`; Claude Code also auto-allows commands it classifies as read-only), `pr_skill` (`Skill`, `gh pr view:*`; `gh pr create` is denied because it can push, so the PR is opened by a trusted state, TD-020), `review` (the requirements reviewer, [ADR-0009](../adr/0009-transition-requirements-review.md): `Bash` visible, only the exact read-only commands in `REVIEW_GIT_COMMANDS` pre-approved (`git status`, `git diff`, `git diff --stat HEAD~1`, `git log -p -n 5`, `git show --stat`…); no prefix rules, no edit tools, no staging or committing). `resolveToolPolicy(tools)` merges `BASE_TOOL_POLICY` (worktree-scoped `Read(./**)`/`Glob(./**)`/`Grep(./**)`, deny `Bash(git push:*)`) with each fragment, de-duplicates, and drops any allow rule that is also denied; it throws `UnknownToolAliasError` on a name not in `TOOL_ALIAS_NAMES` (T03 validates against the same list). `git push` is always denied. Since [ADR-0006](../adr/0006-agents-inherit-claude-code-settings.md) the `builtin` list still limits the visible tools, but `allow` rules only **pre-approve**: the user's own Claude Code settings (mode and rules) decide everything else, and the edit-guard hook keeps file edits in the worktree. **These rules are not a sandbox**: `npm run` executes repo scripts the agent can edit (TD-019), so the security boundary is the OS-level sandbox (U-004, slice 3). The daemon (T05) calls it on `start_session.tools`; the driver adds the conductor MCP tools.

## REST error map

T08 maps a non-applied `applyEvent` result with `httpForApplyResult(route, result)` (`shared/src/api/rest.ts`); `applied` → **202** `{ok: true}` on `/input`, `/approve`, `/cancel` and `/messages`.

| Result | HTTP | `ApiError.code` |
|---|---|---|
| rejected `unknown_session` | 404 | `not_found` |
| rejected `input_request_not_found` | 404 | `not_found` |
| rejected `input_already_answered` | 409 | `input_already_answered` |
| rejected `invalid_goto` | 400 | `bad_request` |
| rejected `stale_fencing_token` (not reachable from REST) | 409 | `conflict` |
| ignored (any `APPLY_IGNORE_REASONS`) on `/input` | 409 | `input_not_pending` |
| ignored on `/approve`, `/cancel`, `/messages`, `/transition` (ADR-0011) | 409 | `conflict` |

ADR-0008 routes that don't go through `applyEvent`: `GET /api/sessions/:id/transcript` → 200 `TranscriptResponse`; 404 `not_found` (unknown session), 404 `no_transcript` (daemon error `no_transcript` / `unknown_session`), 502 `internal` (`read_failed`), 503 `machine_offline` (session has no machine, machine not connected, or its socket closed while waiting), 504 `timeout`. `POST /api/sessions/:id/reopen` → 202 `ReopenSessionResponse {session_id}`; 409 `conflict` (not done/failed, or not the latest); 404 `not_found`; 400 `bad_request`.

`POST /api/sessions/:id/approve` body `ApproveSessionRequest {comment?}` → `external.event {name: 'ui.approve', data: {comment}}` (no `data` without a comment). `/cancel` body `{reason?}` → `operator.cancel {reason}`. `/messages` body `SendMessageRequest {text}` (trimmed, 1–20 000 chars) → `operator.message {text}`; on `applied`, after the commit, T08 appends the text to the `OutputBus` as a `user` chunk ([ADR-0007](../adr/0007-live-messages-to-agents.md)). Request-body validation failures are 400 `bad_request` with `details`.

## Composition root

`packages/orchestrator/src/main.ts` defines the factory signatures and `composeOrchestrator(factories, config)`, which wires db → buses (`InMemoryBoardBus`, `InMemoryOutputBus`) → `createEngineService` → `createGateway({engine})` → `createApi` (with `transcripts: gateway.transcripts`, ADR-0008) → `gateway.attach(api.server)`; `start()` runs `engine.startWorkers({transport: gateway.transport})` (outbox dispatcher + timeout sweep) then `api.listen(port, '127.0.0.1')`. `start()` first seeds `conductor` v1 (`seedConductorWorkflow`, `src/engine/seed.ts`; idempotent, [ADR-0010](../adr/0010-one-workflow-columns-are-states.md)). Ownership: **T04** implements `createEngineService` in `src/engine/index.ts`, **T11** `createGateway` in `src/gateway/index.ts` (WS on `API_PATHS.daemonWs` = `/ws/daemon`, via the HTTP server's `upgrade`), **T08** `createApi` in `src/api/index.ts`, and **T07** adds `main()` (env, real factories, signals). `createDb` (a `pg.Pool`) lives in `main.ts`.

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
