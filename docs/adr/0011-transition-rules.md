# ADR-0011 · Rules live on transitions: named moves, who takes them, which tickets, what they require

- **Status**: proposed (Ben approved the plan 2026-10-26; this ADR is accepted when he signs off milestone M1b)
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
