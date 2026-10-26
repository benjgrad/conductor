# ADR-0011 · Rules live on transitions: named moves, who takes them, which tickets, what they require

- **Status**: accepted (Ben, 2026-10-26: plan approved, the open questions below answered, milestone M1b approved)
- **Date**: 2026-10-26
- **Deciders**: Ben (+ Claude session 2026-10-23-agent-inherit-settings, continued)
- **Supersedes**: [ADR-0010](0010-one-workflow-columns-are-states.md)'s *entry* requirements (`states.<s>.entry`). ADR-0010's other decisions stay:
  - one workflow `conductor`;
  - its states are the board columns;
  - checks run on a fresh checkout of the exact commit;
  - conductor opens the PR;
  - failed and cancelled tickets land in Done.
  
  ADR-0009's reviewer and verdict fencing also stay.

## Context
ADR-0010 put requirements on *entering* a column. Ben (2026-10-26) wants them on the **move**, because why a ticket moves differs per edge. His examples:
- **Planning → Needs input** when a new dependency changes the scope, the plan is ready but needs approval before implementation, the agent needs more product context, or it found the work impossible.
- **Implementing → Needs input** when it is about to send someone a Slack message that needs approval, or it has finished and wants the user to review the PR.
- **Implementing → Waiting external, for a work ticket**, only when all of these hold:
  - the unit tests pass;
  - the PR checks pass;
  - the required peer approvals are in;
  - the Jira ticket is updated with the solution, status, etc.;
  - the Azure pipeline has built the branch, so it is ready for testing.
- **Personal tickets** rarely go to Waiting external.
- **A human** may go from Needs input to Waiting external (they can't answer alone), or to Done.

His decisions:
- while external conditions are pending, the card **stays in its current column** with a "waiting for …" checklist;
- "skip to" runs requirements too (ADR-0010).

## Decision
**Each outgoing edge of a state is a named transition. It says when to take it, who may take it (agent, human or system), which tickets it applies to (work, personal), and what must hold before the ticket moves: checks, reviewer items, actions, and external conditions. An agent finishes by naming the transition it takes, with a reason. Requirements are checked on the move, and the card stays in its column until they pass or fail to a human.**

### Definition (evolves `states.<s>.on`)
`on` keeps its shape, `{<name>: Transition}`, so old definitions still parse. The key is now the **transition name**. The transition object gains:
```jsonc
"on": {
  "plan_ready": {
    "goto": "implementing",
    "when": "The plan is complete and needs no decision from a human.",
    "actor": "agent",                 // agent | human | system (system = timeouts, events, command exits)
    "kinds": ["work", "personal"],    // omitted = both
    "requires": {                     // all optional; ADR-0010 entry fields move here
      "checks":  [{ "name": "Tests pass", "cmd": "npm test" }],
      "setup":   "npm ci",            // ADR-0010 semantics: auto-detect when omitted
      "review":  { "items": ["The plan names every file it will change"] },
      "actions": ["open_pr"],
      "conditions": [
        { "type": "pr_checks_green" },
        { "type": "pr_approvals", "min": 2 },
        { "type": "azure_pipeline_succeeded", "pipeline": "ci" },
        { "type": "jira_fields_set", "fields": ["resolution", "status"] }
      ],
      "condition_timeout": "3d"
    },
    "on_unmet": { "goto": "implementing", "instruction": "…", "retries": 3, "else": "needs_input" }
  },
  "scope_changed": { "goto": "needs_input", "when": "A new dependency or finding changes the scope.", "actor": "agent", "question": true }
}
```
- `question: true` means a transition into a human state asks a question; the agent's `reason` is the question. That replaces the single `ask_user` outcome: `ask_user` remains as the built-in fallback name.
- The existing `attach` / `retries` / `else` failure-loop fields keep their meaning.
- ADR-0009 `requirements` on a transition and ADR-0010 `entry` on a state are still read in old versions, and are folded into `requires` when the editor saves a new version.

### Who takes a transition
- **Agent.**
  - Its prompt lists the outgoing transitions with `actor: agent` that match the ticket's kind, each as name + `when`.
  - It finishes with `complete_state {transition, reason, result}`; `transition` defaults to `done` for old prompts. Asking a human is `complete_state` naming a `question: true` transition, or `ask_user` (the fallback).
  - An unknown name, or one not allowed for this actor or kind, gets one corrective nudge, then the U-028 path (needs_input).
- **Human.**
  - A Needs-input card shows one button per `actor: human` transition (+ kind filter) out of the current state. Examples: "Back to Implementing with this answer", "Waiting on someone else" (asks who or what, stored as the reason), "Done".
  - The REST `POST /api/sessions/:id/transition {name, text}` and the MCP tool (M3) use the same path.
  - Requirements run on human moves too.
- **System:**
  - `timeout`, a command's `exit_0` / `fail`, an event's `wait_for` names, `budget_exceeded`;
  - and the conditions phase of a pending transition (below).

### Requirements on the move
When a transition is taken, the ADR-0010 step (`context.__entry`, renamed as the transition step) runs the phases in order:
1. **Checks:** the clean pre-check, then the fresh checkout with setup, then the checks, binding the sha.
2. **Review:** the fenced reviewer.
3. **Actions:** `open_pr`; later `update_jira` and `slack_message`, which may need human approval (M5).
4. **Conditions:** external facts, **re-evaluated** until all are met or `condition_timeout` passes.
   - The card stays in the source column. Its badge is a checklist, e.g. "waiting for: ✓ Tests pass · ✓ PR opened · ◻ approvals 1/2 · ◻ pipeline".
   - Each condition is evaluated **on the user's machine** by a `run_action`-style command (`evaluate_condition`) using its own CLIs: `gh pr view --json statusCheckRollup,reviewDecision,reviews` first; `az` and `jira` CLIs or MCPs in M5. There are no third-party secrets on the server.
   - Polling defaults to every 2 minutes, with backoff. Webhooks (M5) can trigger an immediate re-evaluation.
   - The conditions a session needs become routing capabilities (M2): e.g. `gh` authed, `az` authed.

All met → the ticket enters `goto`. A failed check, unmet review or failed action → `on_unmet`, as in ADR-0010. A **condition** that becomes false (checks red, changes requested, pipeline failed), or the timeout passing → `on_unmet`, with the evidence (which condition, its last value). Everything stays bounded and every failure path ends at a human.

### Ticket kind
- `ticket.kind: 'work' | 'personal' | null` (a migration).
- Transitions filter on it.
- A null kind is resolved before Queued: by triage (M4), or by a creation-form field until then. Until triage exists, creating a ticket requires the kind.

### Default `conductor` v2
Encodes Ben's examples.
- **Planning**, agent transitions:
  - `plan_ready` → Implementing;
  - `scope_changed`, `plan_needs_approval`, `needs_product_context`, `impossible` → Needs input (each with `question: true`).
- **Implementing**, agent transitions:
  - `needs_approval_to_message`, `pr_ready_for_review` → Needs input;
  - `ready_for_testing` → Waiting external (work): checks build + test, `open_pr`, conditions `pr_checks_green` + `pr_approvals ≥ 1`. The Jira and Azure conditions are declared but disabled until M5;
  - `done` → Done (personal): checks build + test, `open_pr`.
- **Needs input**, human transitions:
  - `answer` → back to the asking state;
  - `waiting_on_someone` → Waiting external;
  - `done` → Done;
  - `cancel`.
- **Waiting external**, transitions:
  - human `back_to_implementing`;
  - system `approved` → Done, on `ui.approve` or a condition set.
- **Seeded** as v2 on startup if the latest shipped version is newer than the account's and the account hasn't edited it. Otherwise the editor offers the new defaults.

### Editor and board
- **The Workflow view** keeps columns, and arrows are clickable again. An arrow's panel edits name, `when`, actor, kinds, requires (checks / setup / review / actions / conditions with their timeout) and on_unmet. A column panel edits title and work.
- **Board:**
  - pending-transition checklists on cards;
  - Needs-input buttons per human transition;
  - the timeline shows "<transition> — <reason>" for every move.

### Decisions on the open questions (Ben, 2026-10-26)
- **Long waits (U-058, U-059).** While a transition waits on conditions, the session is **paused**:
  - the worker process is ended (resumable later);
  - wall time stops counting against the budget;
  - the card stays in the source column with the checklist;
  - conditions are re-checked by any online machine of the account.
  
  With no machine online, the card says "waiting for a machine to check conditions", and `condition_timeout` **keeps running**.
- **Condition outcomes (U-063).**
  - A condition that turns **false** (checks red, changes requested, pipeline failed) → `on_unmet.goto` with the evidence, counted against `retries`.
  - A **timeout** → straight to `on_unmet.else` (a human).
- **Human transitions and defaults (U-061, U-062).**
  - `answer` goes back to the state that asked (`goto: "$return_to"`).
  - Cancel stays an operator action, not a transition.
  - `ask_user` remains a fallback outcome on every agent state.
  - Existing tickets with a null `kind` match both kinds.
- **Contract choices from planning** (M1b-T01):
  - conditions are evaluated by `run_action {action: 'evaluate_conditions'}`, one per pending transition, with no new outbox enum value;
  - transitions get an optional `title` for button labels;
  - `requires.condition_poll` sets the poll interval (default 2m);
  - Jira and Azure conditions are declared but disabled until **M5** (not M4).

## Implementation notes (M1b)
The decision above stands; these are the choices made implementing it, and where the build differs from the text above. Details: [05 §Transition object, §Transitions, §Conditions](../design/05-workflow-engine.md#transition-object-adr-0011), [10 §Transitions](../design/10-contracts.md#transitions-adr-0011), [06](../design/06-human-input.md).
- **One step machinery (T03).** A taken transition with `requires` enters a gate step `{kind: 'move'}` that reuses the ADR-0010 entry step as is (worker killed and fenced, checks in a fresh checkout binding `head_sha`, the fenced reviewer, actions with `expected_sha`), then the conditions phase. Its label is `"<from> → <to> (move: <name>)"`, its retries count under `move:<from>:<name>`, and the feedback says "Requirements for <title> were not met:". Old versions keep running their `entry` and `requirements` unchanged; nothing is migrated. The editor folds them onto transitions when it saves (`foldLegacyRequirements`).
- **Agent names (T03, T05).** `complete_state {transition, reason, result}`; no name = `done`. A name the state doesn't offer to an agent of the ticket's kind is not ignored: it goes to Needs input as an `agent_question` (the U-028 path), so a confused agent ends at a human. A `question: true` transition skips the `result` and guard checks; its reason is the question. `start_session.transitions` and the prompt's "## How to finish" list the same transitions, filtered by kind.
- **Human moves (T04, T07).** `POST /api/sessions/:id/transition {name, text?}` → `human.transition`, accepted only while `needs_input` in a human state or `waiting_external` in an event state; an unknown name or one not open to a human of this kind is 409. `/input` is unchanged and delivers an answer the same way `answer` does. `cancel` stayed the operator route (U-061).
- **Conditions (T05, T08).** One `run_action evaluate_conditions` per poll carries all the enabled conditions (not one command per condition), evaluated on the **session's** machine in M1b; "any online machine of the account" waits for M2 routing. The session is `waiting_external` in the source column, wall time paused, the machine slot still held (TD, U-059). Polling starts at `condition_poll` (default 2m) and doubles after an unchanged answer, up to 15m. Two hardening choices from the security reviews:
  - `pr_approvals` counts only eligible reviewers (OWNER / MEMBER / COLLABORATOR, never the PR author), and only approvals on the PR's current head; a "changes requested" blocks until that reviewer approves the head again ([ADR-0016](0016-work-connectors-on-the-users-machine.md) table);
  - `evaluate_conditions` carries `head_sha`, the commit conductor checked and pushed: a PR whose head differs fails every PR condition ("someone pushed to the branch").
  
  PR conditions with no conductor PR (`context.__pr`) fail at once to `on_unmet.else`, uncounted, instead of polling to the timeout (lead decision): the agent can't make conductor's PR, so a retry would only spend retries.
- **Waiting external's `approved`** is the existing `ui.approve` event transition (an event state's `wait_for` name is a system actor). An awaited `ui.approve` on the source state still ends a pending conditions phase.
- **conductor v2 (T09).** `pr_ready_for_review` is work-only and carries the work-commit review; its twin `personal_pr_ready_for_review` has the same checks and `open_pr` with no review, since a personal repository may commit conductor-specific files. The seed inserts v1 when no version exists, then v2 when the latest is the unedited v1 (parsed deep-equal), so an empty database gets v1 then v2. An edited `conductor` is never touched: the start logs that a newer default exists, and `GET /api/workflows/conductor` carries `default_available`.
- **Board (T07).** `BoardCard.pending` (the checklist, in run order: checks, review, actions, conditions with their observed values, e.g. "PR approved (0/1)") supersedes `checking`, which is still filled for one release. `human_transitions` gives one button per human transition for the ticket's kind. `SessionDetail.moves` (the last 50) feeds the "<transition> — <reason>" timeline.
- **E2E (T10).** `e2e/m1b.e2e.test.ts` drives the real bins with the fake Claude naming transitions, and a fake `gh` whose PR state a test rewrites between polls (approvals 0/1 → 1/1, always with a self-approval and a drive-by that must not count). It saves conductor v2 again with `condition_poll: "1s"` instead of adding a test-only knob. The v1 regression saves v1's definition as the latest version, starts a ticket on it, and saves v2 back: there is no API to pin an older version.

## Alternatives considered
| Option | Why not |
|---|---|
| Keep entry requirements (ADR-0010) | A column can be entered for very different reasons. Ben's rules depend on the edge and the ticket kind |
| Move to Waiting external first, then wait for approvals | Ben: stay in the current column until the external conditions are met |
| The agent free-texts its reason and an LLM maps it to an edge | Nondeterministic routing. Named transitions with `when` guidance keep moves auditable and validator-checked |
| Conditions evaluated on the server with stored tokens | Third-party secrets on a hosted server. The user's machine already has `gh` / `az` / MCPs logged in (Ben's machine-first choice for chat too) |

## Consequences
- **Good:**
  - every move is named, explained and checked against rules written for that edge and that kind of ticket;
  - the agent's options are explicit in its prompt;
  - humans get one button per allowed move;
  - external-world gates (approvals, pipelines, Jira) are first-class and bounded.
- **Bad / accepted cost:**
  - more definition surface;
  - conditions need an online machine to evaluate. If none is online the card shows "waiting for a machine to check conditions", and the timeout still applies;
  - polling cost;
  - a contract change (`complete_state.transition`, the transition REST route, `ticket.kind`).
- **Follow-ups:** M2 capability routing (conditions need CLIs); M3 MCP `take_transition`; M4 triage for `kind`; M5 Jira / Azure / Slack and webhooks.

## Revisit when
Workflows need parallel branches (two conditions sets racing), or per-account workflow variants.
