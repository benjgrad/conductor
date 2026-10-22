# 03 · Protocols

The API has two faces. **UI ↔ orchestrator** uses REST plus SSE. **Daemon ↔ orchestrator** uses one long-lived bidirectional WebSocket, which the daemon dials out to open.

## UI ↔ orchestrator

### REST (indicative)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/board` | Cards grouped by column (snapshot + `last_event_id`) |
| GET | `/api/sessions/:id` | Detail: state, context, pending input request, recent output (ring buffer) |
| POST | `/api/sessions/:id/input` | Answer the pending input request `{input_request_id, answer}` |
| POST | `/api/sessions/:id/approve` | Emits `ui.approve` (for `await_approval`-style event states) |
| POST | `/api/sessions/:id/pause` · `/cancel` | Operator controls |
| POST | `/api/tickets` | Create a ticket manually (v1 source, [U-003](../tracking/UNKNOWNS.md)) |
| GET/POST | `/api/workflows` | List / save a new workflow version (validated on save) |
| GET | `/api/machines` | Fleet view |

### SSE
- `GET /api/stream/board` gives board-level events only (`card.moved`, `session.status`, `input.requested`, `input.answered`). Reconnects send `Last-Event-ID`, and the server replays from the `event` table.
- `GET /api/stream/sessions/:id/output` streams terminal output for **the one open session**. On connect it replays the ring buffer, then sends live chunks. Output never reaches browsers that aren't looking at it.

## Daemon ↔ orchestrator (WebSocket)

Every message is an envelope:

```json
{ "type": "…", "msg_id": "uuid", "seq": 42, "session_id": "…|null", "fencing_token": 7, "payload": { } }
```

### Daemon → orchestrator
| type | payload | notes |
|---|---|---|
| `register` | machine facts, tags, budgets, max_sessions | first message, carries the enrollment token ([U-008](../tracking/UNKNOWNS.md)) |
| `heartbeat` | live cpu/mem/disk, running session ids + their fencing tokens | renews machine + session leases |
| `repo_inventory` | `[{repo, path, head_commit, tree_clean}]` | on change |
| `request_work` | free slots, repo inventory digest, live resources | the pull scheduler entry point ([04](04-scheduler.md)) |
| `command_ack` | `{command_id, accepted, reason?}` | daemon may refuse (memory pressure) |
| `session_event` | `{kind, data}` where kind ∈ `started`, `claude_session_id`, `complete_state`, `ask_user`, `exit`, `cmd_exit`, `spend`, `heartbeat` | carries `seq`, durable outcomes |
| `output` | terminal chunk | not persisted to Postgres |

### Orchestrator → daemon
| type | payload |
|---|---|
| `work_assignment` / `no_work` / `retry_after` | response to `request_work` (see short-hold) |
| `start_session` | ticket, repo, base ref, branch, prompt, tool allow-list, resume `claude_session_id?`, env (port range) |
| `run_cmd` | cmd, cwd (worktree), timeout |
| `send_input` | answer text |
| `kill` | reason (e.g. `stale_fencing_token`) |

## Delivery guarantees

- **Commands**: written to the `outbox` in the same transaction as the state change, and delivered **at least once**. Each carries `command_id`. The daemon keeps a dedupe set of recently seen `command_id`s, persisted to disk.
- **Daemon events**: buffered on local disk with a per-daemon monotonic `seq`. On reconnect the daemon replays everything after the orchestrator's last acknowledged `seq`. The orchestrator dedupes on `(machine_id, seq)`.
- **Fencing**: any `session_event` whose `fencing_token` is lower than `session.fencing_token` is rejected. The orchestrator answers with `kill`.
- **Exactly-once state changes** come from the transactional engine apply. Side effects outside our DB need idempotency keys ([05](05-workflow-engine.md#idempotency)).
