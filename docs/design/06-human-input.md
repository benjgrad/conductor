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
| in a gate step (entry requirements, or an ADR-0009 review) | its source column (`step.from`) | `checking`, plus `checking: {to, title, phase}` (UX-5: and `label`, `items`, `current`) |
| otherwise | its `workflow_state` | `waiting_for_build_slot` when set |

A state that is not a column (an older `conductor` version, or an old `m1_*` workflow) maps by its type: terminal → Done, human → Needs input, event → Waiting external, agent / command / connector → Implementing. The status ("running", "assigned"…) is shown on the card, not as a column. A card says only what its column doesn't (`cardMeta`, `packages/web/src/components/format.ts`): the state is left out when it is the column (compared after `stateLabel`, ignoring case and `_`), and the status pill when the column implies it (`needs_input` in a human column, `waiting_external` in an event column, `running` in an agent / command / connector column, `queued` in Queued); that status stays as a visually-hidden span for screen readers. A `failed` / `lost` pill is left out next to the same badge. The session panel header still shows both in full. The card also carries the PR conductor opened (`pr_url`, only from `context.__pr`, which the engine writes from open_pr's result, and only a `https://github.com/<o>/<r>/pull/<n>` URL; an agent's `pr_url` is never shown).

Sort, by the column's kind: Queued by priority then age; human (Needs input) oldest open input_request first, with the question badge; event (Waiting external) by age; agent columns and Done most recent activity first.

**Collapsing columns (UX-9).** Each column heading is a toggle (`aria-expanded`, `aria-controls`). A collapsed column is a narrow strip with the rotated title and the card count; clicking it expands the column. The collapsed column ids are kept per browser and per workflow in `localStorage` (`conductor.board.collapsed.<workflow>`, `packages/web/src/components/board-layout.ts`). Ids that are no longer columns are ignored. "Expand all" shows while any column is collapsed. A collapsed human column (Needs input) shows an attention dot when its count rises above its count at collapse, so a new question isn't hidden. The dot isn't shown for counts already there on page load.

[ADR-0011](../adr/0011-transition-rules.md) on the card (M1b-T07):
- **Kind**: a small Work / Personal tag (`BoardCard.kind`; none on tickets from before M1b).
- **Waiting for**: while a move's requirements run, `pending` replaces the `checking` badge with a checklist, e.g. "waiting for **Ready for testing**: ✓ Tests pass · ✓ PR opened · ◻ PR approved (0/1) · – Pipeline ci succeeded". Icons: ✓ met, ✗ failed, ◌ running, ◻ to do / not yet, – disabled, ? unsupported (the last two greyed). An item's `detail` (the evidence) is its hover text; `pending.note` (e.g. no machine to check conditions) shows under the list. The card stays in its source column.
- **Conductor is checking (UX-5)**: while conductor itself runs a gate step's checks, review or actions (`checking.phase` ≠ `conditions`), the agent has exited, so the card shows "Conductor is checking · <running item> (n/m)" in neutral text instead of the status and the step's synthetic state, and the agent's avatar is greyed with "(idle)" for screen readers. With `waiting_for_build_slot` it reads "Conductor is checking · waiting for a build slot" (the daemon reports no queue position). The session panel's header chip reads "Conductor is checking", and Messages opens with a "Conductor is running checks" banner: the label, each item with its status as text, what happens next (the PR opens, or the agent resumes to fix a failure), the build-slot explanation (checks run one at a time to protect the machine), and a polite live region that changes once per item change. In `conditions` the "waiting for" checklist stays. A failed step's request (UX-4's "Step failed") leads with the failed item and its first error line, parsed from the engine's question until M2c persists check results (TD-152).
- **Human transitions**: a card with `human_transitions` (Needs input in a human state, Waiting external in an event state) has one button per entry, labelled with its title. A `needs_text` button opens a text box first ("Who or what is it waiting on?" for an event target, else "Your answer") and can't post without text; the others post at once. Each posts exactly `{name}` or `{name, text}` to `POST /api/sessions/:id/transition`; the card then moves on the board stream.
- **Create form**: Work / Personal is a required choice (no default); the form always sends `kind`.
- **Plan to approve** ([§Plan approval](#plan-approval)): a request opened by `plan_needs_approval` is labelled "Plan to approve" and, instead of the human transition buttons, offers **Approve plan** (posts the answer, below) and **Review plan** (opens the session panel). Without an answer option the card keeps the generic buttons.

### In-tab notifications (UX-14)
While any conductor tab is open, the page tells Ben when an agent needs input (`packages/web/src/notify/`):
- The document title reads `(N) Conductor` and the favicon gets a dot while N cards have an open `input_request`. Both clear at zero.
- Each **new** open request, keyed by `input_request.id`, shows one browser notification when notifications are on and the page is hidden or unfocused. Title: "<agent> needs input"; body: the ticket title and the question, clipped to 120 characters; `tag`: the request id. Clicking it focuses the tab and opens that card's session panel. Requests already open when the board loads are only counted. An id seen once never fires again, so reconnects, re-renders and the user's own answer don't re-fire. A notification closes when its request is answered.
- Opt-in per browser from the account menu's **Notifications** item (off, on, or blocked by the browser), stored in localStorage. The browser's permission is asked only from that click, never on load. Without `Notification` the item is hidden and the title count still works. Web Push for a closed tab is UX-15/UX-16.

## Session detail panel
- The workflow state diagram with the current state highlighted.
- Recent output from the orchestrator's per-session ring buffer, streamed live while open.
- While the agent runs: a message box for [live messages](#live-messages-to-a-running-agent) (`/...` slash commands included); sent messages show in the output as `user` chunks.
- On a done / failed session: the same box [reopens](#reopening-a-finished-ticket) the ticket with the same agent; `/help` says so.
- An empty ring loads the [history from Claude's transcript](#message-history-after-a-restart).
- The pending input request with an answer box. The answer box stays on every version: it answers the question and returns to the asking state (`$return_to`).
- **Start fresh conversation…** (`POST /api/sessions/:id/fresh-conversation`, [10 §Fresh conversation](10-contracts.md#fresh-conversation)), on the pending request while the session is `needs_input` in a human state whose `return_to` is an agent state. It opens a required text box (nothing pre-filled) with the help text "The agent starts over with its instructions and your message, without its earlier chat. Use this when it can't resume (e.g. it moved to another machine or keeps failing on start)." On a failure (kind `retries_exhausted`, or a `step_failed` request) it is the first action, highlighted: those are the stuck cases; on any other request it is a secondary action at the end. Not on review requests. The in-app help (`/help/add-a-machine`, "Stuck agent?") explains Retry vs a fresh conversation.
- A **Plan to approve** request gets its own panel ([§Plan approval](#plan-approval)); while it shows, the generic transition buttons are hidden.
- ADR-0011: the card's human transition buttons (as on the card) sit above the message box. On an **old version** (`human_transitions` is empty) non-agent kinds keep the M1 quick actions (retry, skip to…, abort) and `/retry`; a version with human transitions doesn't show them.
- Details › Workflow: the `pending` checklist while a move's requirements run.
- Details › **Moves** (`SessionDetail.moves`, oldest first): "<time> <from> → <to> · <transition title> — <reason> (<actor>)". The title comes from the transition in the state it left, else the name humanised; a gate step's synthetic label is shown as is.
- Context values (`pr_url`, …), spend and time against the budget.
- **Edit ticket**, above the Brief, when `SessionDetail.ticket_editable` (the column allows it, [05 §Editing the ticket per column](05-workflow-engine.md#definition-schema)): a form for title, body, priority and kind (`PATCH /api/tickets/:id`). On an agent column it notes that a running agent sees the change only at its next step.

A card with no session yet (Queued) opens the **ticket panel** instead (`TicketPanel.tsx`, `GET /api/tickets/:id`): the repo, kind, priority, reference, age and the description, read-only, with **Edit ticket** when the Queued column allows it. A 409 (the ticket changed since it was opened) offers Reload; a 403 shows the server's message. When the ticket is claimed while its panel is open, the panel switches to the new session's.

## Plan approval
Conductor v2's planning agent can finish with the question transition `plan_needs_approval` → Needs input, its `result` holding `{plan, summary}` and its `reason` the question. The engine keeps a question's non-empty result as `context[<asking state>]` ([05 §Transitions](05-workflow-engine.md#transitions-adr-0011-m1b-t03), [10-contracts](10-contracts.md), "Agent outcome"), so the plan is `context[return_to].plan`.

- **Classification**: a request whose origin (`origin_transition`, else the last move into the current state) is `plan_needs_approval` is a plan approval (`classifyRequest` → `plan_approval`, `packages/web/src/components/request-preview.ts`), the way `*ready_for_review` is a review.
- **Answer option**: the `human_transitions` entry with `needs_text` whose `goto` is the session's `return_to` (the resolved `$return_to`, e.g. "Back with this answer"; `planAnswerOption`). The board card has no `return_to`, so it takes the one `needs_text` option into an agent column. If there is none, the request is shown as a generic question with the generic buttons.
- **Panel** (`PlanApprovalRequest.tsx`, Messages, in place of the pending request): the badge "Plan to approve", "<agent> asks" and the question (Markdown), then the plan rendered as Markdown, visible by default (a long plan is clamped behind "Show full plan"). With no recorded plan: "The plan wasn't recorded for this request — see the agent's messages above."
  - **Approve plan** posts `{name: <answer option>, text: "Plan approved. Proceed: call complete_state with plan_ready and this plan."}` to `POST /api/sessions/:id/transition`.
  - **Request changes…** opens a required text box ("What should change in the plan?") and posts the same transition with `text: "Changes requested to the plan:\n\n<feedback>"`.
  - **Other actions** (collapsed `details`): the remaining human transitions (e.g. Waiting on someone else, Done), working as on the card.
  - **Start fresh conversation…** as a secondary action, as on any request.
- **Card**: "Plan to approve" label; **Approve plan** (the same post) and **Review plan** (selects the session) instead of the human transition buttons.
