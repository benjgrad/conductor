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
| POST | `/api/sessions/:id/approve` | Emits `ui.approve` (for `await_approval`-style event states) |
| POST | `/api/sessions/:id/pause` · `/cancel` | Operator controls |
| POST | `/api/tickets` | Create a ticket manually (v1 source, [U-003](../tracking/UNKNOWNS.md)) |
| GET/POST | `/api/workflows` | List / save a new workflow version (validated on save) |
| GET | `/api/machines` | Fleet view |

### SSE
- `GET /api/stream/board` gives board-level events only (`card.upserted`, `card.moved`, `session.status`, `input.requested`, `input.answered`, `card.badge`). Each one is backed by exactly one `event` row (row `type` = SSE type, `payload` = the event minus `id`/`ts`/`session_id`), and the frame's `id` is that row's id. Reconnects send `Last-Event-ID`, and the server replays board-typed rows from the `event` table ([10](10-contracts.md#board-events-and-the-event-table)). `card.upserted` carries the whole card (new tickets, claims, state/spend changes); the client keeps one card per `ticket_id`. The SSE event `input.answered` is distinct from the engine event `input.provided` on purpose.
- `card.badge` toggles a card badge (`waiting_for_build_slot`). A badge is not a session status.
- `GET /api/stream/sessions/:id/output` streams terminal output for **the one open session**. On connect it replays the ring buffer, then sends live chunks. Output never reaches browsers that aren't looking at it.

## Daemon ↔ orchestrator (WebSocket)

Every message is an envelope:

```json
{ "type": "…", "msg_id": "uuid", "seq": 42, "session_id": "…|null", "fencing_token": 7, "payload": { } }
```

- `seq` is the per-daemon monotonic sequence. It is **required on `session_event`** (deduped on `(machine_id, seq)`), nullable on other daemon messages, and `null` on orchestrator messages.
- `session_id` + `fencing_token` are required on session-scoped messages (`session_event`, `output`, and every orchestrator command) and `null` on machine-level ones.
- Outbox commands (`start_session`, `run_cmd`, `send_input`, `kill`) carry `payload.command_id`. The daemon dedupes on it and answers with `command_ack`.

### Daemon → orchestrator
| type | payload | notes |
|---|---|---|
| `register` | machine facts, tags, budgets, max_sessions, max_concurrent_builds, daemon + Claude Code versions | first message, carries the enrollment token ([U-008](../tracking/UNKNOWNS.md); `null` in M1) |
| `heartbeat` | live cpu/mem/disk, running session ids + their fencing tokens | renews machine + session leases |
| `repo_inventory` | `[{repo, path, head_commit, tree_clean}]` | on change |
| `request_work` | free slots, repo inventory digest, live resources | the pull scheduler entry point ([04](04-scheduler.md)) |
| `command_ack` | `{command_id, accepted, reason?}` | daemon may refuse. Known reasons: `memory_pressure`, `max_sessions`, `no_live_process` (send_input with no live Claude process → resume path), `unknown_session` |
| `session_event` | `{kind, data}` where kind ∈ `started`, `claude_session_id`, `complete_state`, `ask_user`, `exit`, `cmd_exit`, `spend`, `build_slot`, `heartbeat` | carries `seq`, durable outcomes |
| `output` | `{stream, text, ts}` terminal chunk | not persisted to Postgres; goes into the per-session ring (256 KB) |

`session_event` kinds come from the [ADR-0005](../adr/0005-claude-code-driver.md) driver: `claude_session_id`, `ask_user`, `complete_state`, `spend` and `exit` are the driver's events forwarded as-is (snake_cased); `exit` also carries the `command_id` of the `start_session` that spawned the process, so a late exit of an earlier process is told apart from the current one. The driver's `output` goes to the `output` message, and its `turn_end` stays in the daemon. The daemon itself produces `started` (`{command_id, worktree_path, branch, port_range}`, only for `start_session`, never for `run_cmd`), `cmd_exit` (`{command_id, exit_code, signal, timed_out, duration_ms, output_tail}`, tail ≤ 16 KB), `build_slot` (`{waiting}`: the command is queued on the build semaphore; a card badge, not a status) and `heartbeat`.

**`spend` is cumulative.** `data = {claude_session_id, total_usd, usage}`. `total_usd` is the Claude session's cumulative cost, and it survives `--resume`. The orchestrator stores the last total per `claude_session_id` in `session.claude_spend_totals` ([02](02-data-model.md#session)) and adds only the positive delta to `session.spend_usd`, so replays and duplicates are harmless.

### Orchestrator → daemon
| type | payload |
|---|---|
| `registered` | `{machine_id, last_seq, heartbeat_interval_ms}`: reply to `register`; `last_seq` is where replay starts |
| `work_assignment` / `no_work` / `retry_after` | response to `request_work` (see short-hold). `work_assignment` is `{ticket_id, session_id}`; the `start_session` command follows through the outbox |
| `start_session` | `command_id`, ticket, repo, base ref (M1: `HEAD` of the shared clone), branch, workflow state, prompt, the state's workflow `tools` list (the daemon maps it to the ADR-0005 `ToolPolicy`), `resume_claude_session_id?`, model / max turns / max budget, env. When `resume_claude_session_id` is null, **the daemon pre-assigns the Claude session id** (`--session-id`), persists it before spawning, and reports it with `session_event claude_session_id`. The daemon allocates the port range itself ([07](07-multi-session-isolation.md)) |
| `run_cmd` | `command_id`, workflow state, cmd, cwd (relative to the worktree; null = root), `timeout_ms` |
| `send_input` | `command_id`, `input_request_id`, answer text (a user message on the live process's stdin) |
| `kill` | `command_id` (null when it's a direct reply), reason (e.g. `stale_fencing_token`) |
| `protocol_error` | `{code, message, ref_msg_id}`: the orchestrator could not accept a message (invalid envelope, not registered, …) |

## Delivery guarantees

- **Commands**: written to the `outbox` in the same transaction as the state change, and delivered **at least once** (outbox state machine: [10](10-contracts.md#outbox-state-machine)). Each carries `command_id`. The daemon keeps a dedupe set of recently seen `command_id`s, persisted to disk.
- **Daemon events**: buffered on local disk with a per-daemon monotonic `seq`. On reconnect the daemon replays everything after `registered.last_seq`. The orchestrator dedupes on `(machine_id, seq)` with `machine.last_seq`: a guarded `UPDATE machine SET last_seq = $seq WHERE id = $m AND (last_seq IS NULL OR last_seq < $seq)` in the same transaction as the event's apply; row count 0 = duplicate, skipped ([10](10-contracts.md#daemon-seq-dedupe)).
- **Fencing**: any `session_event` whose `fencing_token` is lower than `session.fencing_token` is rejected. The orchestrator answers with `kill`.
- **Exactly-once state changes** come from the transactional engine apply. Side effects outside our DB need idempotency keys ([05](05-workflow-engine.md#idempotency)).
