# ADR-0041 · Triage role: conductor judges gate failures before they reach Ben

- **Status**: proposed
- **Date**: 2026-11-11
- **Deciders**: Ben (+ conductor ticket R5b "triage agent role")
- **Amends**: [ADR-0009](0009-transition-requirements-review.md), [ADR-0010](0010-one-workflow-columns-are-states.md), [ADR-0011](0011-transition-rules.md) and [ADR-0037](0037-workflow-primitives-for-self-healing-process.md) P1. A failure leg (`on_unmet.goto` / `else`, an entry's, a watch's `on_broken`) may now end at a triage state instead of a human state. Supersedes nothing.
- **Related**: [ADR-0040](0040-answerer-pass.md) (R5a, the answerer pass). It is the other case of "conductor acts on Ben's behalf"; §Acting on Ben's behalf below states the rules both follow.

## Context

The 2026-11 workflow retrospective (R5b; findings I-4, I-5 and I-6, §4.4) found three things:
- **The PR gate was re-entered 213 times in 30 days.** `on_unmet` sends the same instruction text back to the implementer whatever failed. A flaky test, a broken environment and a real bug all get the same "fix it and finish again".
- **One ticket cycled three times on Windows CI.** 08e318fb went round implementing → gate → implementing three times on a Windows-only CI failure. The implementer never read the CI log; nobody told it to.
- **Setup failed 6 of 6 times** on three tickets. Each failure was the environment, not the branch, and each lap through the implementer was wasted.

Today `on_unmet.goto` is always an agent (the implementer, with fixed text), and `on_unmet.else` / an entry's `else` / a watch's `on_broken.else` must be a human state (rules 8, 9, 13, 19). Nothing in between can look at the evidence and decide what kind of failure it was. This is n8n's "error workflow" pattern, done with an agent: when a step fails, a separate handler reads the error and picks what happens next.

## Decision

**A `role: "triage"` agent state may be the target of any failure leg. It runs fresh and read-only (git and read-only `gh`), receives the failure's evidence, and picks one declared transition. Its transitions, and those of the states only it enters, may name two pseudo-targets: `$return_to` (back to the state that failed, with its instruction) and `$gate` (run the failed move again). Each such verdict is a counted loop whose `else` is a human, so every cycle through triage stays bounded.**

### 1 · Definition

```json
"triage": {
  "type": "agent",
  "role": "triage",
  "prompt": "Read why the gate failed and pick a verdict.",
  "result": ["diagnosis"],
  "on": {
    "send_back": { "goto": "$return_to", "retries": 2, "else": "needs_input",
                   "when": "The branch is wrong: put the exact fix in `instruction`." },
    "rerun":     { "goto": "$gate", "retries": 1, "else": "needs_input", "when": "The failure is flaky." },
    "fix_env":   { "goto": "fix_env", "when": "The environment is broken." },
    "escalate":  { "goto": "needs_input", "when": "Only Ben can decide." }
  }
},
"fix_env": {
  "type": "command", "cmd": "pnpm install --frozen-lockfile",
  "on": { "exit_0": { "goto": "$gate", "retries": 1, "else": "needs_input" }, "fail": "needs_input" }
}
```

A gate routes to it like this: `"on_unmet": {"goto": "implementing", "retries": 1, "else": "triage"}`, which gives one straight retry and then triage. `"goto": "triage"` is also allowed, which sends every failure to triage first.

- `AgentStateSchema.role` widens to `'qa' | 'triage'`. `GATE = '$gate'` sits next to `RETURN_TO`.
- A **leg** is a non-human, non-terminal state that is entered only from triage states or other legs (the `fix_env` command above). The evidence is still on record while a leg runs, so a leg may name `$return_to` and `$gate` too.
- No new `MoveCause`. A verdict is a named agent transition (cause `transition`). A verdict that runs out of retries is `retries_exhausted`.

### 2 · Evidence

When a route with an engine cause (`check_failed`, `review_unmet`, `condition_unmet`, `action_failed`, `timeout`, `retries_exhausted`, `watch_broken`, …) enters a triage state, the engine writes `context.__triage`:
- `gate`: the gate step that just ended (kind, from, outcome, to, transition, actor, reason). This is the shape `gate.retry` already uses. It is null when the failure was not a gate step, for example a failed agent loop's `else`.
- `return_to`: the state that failed (the gate's source).
- `cause` and `transition`: why it failed, and which transition failed.
- `question`: the text a human would have got, without its "Retry, skip, or abort?" tail, capped at 16 000 characters.
- `unmet`: the unmet items, each with its output, capped at 8 000 characters per item.
- `claude_session_id`: the triage session's own conversation id.

The triage prompt is the state's rendered prompt plus a `## What failed` section built from that record, and the PR URL when there is one. The engine writes it in one place, `enter()`, from the entry's own record, so no failure path can forget it. The record stays while the triage state, its legs, or a human state the triage escalated to holds the ticket: the human's answer goes back to triage, which needs the evidence again. Entering any other state clears it.

### 3 · The triage session

- **Fresh.** Every visit starts a new Claude session (`resume_claude_session_id: null`). Its id goes to `__triage.claude_session_id`, never to `session.claude_session_id`, so a `$return_to` resumes the implementer's own conversation.
- **Read-only.** The engine sends `tools: ['triage']` whatever the state lists, and `review: true`, which means forced `dontAsk`, no MCP servers, and no skip-permissions. The new `triage` alias contains:
  - the read base and `REVIEW_GIT_COMMANDS` (exact);
  - five read-only `gh` prefixes: `gh pr view`, `gh pr checks`, `gh pr diff`, `gh run list`, `gh run view` (with `--log` / `--log-failed`). These are prefixes because they need a run or PR number. None of them has a flag that writes a file or changes GitHub.

  It denies `Edit`, `Write`, `git add/commit/reset/checkout/stash`, `gh api` (which can POST), `gh pr create/merge/close/edit/comment/review`, `gh run rerun/cancel` and `gh workflow`. The triage runs in the session's worktree but can't change it.
- **Version skew.** `register.features` gains `triage`. On a machine whose daemon doesn't advertise it, the orchestrator sends the `review` alias instead (read-only git, no `gh`). An older daemon would refuse an unknown alias, so this keeps the session running with less to read.
- **Fenced** like QA: entering triage kills and detaches the previous agent. The late exit of the triage process is a `command_id_mismatch`. `qaFenceChanged` covers triage states too.

### 4 · Verdicts

- **`$return_to`** (send back) enters `__triage.return_to` with a feedback block: "Sent back by Triage after "<transition>" failed:", the unmet items with their output, and the instruction. The instruction is the result's `instruction` key, or the agent's reason if that is missing. An agent target resumes its own conversation.
- **`$gate`** (rerun) runs the remembered gate step again from its source, as `gate.retry` does (`retryGate`, now shared). A rerun that fails again routes through the gate's `on_unmet` as usual, which normally lands in triage again with fresh evidence.
- **A concrete state** is either `fix_env` (a command or agent leg) or escalate (a human state). An escalate's question leads with "Triage diagnosis (<title>, "<name>"): <reason>", followed by the evidence. The request's `return_to` is the triage state.
- **Counting.** `retry_counters["<from>-><$return_to|$gate>:<failed transition>"]` is capped at the verdict's `retries` (default `budget.max_loop_retries`). Past the cap the ticket goes to the verdict's `else`, a human (kind `retries_exhausted`), never round the loop again. Triage never resets the gate's own `on_unmet` counter: once the gate's straight retries are spent, each new failure goes to triage, and the triage counters bound that loop.
- **No evidence on record.** A `$return_to` or `$gate` with no `__triage` goes to the fallback human (cause `fallback`). So does a `$gate` whose failure was not a gate step.
- **Recorded.** Every verdict's `state_entered` carries `triage: {failure_cause, gate_transition}`, which the wrapper keeps on the `state.entered` event row. That is the input for the per-cause metrics (FR-5, a follow-up ticket).

### 5 · Acting on Ben's behalf

These rules hold for triage, and for the answerer of ADR-0040, whenever conductor decides something Ben would otherwise decide:
1. **Declared choices only.** The agent picks one of the transitions the definition declares. A name it may not take goes to a human (`fallback`).
2. **Recorded.** Every decision is a `state_entered` with the agent's reason and the evidence it judged. An escalation leads with the agent's diagnosis.
3. **Bounded.** Every loop the agent can drive is counted and ends at a human state (rule 29, and rule 4 on the expanded edges).
4. **Hands off the work.** It never edits the branch, pushes, merges, comments on GitHub or reruns CI. Read-only tools, fresh conversation, forced `dontAsk`.
5. **Inside the budget.** Its spend counts toward the session's `budget.usd` like any agent's.

### Validation on save (rule 29)

Rule 29 is new, in `validate-triage.ts`. Rule 28 is ADR-0040's.
- **The triage state itself.** It is not the start state. It has no `entry`, `checkout` or `follow_ups`. Its `tools` are absent or exactly `["triage"]`. At least one route enters it (path `states.<s>`).
- **Its transitions.** None has `question`, `handoff`, `requires` or `requirements`. At least one goes to a human state, the escalate verdict (path `states.<s>.on`). That verdict also satisfies rule 12, the "can ask" rule.
- **`$return_to` / `$gate` verdicts** on a triage state or a leg are counted, with `retries` or `else` (path `….goto`). Their `else` is a human state (`….else`).
- **Elsewhere,** `$gate` is refused. `$return_to` stays rule 10's: a human state's answer route, refused on any other state.
- **"`else` is a human state" relaxed.** Rules 8, 9, 13 and 19 now accept "a human state or a triage state" (`isFailureTarget`). Any other agent state is still refused.
- **Graph (rules 2–4).** `$return_to` and `$gate` on a triage state or leg stand for edges back to every state that routes into a triage state. For an entry leg, those are the states that enter the gated state. Each edge is bounded when its verdict is counted, so a cycle `gate → (else) → triage → $gate → gate` is bounded by the triage counter.

### Delivery

| # | Ticket | Acceptance |
|---|---|---|
| R5b-1 | This ADR; schema, rule 29, engine, `triage` alias and daemon feature, the alias swap, 05/10 docs | Validator and engine tests; a bounded-path property (`apply.triage.test.ts`); the property suite runs a triage flow |
| R5b-2 | A draft triage workflow under `docs/design/workflows/` (not saved live) and an e2e scenario per verdict with a fake triage | The draft validates; e2e: send_back, rerun, fix_env, escalate |
| R5b-3 | Metrics: triage verdicts by `failure_cause` (`get_process_metrics`), and the designer's role picker and `$return_to` / `$gate` targets | Metrics test; designer test |

## Alternatives considered

| Option | Why not |
|---|---|
| An engine special case per cause (flaky → rerun, setup → reinstall) | It fails ADR-0037's §1 test: it only works for one process and is invisible in the builder. The cause also doesn't tell flaky from broken; reading the log does. |
| Resume the implementer with the evidence and let it decide | Not independent: it is the agent that just failed, and it spends that agent's context. 08e318fb shows that the implementer doesn't go and read CI. |
| Let triage fix things itself (push, rerun CI, edit the branch) | FR-3: a judge that edits the work it judges is no longer a judge. A fix goes back through the implementer or a declared `fix_env` leg, both of which run the gate again. |
| An `error_workflow` sub-workflow (n8n style) | There is one workflow (ADR-0010). A sub-workflow is a second engine concept. A state with a role is the same idea in the existing graph. |
| Let any agent state be an `else` target | It drops the "every failure path ends at a human" guarantee for states that aren't built to escalate. Rule 29's structure (escalate verdict, counted pseudo-targets) is what keeps the guarantee. |

## Consequences

- **Good.**
  - A flaky failure is rerun without an implementer lap.
  - An environment failure runs a declared fix.
  - A real failure goes back with an instruction written from the actual log.
  - Ben gets a diagnosis instead of a raw log.
  - Each verdict is recorded with its cause, so Insights can tell which failures triage actually saves.
- **Bad / accepted cost.**
  - Each triaged failure costs a short agent run.
  - A wrong `rerun` or `send_back` costs one more lap before the counter sends it to Ben.
  - A machine on an older daemon triages without `gh` (the `review` alias) until it updates.
  - The triage reads the worktree and runs `gh` read commands. Like a reviewer, it is not OS-sandboxed (U-004).
- **Follow-ups (Tracking, for the daily sync).**
  - Tickets R5b-2 and R5b-3.
  - TD row: a triage on a daemon without the `triage` feature runs with `review` (no `gh`).
  - U row: should triage be able to `gh run rerun` a flaky CI job itself, instead of only rerunning conductor's gate?

## Revisit when

- Insights shows that more than a third of triage verdicts are `escalate` for one cause over 30 days. That cause needs a better leg or prompt, not triage.
- A `rerun` verdict passes less than half the time over 30 days. The flaky diagnosis is wrong too often; tighten the prompt or drop `rerun`.
- A second role (beyond QA and triage) wants its own isolated session. That is the point to generalise `role` into a capability list.
