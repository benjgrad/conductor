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
- **The conversation stays on its machine**: Claude Code keeps a conversation's transcript only where it ran, so another machine can't `--resume` it. The daemon refuses such a start `no_conversation` before spawning; the orchestrator forgets the Claude session id and the re-claim starts a fresh conversation with the full state prompt and any pending answer ([10 §Refusals](10-contracts.md#refusals)). The event row `conversation.reset` records it. For a broken conversation the daemon can't detect (a corrupt transcript, Claude failing on every resume), the human uses "Start fresh conversation…" on the failure question ([10 §Fresh conversation](10-contracts.md#fresh-conversation)): the same reset, with their message, recorded `user_requested`.
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

## Permission prompt held open

[ADR-0023](../adr/0023-permission-prompts-through-conductor.md), contract in [10 §Permission prompts](10-contracts.md#permission-prompts). An agent's tool call waits on a human (`needs_permission`). Every path ends in a decision or a deny, within a bound:
- **Nobody answers**: the daemon denies the call at `expires_at` (30 min by default) with "no human answered"; the agent can then `ask_user`, which reaches a human the usual way. The orchestrator marks the request `expired` (`timeout`) at the same time and clears the card.
- **Socket drop while held**: the request is durable (`seq`), so it is replayed on reconnect and deduped on `request_id`. A decision is sent once on the live socket (U-099, no outbox row): one made while the machine is away is stored but not delivered, and the daemon keeps holding the call until its timeout denies it (TD-179).
- **Daemon restart while held**: the held MCP call dies with the old process, and with it the Claude process ([03 §Delivery](03-protocols.md#delivery-guarantees): Claude processes don't outlive the daemon). On reconnect the daemon's `exit {signal: 'daemon_restart'}` expires the request (`agent_gone`) and clears the card; a decision that still arrives is refused `unknown_permission_request`. Net effect: a deny on reconnect.
- **Orchestrator restart**: pending requests are rows, so they survive, and so does the card. A decision already recorded is not re-sent (no outbox row, U-099); if its frame was lost, the daemon's timeout denies the call. A human clicking again gets the stored decision back (idempotent on `request_id`), not a second command; the daemon resolves a `request_id` at most once anyway.
- **Two humans, two different answers**: the first one wins; the second gets 409 `permission_not_pending`.
- **The session moves on** (cancel, budget, a lost machine, the agent's own exit): the pending request expires (`session_moved` / `agent_gone`) in the same transaction, so the card never shows a prompt nobody can answer.
- **Old server**: a daemon talking to a pre-T29 orchestrator gets `protocol_error` for the request and denies at once.

## Bad daemon update

[ADR-0021](../adr/0021-daemon-auto-update.md). A deploy serves a daemon build that crashes on start or can't register.
- The daemon only switched after draining, so no turn was cut. `<root>/daemon/trial` records `from` / `to`.
- The launcher (`<root>/bin/conductor-launch`, outside every version) counts starts. On the third start it repoints `current` to `from` and records `to` in `bad-versions`.
- The old version comes back, sends `alert update_failed` (stage `trial`), and ignores `update_available` for that version, so it doesn't loop. A human sees it on the Machines page; the next deploy's build is tried normally.
- A laptop that wakes without a network is not rolled back: only a crash, or reaching the server without `registered` in 120 s, counts as a failed start.
- Not covered: a new build that hangs without exiting and never reaches the server. It shows as offline + outdated; recovery is a manual `install.sh` re-run.
