# 08 · Failure modes

The ones that bite first, in rough order of likelihood.

## Laptop sleep

This is the case to test hardest (chaos test in [TEST_STRATEGY](../qa/TEST_STRATEGY.md)).

```mermaid
sequenceDiagram
  participant L as Laptop daemon (token 7)
  participant O as Orchestrator
  participant P as Postgres
  participant B as Other daemon
  L->>O: heartbeat (session S, token 7)
  Note over L: lid closes — heartbeats stop
  O->>P: reaper: S.lease_expires_at + 2 min grace < now()
  O->>P: S.status = lost; event session.lost
  O->>P: requeue: S.status = queued, fencing_token = 8, resume = claude_session_id if branch pushed
  B->>O: request_work
  O->>P: claim S (token 8) on B
  O->>B: start_session {resume claude_session_id, branch conductor/T/S}
  Note over L: lid opens — daemon reconnects, replays buffered events
  L->>O: session_event (S, token 7, seq …)
  O->>O: 7 < 8 → reject, do not insert
  O->>L: kill {session S, reason stale_fencing_token}
  L->>L: kill process, keep worktree for GC
```

Notes:
- **Resume vs restart**: resume needs the branch pushed. Agent states checkpoint (commit + push to the session branch) when they enter `needs_input` / park, and every N minutes ([U-011](../tracking/UNKNOWNS.md)). Without a pushed branch, the new incarnation restarts the *current state* from the last pushed commit.
- **Git remote safety**: fencing protects the DB only. Two incarnations could both push, but each session has its **own branch**, so they never fight over a shared one. The new incarnation is the only one whose PR the orchestrator will accept.
- The **requeue limit** is 3 lost incarnations per session. After that, `failed` → Failed column.

## Daemon stream drops (network blip)
- The daemon keeps supervising local sessions and buffers events to disk with `seq`. It reconnects with backoff and replays.
- The lease grace (2 min) means a blip never marks a session lost.

## Orchestrator crash mid-transition
- The state change and outgoing commands commit atomically through the outbox, so nothing is lost. On restart, the dispatcher re-sends `pending`/`sent`-but-unacked rows, and daemons dedupe on `command_id`.
- In-flight SSE clients reconnect with `Last-Event-ID`.
- Terminal output ring buffers are lost on crash. That's acceptable; the durable record is in `event`.

## Live feed overload
- ~2k events/s peak is mostly terminal output. That output stays out of Postgres, goes to an in-memory broadcaster with a bounded ring buffer per session, and is streamed only to viewers of that session.
- Escape hatch if we outgrow one orchestrator: Redis Streams or NATS. Add one only when needed.

## Side effects that can't run twice
- **Connectors** (ticket, Azure, Jira) use idempotency keys ([05](05-workflow-engine.md#idempotency)).
- **Slack post via agent skill** can't be deduped. An occasional duplicate is **accepted and documented**.
- **PR creation** via the agent skill: a guard checks for an existing PR on the session branch before the state runs, and if one exists its URL is reused.

## Runaway agents
- Per-session budgets (`usd`, `minutes`) and per-loop retry caps route to `needs_input` (`budget_exceeded` / `retries_exhausted`). Never silently continue.

## Daemon refuses a start
- `command_ack accepted=false` → session `queued`, ticket `ready`, event recorded. A machine that refuses 3 times in a row is skipped for 1 min.
