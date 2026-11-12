# ADR-0041 · Question default-on-timeout: deliver the agent's recommended answer

- **Status**: accepted
- **Date**: 2026-11-11
- **Deciders**: Ben (ticket R6, workflow retrospective I-1) + Claude (conductor session)
- **Resolves**: retrospective R6 / I-1

Numbering: ADR-0040 (answerer, #224) took validator rule 28, ADR-0042 (parallel legs) rule 29 and ADR-0043 (triage) rule 30, so this ADR's rule is **31**.

## Context
The workflow retrospective (`docs/reports/2026-11-workflow-retrospective.html`, R6 / I-1) found that `needs_input` has a median stay of 12.7 min but a p90 of 439 min. Most questions are answered quickly. The long tail is questions asked late in the day that hold a ticket overnight, although the agent had already said what it would do.

The `ask_user` prompt already makes the agent give a recommended answer. Conductor v6 (live since 2026-11-11) escalates after 2 h (`needs_input.watch` with `age_below`, [ADR-0037](0037-workflow-primitives-for-self-healing-process.md) P1), but a watch never decides: it pushes again and the ticket waits.

n8n's send-and-wait node has a "Limit wait time" option that continues with a fallback after a timeout. This ADR takes that idea. It is the first engine move that answers on a human's behalf, so it has to be bounded, visible and reversible.

## Decision
A question transition may declare **`default: {after: <duration>, answer: "$recommended"}`**. If nobody answers its request within `after`, the engine delivers the agent's own recommended answer to `$return_to`, exactly as a human answer would be delivered. The engine closes the request as answered by `system` and sends a push. Ben can **overrule** the answer from the timeline afterwards.

### 1 · Eligibility (validator rule 31)
`default` is allowed only on a transition that meets all of these:
- the transition is **agent-actor**;
- it asks: `question: true`, or the `ask_user` transition;
- its `goto` is a **human** state;
- it has no `handoff` and no `requires`. A default is armed only when the session lands in the human state directly, never through a gate step;
- it is not named in `NEVER_DEFAULTED`: `plan_needs_approval` and `needs_approval_to_message` (FR-5). Approving a plan that reverses an ADR or spends money, and approving a message to a person, stay a human's call;
- `1m ≤ after ≤ 7d`.

`answer` accepts only `"$recommended"` (`RECOMMENDED`). The value is a placeholder so a later ADR can add other sources without a schema change. The feature is `default_answer` (rule 14), available at once.

The new context keys `__default` and `__default_taken` join `RESERVED_CONTEXT_KEYS` (rule 8). A definition with a state of either name is refused. That is unlikely, and new keys have always been handled this way.

Each workflow opts in per transition. **This ADR does not decide which live transitions get a default.** That is a `save_workflow` change afterwards.

### 2 · How the recommended answer is captured
- **`complete_state` on such a transition**: `result.recommended`, a non-empty string after trimming, at most 4 000 characters. Without it, or with anything else, no default applies and the question waits as today (FR-2).
- **The mid-turn `ask_user` tool**: it has no `result`. Its description already tells the agent to list the recommended choice first, and the card's one-click button is that first option. So the recommended answer is the **first option of a single-select list**. A multi-select list, or no options, means no default.
  - A `recommended` argument on the tool would be more explicit. It needs a Rust outcome-server and protocol change, so it is a follow-up.
- **The agent is told.** In "How to finish", each transition with a default gets this line: "If no human answers within 8h, conductor delivers your recommended answer: put it in `result.recommended` …". For `ask_user` the line also says to list the recommended option first (`defaultHint`, render.ts). The protocol is unchanged: the render reads `state.on`, not `AgentTransitionOption`.

### 3 · Arming, delivery, bounds
- **Arming.** When the question lands in the human state, `enter()` stores `context.__default = {state, visit, return_to, transition, recommended, after, at}`. The `create_input_request` effect carries `default: {answer, at}`, which the wrapper stores as `input_request.default_answer` and `default_at`. The request owns the timer. **Any** move disarms it: an answer, a human transition, a watch, a lost machine or the budget.
- **The sweep** (`sweepDefaults`, every tick) finds each open request whose `default_at` has passed and whose session is `needs_input`. It feeds `default.fired {state, deadline, input_request_id}`.
  - apply ignores a stale event (`stale_timer`): another state, another visit, another deadline, or nothing armed.
  - When apply ignores it, the sweep clears `default_at`, so it isn't fired again.
- **Delivery.** It mirrors `input.provided`: `send_input` to a live parked process, otherwise a resume with the answer as the pending answer (or a requeue without a machine). The agent receives: "No human answered within 8h, so conductor took your recommended answer: <answer>. A human may still overrule it; if a correction arrives, follow it."
  - The move is recorded as **`cause: default_taken`, `actor: system`**, no transition, with the answer as its reason.
  - The wrapper closes the request: `answer = default_answer`, **`answered_by = 'system'`**.
- **Bounds.** Every default taken counts under `retry_counters["default:<asking state>"]`. At `budget.max_loop_retries`, the next question from that state opens **without** a default and waits for a human. An agent can't ask itself into an endless loop of auto-answers. Every path still ends at a human, and the `$return_to` delivery is not a graph edge, so rules 1–4 don't change.

### 4 · Notification
A default that is taken writes a `question.default_taken` event row and **always pushes** (`push_transition`, tag and idempotency key `default_taken:<request id>`), plus an in-tab `transition.notified` notice: "Conductor answered for you (no reply in 8h): <answer>". An answer nobody gave must be visible, even under a `notify` policy whose `engine_moves` is `never`. The landing move itself follows the P6 policy as an engine move, so it doesn't push twice.

Before a default fires, the open request shows: "If nobody answers by <time>, conductor answers: “<answer>”".

### 5 · Overrule
The timeline entry "Conductor answered for you" has an **Overrule…** button while the overrule is possible. The button posts `POST /api/sessions/:id/overrule {input_request_id, text}`, which becomes `human.overrule`.
- **When it applies.** `canOverrule`, the same predicate for apply and for `SessionDetail.overrulable`, checks `context.__default_taken` and requires the session to be on that same visit of the agent state the answer went to, and either:
  - `queued`: the correction is appended to the pending answer the next start delivers; or
  - `running` with a live process: the correction goes as a `send_message`, like `operator.message`.
- **When it doesn't.** An agent that is still starting is refused (409): the start already sent carries the old answer, and a pending edit would be lost on `started`. An agent that moved on or asked again is refused too (409): answer the new question, or send a message.
- The text the agent gets: "A human overruled the answer conductor gave on their behalf ("<answer>"). Use this instead: <text>".
- The wrapper sets `input_request.overruled_at` and writes a `question.overruled` audit row. The text shows in Messages as a `user` chunk.
- An overrule never moves the workflow: transitions happen only on outcomes.

## Alternatives considered
| Option | Why not |
|---|---|
| Escalation only (today's 2 h watch push) | It never decides, so the overnight tail stays. That tail is the problem. |
| The default as a watch condition / `on_broken` form | A watch checks conditions and never answers (P1's contract). Answering needs the request, the recommended answer and overrule, which a watch has no notion of. |
| A session column for the timer (like `watch_deadline`) | The request owns the default: its row already has the answer, and closing it ends the timer. Keeping the timer on the request avoids a second source of truth. |
| The answerer pass (ADR-0040, R5a) instead | It is complementary: the answerer tries cited sources within minutes. The default is the fallback after hours, with the agent's own recommendation. |
| A default on every question | Plan and message approvals need a human's authority (`NEVER_DEFAULTED`), and opt-in per transition keeps the decision with whoever edits the workflow. |
| The first option for `complete_state` too | `complete_state` has no options, and `result.recommended` is explicit. |

## Consequences
- **Good:** a non-critical question no longer holds a ticket overnight. Every default is pushed, shown on the timeline and can be overruled. Defaults are bounded per asking state.
- **Bad / accepted cost:**
  - A wrong recommendation runs for a while before Ben sees it. Mitigations: the push, opt-in per transition, and never on plan or message approvals.
  - The first-option rule for the `ask_user` tool depends on agents following its "recommended first" instruction.
  - Overrule is refused for the few seconds an agent is starting.
- **Follow-ups:**
  - which conductor transitions get a default, and with what `after` (a `save_workflow` change);
  - a `recommended` argument on the `ask_user` tool;
  - overrule and the pending default in MCP `get_ticket` / `message_agent`.

## Revisit when
- Insights shows defaults being overruled often, or Ben reports a wrong default that did damage.
- ADR-0040's answerer lands and answers most questions before any default would.
- Agents start making multi-select or option-less `ask_user` calls where a default would have helped.
