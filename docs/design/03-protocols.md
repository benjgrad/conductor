# 03 · Protocols

The API has two faces. **UI ↔ orchestrator** uses REST plus SSE. **Daemon ↔ orchestrator** uses one long-lived bidirectional WebSocket, which the daemon dials out to open.

The exact shapes are zod schemas in `packages/shared` (M1-T12): `protocol/ws.ts` (+ one fixture per message in `protocol/fixtures.ts`), `api/rest.ts`, `api/sse.ts`. Index: [10-contracts](10-contracts.md).

## UI ↔ orchestrator

### REST (indicative)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/board` | Cards grouped by column (snapshot + `last_event_id`) |
| GET | `/api/sessions/:id` | Detail: state, context, pending input request, recent output (ring buffer) |
| POST | `/api/sessions/:id/input` | Answer the pending input request `{input_request_id, answer, goto?}` (`goto` = "skip to <state>"). Becomes the engine event `input.provided`. 409 if already answered |
| POST | `/api/sessions/:id/approve` | `{comment?}` → `external.event ui.approve` (for `await_approval`-style event states); 202, 409 `conflict` if not awaited. Error map: [10](10-contracts.md#rest-error-map) |
| POST | `/api/sessions/:id/messages` | `{text}` (trimmed, 1–20 000 chars) → `operator.message`: a message to the agent while it runs, written into its live process ([ADR-0007](../adr/0007-live-messages-to-agents.md), [06](06-human-input.md#live-messages-to-a-running-agent)). A `/...` text is passed through and Claude Code runs it as a slash command. 202; 409 `conflict` unless the session is `running` an agent state with a live process; 404 unknown session. The text is also appended to the output ring as a `user` chunk |
| POST | `/api/sessions/:id/pause` · `/cancel` | Operator controls |
| POST | `/api/tickets` | Create a ticket manually (v1 source, [U-003](../tracking/UNKNOWNS.md)) |
| GET/POST | `/api/workflows` | List / save a new workflow version (validated on save) |
| GET | `/api/machines` | Fleet view |

### SSE
- `GET /api/stream/board` gives board-level events only (`card.upserted`, `card.moved`, `session.status`, `input.requested`, `input.answered`, `card.badge`). Each one is backed by exactly one `event` row (row `type` = SSE type, `payload` = the event minus `id`/`ts`/`session_id`), and the frame's `id` is that row's id. Reconnects send `Last-Event-ID`, and the server replays board-typed rows from the `event` table ([10](10-contracts.md#board-events-and-the-event-table)). `card.upserted` carries the whole card (new tickets, claims, state/spend changes); the client keeps one card per `ticket_id`. The SSE event `input.answered` is distinct from the engine event `input.provided` on purpose. Without `Last-Event-ID` (or `?last_event_id=`, for the first `EventSource` connect, which can't set headers) the stream starts at the current max board id. Frames always come from the `event` table, read in id order past a per-connection cursor; a `BoardBus` publish only wakes the reader. Board rows commit in id order and are published after COMMIT, so the hand-off from replay to live has no gap and no duplicate (M1-T08).
- `card.badge` toggles a card badge (`waiting_for_build_slot`). A badge is not a session status.
- `GET /api/stream/sessions/:id/output` streams terminal output for **the one open session**. On connect it replays the ring buffer, then sends live chunks. Output never reaches browsers that aren't looking at it. Besides the daemon's streams it carries `user` chunks (a human's live message, appended by the orchestrator because Claude does not echo user messages) and a `debug` line when the daemon refuses a live message ([ADR-0007](../adr/0007-live-messages-to-agents.md)).

## Daemon ↔ orchestrator (WebSocket)

The daemon dials `ws://<host>:<CONDUCTOR_PORT>/ws/daemon` (`API_PATHS.daemonWs`; port default 7400), served by the same HTTP server as the API ([10](10-contracts.md#composition-root)).

Every message is an envelope:

```json
{ "type": "…", "msg_id": "uuid", "seq": 42, "session_id": "…|null", "fencing_token": 7, "payload": { } }
```

- `seq` is the per-daemon monotonic sequence. It is **required on `session_event`** (deduped on `(machine_id, seq)`), nullable on other daemon messages, and `null` on orchestrator messages.
- `session_id` + `fencing_token` are required on session-scoped messages (`session_event`, `output`, and every orchestrator command) and `null` on machine-level ones.
- Outbox commands (`start_session`, `run_cmd`, `send_input`, `send_message`, `kill`) carry `payload.command_id`. The daemon dedupes on it and answers with `command_ack`. Their envelope `fencing_token` is the one stored on the outbox row (the session's token when the command was written), and the field-by-field effect mapping is in [10](10-contracts.md#effect--ws-fields).

### Daemon → orchestrator
| type | payload | notes |
|---|---|---|
| `register` | machine facts, tags, budgets, max_sessions, max_concurrent_builds, daemon + Claude Code versions | first message, carries the enrollment token ([U-008](../tracking/UNKNOWNS.md); `null` in M1). Upserts the `machine` row (`status = online`), including `claude_code_version` ([U-032](../tracking/UNKNOWNS.md), [02](02-data-model.md#machine)) |
| `heartbeat` | live cpu/mem/disk, running session ids + their fencing tokens | renews machine + session leases. `cpu_free` is stored as `floor()` (an int column) |
| `repo_inventory` | `[{repo, path, head_commit, tree_clean}]` | on change |
| `request_work` | free slots, repo inventory digest, live resources | the pull scheduler entry point ([04](04-scheduler.md)) |
| `command_ack` | `{command_id, accepted, reason?}` | daemon may refuse. Known reasons: `memory_pressure`, `max_sessions`, `no_live_process` (send_input with no live Claude process → resume path; send_message with no live process for its `target_command_id`), `unknown_session`, `agent_parked` (send_message to a process parked after `ask_user` / `no_outcome`) |
| `session_event` | `{kind, data}` where kind ∈ `started`, `claude_session_id`, `complete_state`, `ask_user`, `no_outcome`, `exit`, `cmd_exit`, `spend`, `build_slot`, `heartbeat` | carries `seq`, durable outcomes. A session `heartbeat` also renews that session's lease |
| `output` | `{stream, text, ts}` terminal chunk | not persisted to Postgres; goes into the per-session ring (256 KB) |

`session_event` kinds come from the [ADR-0005](../adr/0005-claude-code-driver.md) driver: `claude_session_id`, `ask_user`, `complete_state`, `spend` and `exit` are the driver's events forwarded as-is (snake_cased); `exit` also carries the `command_id` of the `start_session` that spawned the process, so a late exit of an earlier process is told apart from the current one. The driver's `output` goes to the `output` message, and its `turn_end` stays in the daemon. The daemon itself produces `started` (`{command_id, worktree_path, branch, port_range}`, only for `start_session`, never for `run_cmd`), `cmd_exit` (`{command_id, exit_code, signal, timed_out, duration_ms, output_tail}`, tail ≤ 16 KB), `build_slot` (`{waiting}`: the command is queued on the build semaphore; a card badge, not a status), `heartbeat`, and `no_outcome` (`{last_output}`, the tail of the agent's assistant text, ≤ `NO_OUTCOME_OUTPUT_CHARS` = 4000 chars): two turns in a row ended without `complete_state`/`ask_user`, the second after the daemon's one nudge ([ADR-0005 addendum](../adr/0005-claude-code-driver.md#addendum-2026-10-22-turns-without-an-outcome-u-028)). The engine routes it like `ask_user` (`agent.no_outcome` → `agent_question`).

**Link details (M1-T11).** `registered.heartbeat_interval_ms` defaults to 10 s. When a daemon's socket closes, its machine is marked `offline` (unless a newer connection for the same machine id replaced it), and a second connection for a machine id replaces the first (closed with 4000). `command_ack` updates only the outbox row whose `target` is `machine:<the acking machine>`. The `superseded_start` kill's envelope carries the session's current fencing token ([10](10-contracts.md#orphaned-processes)).

**`spend` is cumulative.** `data = {claude_session_id, total_usd, usage}`. `total_usd` is the Claude session's cumulative cost, and it survives `--resume`. The orchestrator stores the last total per `claude_session_id` in `session.claude_spend_totals` ([02](02-data-model.md#session)) and adds only the positive delta to `session.spend_usd`, so replays and duplicates are harmless.

### Orchestrator → daemon
| type | payload |
|---|---|
| `registered` | `{machine_id, last_seq, heartbeat_interval_ms}`: reply to `register`; `last_seq` is where replay starts |
| `work_assignment` / `no_work` / `retry_after` | response to `request_work` (see short-hold). `work_assignment` is `{ticket_id, session_id}`; the `start_session` command follows through the outbox |
| `start_session` | `command_id`, ticket, repo, base ref (M1: `HEAD` of the shared clone), branch, workflow state, prompt (rendered by `apply`, [05](05-workflow-engine.md#prompt-render); nulled in `outbox.payload` once the row is terminal, [U-039](../tracking/UNKNOWNS.md)), the state's workflow `tools` list (the daemon maps it to the ADR-0005 `ToolPolicy`), `resume_claude_session_id?`, model / max turns / max budget, env. When `resume_claude_session_id` is null, **the daemon pre-assigns the Claude session id** (`--session-id`), persists it before spawning, and reports it with `session_event claude_session_id`. The daemon allocates the port range itself ([07](07-multi-session-isolation.md)) |
| `run_cmd` | `command_id`, workflow state, cmd, cwd (relative to the worktree; null = root), `timeout_ms` |
| `send_input` | `command_id`, `input_request_id`, answer text (a user message on the live process's stdin) |
| `send_message` | `command_id`, `target_command_id` (the `start_session` whose process it is for), `text` (nulled in `outbox.payload` once the row is terminal). A human's live message, written to that process's stdin as a user message; it is not an answer, so `ask_user` / nudge state is untouched. Refused (`no_live_process`) unless that process is live, not completed and runs at or below the envelope fencing token; refused `agent_parked` while it waits for a human ([ADR-0007](../adr/0007-live-messages-to-agents.md)) |
| `kill` | `command_id` (null when it's a direct reply), `target_command_id` (the `start_session` whose process to kill, or null), reason (e.g. `stale_fencing_token`, `ack_timeout`, `superseded_start`). The daemon kills only that process when `target_command_id` is set, otherwise only a process of the session running under a fencing token ≤ the envelope's ([10](10-contracts.md#orphaned-processes)) |
| `protocol_error` | `{code, message, ref_msg_id}`: the orchestrator could not accept a message (invalid envelope, not registered, …) |

## Delivery guarantees

- **Commands**: written to the `outbox` in the same transaction as the state change, and delivered **at least once** (outbox state machine: [10](10-contracts.md#outbox-state-machine)). Each carries `command_id`. The daemon keeps a dedupe set of recently seen `command_id`s, persisted to disk.
- **Daemon events**: buffered on local disk with a per-daemon monotonic `seq`. On reconnect the daemon replays everything after `registered.last_seq`. After each `registered`, its next `seq` is `max(local persisted seq + 1, registered.last_seq + 1)`, so a daemon that lost its local state never reuses a seq the orchestrator has already processed. The orchestrator dedupes on `(machine_id, seq)` with `machine.last_seq`: a guarded `UPDATE machine SET last_seq = $seq WHERE id = $m AND (last_seq IS NULL OR last_seq < $seq)` in the same transaction as the event's apply; row count 0 = duplicate, skipped ([10](10-contracts.md#daemon-seq-dedupe)).
  - *Bounded buffer (M1):* there is no per-event ack, so the buffer is trimmed only on `registered`. It is capped at 5000 events (`MAX_BUFFERED_EVENTS`, `daemon/src/store.ts`); past the cap the oldest are dropped even if unconfirmed, so a daemon disconnected through more than 5000 events loses the oldest (TD-025).
  - *Process lost with the daemon:* Claude processes do not outlive the daemon. On start, for every session whose persisted agent process was live, the daemon emits `exit {command_id: <that start's command_id>, code: null, signal: 'daemon_restart'}` under that start's fencing token. It matches `agent_command_id`, so the orchestrator resumes the session instead of waiting for the lease to expire.
- **Fencing**: any `session_event` whose `fencing_token` is lower than `session.fencing_token` is rejected. The orchestrator answers with `kill`.
- **Exactly-once state changes** come from the transactional engine apply. Side effects outside our DB need idempotency keys ([05](05-workflow-engine.md#idempotency)).
