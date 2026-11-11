# ADR-0040 · Answerer pass: conductor tries to answer an agent's question before asking Ben

- **Status**: proposed
- **Date**: 2026-11-11
- **Deciders**: Ben (+ conductor ticket R5a "Answerer pass")
- **Amends**: [06-human-input](../design/06-human-input.md) (who may answer a question), [ADR-0009](0009-transition-requirements-review.md) (its reviewer machinery gets a second user), [ADR-0037](0037-workflow-primitives-for-self-healing-process.md) P6 (an auto-answer's push). Supersedes nothing.

## Context

The 2026-11 workflow retrospective (R5a; findings I-1 and I-7, §4.4) counted 67 agent questions in 30 days. `needs_input` held 294 h in that window, with a p90 stay of 7.3 h. Several of those questions were answerable without Ben:
- 0ca2aa8b asked Ben for a CI log that the agent could have read itself with `gh run view --log-failed`;
- 515b97b4 asked whether an existing feature already covered the ticket, which the repo and its ADRs answer.

Each one cost a push, a context switch and hours of idle session. ADR-0009 already runs a **fresh, read-only, independent** Claude session (a requirements reviewer, `dontAsk`, read-only tools, never the worker's conversation) and turns its verdict into an outcome. The same machinery can try a question first.

This changes who may answer an agent's question ([06](../design/06-human-input.md) said: a human, from the UI or MCP), so it is an ADR.

## Decision

**A workflow may name question transitions in a workflow-level `answerer` block. When an agent takes one, a fresh read-only conductor agent first tries to answer it from cited sources. A confident answer goes to the agent as the answer, Ben gets one push with Overrule, and the request is recorded as answered by conductor. Anything else (unconfident, malformed, timed out, failed) opens the question exactly as today, with the answerer's notes attached.** Ben can overrule any conductor answer; his answer reaches the agent as a correction.

### 1 · Definition (`packages/shared/src/workflow/schema.ts`)

```json
"answerer": {
  "applies_to": ["ask_user", "scope_changed", "needs_product_context"],
  "model": "sonnet",
  "min_confidence": "high",
  "timeout": "10m"
}
```

```ts
export const AnswererSchema = z.strictObject({
  applies_to: z.array(z.string().min(1)).min(1).max(10),   // question transition names (rule 28)
  model: z.string().min(1).optional(),                      // absent = the machine's default
  min_confidence: z.enum(['medium', 'high']).default('high'),
  timeout: DurationSchema.optional(),                       // default 10m, 1m–30m (rule 28)
});
// WorkflowDefinitionSchema gains `answerer: AnswererSchema.optional()`.
// WORKFLOW_FEATURES gains 'answerer', refused by rule 14 until the engine ticket marks it available.
```

Absent means no answerer: every question reaches a human, as today.

### 2 · Which questions may be routed

- **Routable** are the transitions `applies_to` names, provided each is a question some agent state asks: `ask_user` into a human state, or a `question: true` transition. `ask_user` also covers the mid-turn `ask_user` tool, because the engine routes `agent.ask_user` as outcome `ask_user`.
- **Recommended** for the `conductor` workflow: `ask_user`, `scope_changed`, `needs_product_context`.
- **Never routable** (`NEVER_AUTO_ANSWERED`, refused by rule 28 whatever the definition says):
  - `plan_needs_approval`: the plan reverses an ADR, rewrites data, adds a service or spends money, which is Ben's authority by definition (CLAUDE.md §Rules);
  - `needs_approval_to_message`: the agent wants to speak to a person on Ben's behalf;
  - `impossible`: it ends the work, and Ben decides what happens to a ticket.
- **Never** a `handoff: true` transition (ADR-0037 P8): a hand-off is finished work for review, not a question.
- **Never** a generated request (`retries_exhausted`, `timeout`, `budget_exceeded`, `machine_lost`, `check_config`, `approval`, `handoff`). Only `agent_question` requests are routed. Triage of check failures is R5b, a separate decision.

### 3 · The answerer

- **A fresh Claude session**, never `--resume` of the worker (as ADR-0009's reviewer). It runs in the session's worktree, on the session's machine, in the forced `dontAsk` permission mode, with `--setting-sources user` and the edit guard, and no MCP servers (as reviewers today).
- **Tools**: a new `answer` tool alias. It is the `review` alias (Read, Glob, Grep, the exact git inspection commands) plus exact read-only `gh` commands: `gh pr view`, `gh pr checks`, `gh pr diff`, `gh run list`, `gh run view` (with `--log` / `--log-failed`), `gh issue view`. No `gh api` and no prefix rules, for TD-082's reason (a prefix admits `--output` and friends). Without `gh` on the machine it cites fewer sources; nothing else changes, so routing needs no new capability.
- **Model**: `answerer.model`, else the machine's default, as `review.model`. The first live config should try `sonnet` and revisit once the overrule rate (§8) is known.
- **Prompt** (`renderAnswerPrompt`): the question and its options, the asking state and transition, the asking state's partial result (e.g. a plan) when the question carried one, the ticket (title, body, requirements), and every earlier question on the ticket with its answer and who answered. It says that an unsure verdict is the right answer whenever the sources don't settle the question, and that a decision only Ben can make (scope, priority, money, a person) is always unsure.

### 4 · Sources and the verdict

The answerer may cite only:
| Source | Spelling |
|---|---|
| A repo file (code, ADRs, design docs, tracking) | `file:<path>[:<line>]` |
| The ticket | `ticket` |
| An earlier answer on this ticket | `answer:<input_request_id>` |
| A read-only `gh` command it ran | `gh:<command>` |

It reports through `complete_state`:
```ts
{ result: {
    verdict: 'answered' | 'unsure',
    confidence: 'low' | 'medium' | 'high',
    answer?: string,                 // ≤ 4000; required when answered
    option?: string,                 // one of the question's option labels, when it had options
    citations: { source: string, quote?: string }[],   // ≤ 10; source in the table's spelling
    notes: string,                   // what it looked at and why it is (un)sure; ≤ 2000
} }
```

**The confidence rule.** The answer is delivered only when **all** hold: `verdict = 'answered'`; `confidence ≥ min_confidence` (`high` by default; `medium` allowed); at least one citation whose `source` parses; when the question had options, `option` is one of their labels (and is the answer). Anything else is **unconfident**. A malformed verdict (missing keys, an unknown source spelling only, `ask_user` from the answerer) gets ADR-0009's one nudge, then counts as unconfident.

### 5 · Engine semantics

- **The answer step.** An agent outcome on a routable transition does not open the question. The session enters an **answer step** for it, shaped like ADR-0009's review step:
  - the synthetic state label is `<from> → <to> (answer)` (`answerStateLabel`), which names no state, so the board, SSE and the sweep work unchanged;
  - its data (the question, options, the asking state's result, the answerer's Claude session id, the nudge flag, the deadline) lives in `session.context` under the reserved key `__answer` (rule 8 grows to forbid a state of that name);
  - status stays `running`; the card shows "Conductor is looking into the question" in the source column.
- **Where the asker is.**
  - A `complete_state` question (the worker has exited): the step works exactly like a review step.
  - A mid-turn `ask_user` tool call (the worker is parked, its process alive): the parked process stays parked and the answerer runs beside it. The daemon must allow one `answer: true` process next to a parked worker of the same session; the engine ticket spikes this first (U-row below). Until the spike passes, the mid-turn tool is not routed and still opens the question.
- **Confident.** In one transaction:
  - the input_request is created as it would have been (kind `agent_question`, `origin_transition`, options), and answered at once with `answered_by: 'conductor'`, `citations` and `answerer_notes`;
  - `input.provided` is applied as for any answer: the agent goes back to the asking state (`answer_routed`), live `send_input` or the resume path. The answer text is "Conductor answered your question (Ben can overrule this):", the answer, then one `- <source>` line per citation;
  - one push, "Conductor answered <agent>'s question", with the answer and an **Overrule** action. It takes the notify decision the question's transition would have had under P6 (legacy mode: it pushes), so a question that would have pushed sends this push instead; a silent decision sends none.
- **Unconfident, malformed, timed out, failed.** The question opens exactly as it would have without an answerer: the same kind, text, options, human state, `return_to` and P6 decision. The answerer's `notes` (or the failure: "the answerer timed out after 10m", "the answerer exited", "no machine") are stored on the request as `answerer_notes` and shown under the question as "Conductor looked into this: …".
- **Bounds.** The step has a deadline (`answerer.timeout`, default 10m); the timer goes to the fallback above. A lost machine, a budget overrun or a daemon refusal also takes the fallback. The answerer's spend and time count toward the session budget. There is no retry loop: one answerer run per question.
- **Every path ends at the asker or a human.** The step has two exits: the asker's own state (answered) or the question's own human target (everything else). It adds no edge to the graph, so rules 2–5 are unchanged; the engine ticket's property test enumerates the step's events and checks it.
- **Messages.** A live message to a session in an answer step is refused, as for a reviewer (409): the human who wants to answer waits a few minutes, or answers after the fallback. Answering an open question while the step runs is impossible because the question isn't open yet.

### 6 · Overrule

- **Where**: the push's Overrule action, the "Answered by conductor" block in the session panel's Messages, MCP `overrule_answer {ticket, input_request_id?}` (default: the latest conductor answer), and `POST /api/input-requests/:id/overrule`.
- **What it does**: it opens a new `agent_question` request with `overrules: <id>`, the original question and options, and the conductor answer with its citations quoted under it. The card goes to Needs input **only if the session is parked**; a working agent keeps working on the conductor answer, and the request shows on its card as "Correction pending" until Ben answers. Overrule does not stop, move or rewind the agent.
- **Ben's answer is delivered as a correction**:
  - agent working: a live message (ADR-0007), "Correction from Ben to conductor's answer to "<question>": <text>";
  - agent parked or the session in `needs_input` for another reason: the same text as the answer or the next prompt (the resume path);
  - session finished: Overrule offers Reopen (ADR-0008) with that text instead.
- **Limits**: each conductor answer can be overruled once, only on the ticket's latest session. The overruled request keeps its answer; `overruled_at` is set on it.

### 7 · Data (additive; the engine ticket's migration)

- `input_request.answered_by` already exists (text): it gains the value `conductor`.
- `input_request.citations jsonb null`, `answerer_notes text null`, `overrules uuid null` (references `input_request`), `overruled_at timestamptz null`.
- `InputRequestDto` gains the same fields. No enum changes.

### 8 · Metrics

`get_process_metrics` gains `answerer`: questions routed; auto-answered (count and rate of routed); fell back, by reason (`unconfident`, `malformed`, `timeout`, `error`); overruled (count and rate of auto-answered); the answerer's median and p90 duration. Insights' question count keeps counting every `agent_question` and splits out "answered by conductor".

### 9 · Validation on save (rule 28)

- Each `applies_to` name appears once.
- No name is in `NEVER_AUTO_ANSWERED`.
- Each name is a question some agent state asks (`ask_user` into a human state, or `question: true`), and never a hand-off.
- `timeout` is 1m–30m.

Rule 14 refuses the `answerer` block ("not available yet") until the engine ticket adds `answerer` to `AVAILABLE_WORKFLOW_FEATURES`.

### 10 · Delivery

| # | Ticket | Acceptance |
|---|---|---|
| R5a-1 | This ADR, schema and validator (rule 28, rule 14), 05/06/10 docs | v6 + the block validates with `allowUnavailable`; rule 14 refuses it otherwise |
| R5a-2 | Engine and daemon: answer step, `answer` tool alias, delivery, fallback, timeout, migration, push; marks `answerer` available | Engine tests: confident, unconfident, malformed, timeout, no machine; property test: every path ends at the asker or a human |
| R5a-3 | Overrule (REST, MCP, panel, push action) and correction delivery | Engine/route tests for working, parked and finished sessions |
| R5a-4 | Metrics and Insights split; turn it on in the live workflow | `get_process_metrics.answerer`; a `save_workflow` edit |

## Alternatives considered

| Option | Why not |
|---|---|
| Tell the asking agent to look harder before asking | It already had the repo and `gh` and still asked: the problem is judging what is answerable, and an independent reader judges better than the author (ADR-0009's reasoning). Prompt edits stay worthwhile alongside. |
| Answer inside the asker's own conversation | Not independent, and it spends the asker's context on a second opinion. |
| Answer every question, including approvals | A plan that spends money or reverses an ADR, and a message to a person, need Ben's authority. |
| Proceed with the agent's recommended answer after a timeout | That is R6 (default-on-timeout), a separate product decision; it answers without any evidence. |
| A deterministic lookup (fetch the failing CI log, grep the ADRs) | Covers 0ca2aa8b but not 515b97b4 or scope questions; the answerer can run the same commands. |
| A per-transition `answer: true` flag instead of a workflow block | Ten transitions would repeat the model and confidence; one block keeps the policy in one place, and `applies_to` reads as the list Ben reviews. |

## Consequences

- **Good:**
  - Questions the repo or `gh` answer stop costing Ben a push and the session hours of idle time.
  - Every auto-answer is cited and overrulable, and the overrule rate measures whether to trust it.
  - The fallback is the current path unchanged, so the worst case is the cost of one answerer run.
- **Bad / accepted cost:**
  - A confident wrong answer can send an agent down the wrong path until Ben overrules it. Mitigations: `high` by default, a citation required, decisions that need Ben refused by rule 28 and by the prompt, and the push on every answer.
  - Each routed question costs an answerer run, roughly 1–3 minutes and its spend against the session budget.
  - The answerer reads the worktree and `gh`, the same exposure as a reviewer. It is not OS-sandboxed (U-004).
- **Follow-ups (Tracking, for the daily sync):**
  - U-row: can the daemon run an `answer: true` process beside a parked worker of the same session (the mid-turn `ask_user` tool)?
  - U-row: do `gh run view --log-failed` and the other exact `gh` rules match under `dontAsk` exact-rule matching?
  - Tickets R5a-2, R5a-3, R5a-4.

## Revisit when

- The overrule rate is above 15 % of auto-answers over 30 days (tighten the prompt, require `high`, or narrow `applies_to`).
- The auto-answer rate is below 10 % of routed questions over 30 days (the step costs more than it saves).
- R5b or R6 want the same step for check failures or timeouts.
