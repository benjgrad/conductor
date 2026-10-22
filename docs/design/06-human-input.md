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
- The pending input request with an answer box. For non-agent kinds there are also quick actions (retry, skip to…, abort).
- Context values (`pr_url`, …), spend and time against the budget.
