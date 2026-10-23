# 06 · Human input path

The human-input path uses the same machinery as everything else: an event, a state, an outbox command. The kanban column is a query.

## Sequence

```mermaid
sequenceDiagram
  participant CC as Claude Code
  participant D as Daemon
  participant O as Orchestrator
  participant UI as Web UI
  CC->>D: ask_user {question}          (structured tool, U-002)
  D->>O: session_event ask_user (seq, token)
  O->>O: apply → state needs_input, status needs_input, INSERT input_request
  O-->>UI: SSE input.requested → card jumps to "Needs input"
  UI->>O: POST /sessions/:id/input {answer}
  O->>O: apply(input.provided) → return_to state; outbox send_input
  alt daemon still holds the live process
    O->>D: send_input {answer}
    D->>CC: deliver answer, continue
  else process gone / machine released
    O->>O: session → queued (affinity to old machine)
    Note over O,D: next claim sends start_session with resume claude_session_id, first message = answer
  end
```

## Rules
- Every route into `needs_input` creates an `input_request` with a `kind`: `agent_question`, `retries_exhausted`, `budget_exceeded`, `timeout`, or `approval`. The question text for non-agent kinds is generated, e.g. "Tests failed 3 times. Last output attached. Retry, skip, or abort?"
- **Compute release**: a session parked in `needs_input` keeps its process alive but idle. After `park_release_after` (default **15 min**) the daemon checkpoints. That means the worktree is committed and pushed to the session branch and the `claude_session_id` is saved. Then the reservation is released. Answers that arrive after that go through the resume path.
- **Unmet requirements** ([ADR-0009](../adr/0009-transition-requirements-review.md), [05](05-workflow-engine.md#requirements-gates-adr-0009)). A gate's `on_unmet.else` is always a human state. It is entered with kind `retries_exhausted` and the question "Requirements for "implement" → "build" were not met after 3 reviews (retry limit 2):", one `- <item>: <reason>` line per unmet item, then "Retry, skip, or abort?". A review that produced no verdict uses `retries_exhausted` ("…produced no verdict (…)"), a review that timed out uses `timeout` ("…timed out (review timed out after 10m)"). No new kind: `input_request_kind` is a Postgres enum. `return_to` is the gate's source state, so an answer resumes the **worker's** Claude conversation with the answer (never the reviewer's); finishing that state goes through the gate again, and since the counter is already at its limit an unmet verdict comes straight back here. "Skip to <state>" bypasses the gate.
- Answering is idempotent per `input_request_id`. A second answer to the same request is rejected.
- `answered_by` records a UI user, or `slack:<id>` once Slack answering exists ([U-007](../tracking/UNKNOWNS.md)).

## Live messages to a running agent

A human can also talk to an agent that has **not** asked anything, while it works ([ADR-0007](../adr/0007-live-messages-to-agents.md)). This is not an answer and it never moves the workflow.

```mermaid
sequenceDiagram
  participant UI as Web UI
  participant O as Orchestrator
  participant D as Daemon
  participant CC as Claude Code
  UI->>O: POST /sessions/:id/messages {text}
  O->>O: apply(operator.message) → outbox send_message (no state change)
  O-->>UI: 202; output stream gets a `user` chunk with the text
  O->>D: send_message {target_command_id, text}
  alt that process is live and working
    D->>CC: user message on stdin (folded into the current turn)
    D->>O: command_ack accepted
  else parked, completed, gone, or another process
    D->>O: command_ack refused (agent_parked / no_live_process)
    O-->>UI: debug line "message not delivered" (workflow unchanged)
  end
```

- Accepted only while the session is `running` an **agent** state whose process is live; otherwise 409 `conflict`. A `needs_input` session is answered through `/input`, not `/messages`. A requirements reviewer ([ADR-0009](../adr/0009-transition-requirements-review.md)) does not take messages either (409): it is meant to judge the work independently.
- The text goes to Claude Code as-is. Claude folds a message written mid-turn into that turn, and a `/...` text runs as a Claude Code slash command (e.g. `/context`), its output coming back as assistant text (spike against claude 2.1.309, ADR-0007).
- **Not an answer.** The daemon does not clear its `ask_user` / nudge state for it, and the driver does not clear the outcome server's pending question. The turn still has to end with `complete_state` or `ask_user`; the [U-028 nudge](../adr/0005-claude-code-driver.md#addendum-2026-10-22-turns-without-an-outcome-u-028) counts turns as before.
- **Best effort.** A refusal is ignored by the engine (`message_refused`); the board shows it as a debug output line.

## Reopening a finished ticket

On a `done` or `failed` session the composer switches to **reopen** mode ([ADR-0008](../adr/0008-transcript-history-and-reopen.md)): the human types what to change ("Ask {agent} to change something…") and presses **Reopen**. `POST /api/sessions/:id/reopen {text}`:

- creates a **new session** of the same ticket (the old one stays as it was: it is terminal, so the one-live-session-per-ticket index allows it). Allowed only for the ticket's **latest** session, and only `done` / `failed`; otherwise 409. A `lost` session can't be reopened: its machine went away, which is what the reaper's requeue is for, and its conversation and worktree live on that machine;
- the new session is `queued` with the old session's **branch**, **context** and **Claude session id**, and the human's text as its pending answer (`pending_answer {input_request_id: null, answer: text}`). Retry counters, visits, spend, wall time and deadlines start fresh; the agent's name and avatar are per ticket, so the same agent comes back;
- the ticket goes back to `ready`; the claim runs it **only on the machine that ran that branch** (the worktree and Claude's transcript are there, [04](04-scheduler.md#2--claim-query-ticket-side)). Its `session.assigned` enters the workflow's start state and `start_session` **resumes the same Claude conversation** (`--resume <id>`) with the text as the prompt, as an answer's resume does ([10](10-contracts.md#pending-answer)); then build → test → done as usual;
- the daemon reuses the old session's worktree (the branch is still checked out there), so the files, uncommitted ones included, are the same;
- the panel switches to the new session. The text shows in its Messages as a `user` chunk.

## Message history after a restart

The output ring is in memory ([U-005](../tracking/UNKNOWNS.md)), so after an orchestrator restart every session's Messages tab is empty. When the panel opens on a session whose ring and live stream have nothing (and it has a machine), the web fetches `GET /api/sessions/:id/transcript` once: the daemon on the session's machine reads Claude Code's own transcript and maps it to the same output streams ([ADR-0008](../adr/0008-transcript-history-and-reopen.md)). A quiet notice says where the history came from: "History loaded from Claude's transcript on <machine>", "History unavailable: <machine> is offline", or "No transcript found". Live chunks that arrive later are appended after the history (one streamed between the transcript read and the first live chunk may show twice). The transcript is per Claude conversation, so a reopened ticket's sessions show the whole conversation, both passes; and it has no command (build/test) output, only the agent's side.

## Kanban columns: the workflow's states
[ADR-0010](../adr/0010-one-workflow-columns-are-states.md): the board's columns are the `conductor` workflow's states, in its `columns` order, with an implicit **Queued** first. Conductor v1: Queued · Planning · Implementing · Needs input · Waiting external · Done. Columns are queries over the session (`placeCard`, `packages/shared/src/api/rest.ts`), never stored:

| Card | Column | Badge |
|---|---|---|
| ticket `cancelled`, or session `failed` / `lost` | the terminal column (Done) | `cancelled` / `failed` / `lost` |
| no session yet, or `queued` / `assigned` before any state | Queued | |
| in a gate step (entry requirements, or an ADR-0009 review) | its source column (`step.from`) | `checking`, plus `checking: {to, title, phase}` |
| otherwise | its `workflow_state` | `waiting_for_build_slot` when set |

A state that is not a column (an older `conductor` version, or an old `m1_*` workflow) maps by its type: terminal → Done, human → Needs input, event → Waiting external, agent / command / connector → Implementing. The status ("running", "assigned"…) is shown on the card, not as a column. The card also carries the PR conductor opened (`pr_url`, from `context.<state>.pr_url`).

Sort, by the column's kind: Queued by priority then age; human (Needs input) oldest open input_request first, with the question badge; event (Waiting external) by age; agent columns and Done most recent activity first.

## Session detail panel
- The workflow state diagram with the current state highlighted.
- Recent output from the orchestrator's per-session ring buffer, streamed live while open.
- While the agent runs: a message box for [live messages](#live-messages-to-a-running-agent) (`/...` slash commands included); sent messages show in the output as `user` chunks.
- On a done / failed session: the same box [reopens](#reopening-a-finished-ticket) the ticket with the same agent; `/help` says so.
- An empty ring loads the [history from Claude's transcript](#message-history-after-a-restart).
- The pending input request with an answer box. For non-agent kinds there are also quick actions (retry, skip to…, abort).
- Context values (`pr_url`, …), spend and time against the budget.
