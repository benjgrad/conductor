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

- Accepted only while the session is `running` an **agent** state whose process is live; otherwise 409 `conflict`. A `needs_input` session is answered through `/input`, not `/messages`.
- The text goes to Claude Code as-is. Claude folds a message written mid-turn into that turn, and a `/...` text runs as a Claude Code slash command (e.g. `/context`), its output coming back as assistant text (spike against claude 2.1.309, ADR-0007).
- **Not an answer.** The daemon does not clear its `ask_user` / nudge state for it, and the driver does not clear the outcome server's pending question. The turn still has to end with `complete_state` or `ask_user`; the [U-028 nudge](../adr/0005-claude-code-driver.md#addendum-2026-10-22-turns-without-an-outcome-u-028) counts turns as before.
- **Best effort.** A refusal is ignored by the engine (`message_refused`); the board shows it as a debug output line.

## Kanban columns (queries, not state)

| Column | Query (`session.status`) | Sort |
|---|---|---|
| Queued | `queued`, `assigned` | priority, age |
| Running | `running` | last activity |
| **Needs input** | `needs_input` | **oldest open input_request first**, with the question badge |
| Waiting (external) | `waiting_external` (event states such as `await_approval`) | age |
| Done | `done` | recent first |
| Failed | `failed`, `lost` (after requeue limit) | recent first |

## Session detail panel
- The workflow state diagram with the current state highlighted.
- Recent output from the orchestrator's per-session ring buffer, streamed live while open.
- While the agent runs: a message box for [live messages](#live-messages-to-a-running-agent) (`/...` slash commands included); sent messages show in the output as `user` chunks.
- The pending input request with an answer box. For non-agent kinds there are also quick actions (retry, skip to…, abort).
- Context values (`pr_url`, …), spend and time against the budget.
