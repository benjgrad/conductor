# ADR-0009 · Plain-language transition requirements, checked by a reviewer agent

- **Status**: accepted (Ben, 2026-10-23)
- **Date**: 2026-10-23
- **Deciders**: Ben (+ Claude session 2026-10-23-agent-inherit-settings, continued)
- **Resolves**: —

## Context
Tickets move between states only on outcomes ([05](../design/05-workflow-engine.md)): an agent's `complete_state`, a command's exit code, an event. Failure loops are bounded (`goto` / `attach` / `retries` / `else`). That covers "did it build" but not "is it done the way we want": "the new code paths have tests", "the PR description explains the migration", "no TODOs left in changed files". Ben wants to write those requirements in plain language on each transition, say what happens when they're not met, and see and edit the whole workflow as a UML state diagram.

## Decision
**A transition can carry a `requirements` gate. Before the session enters the target state, an independent read-only reviewer agent checks each requirement against the work. All met → the transition proceeds. Any unmet → the session goes back to a chosen state, with the reviewer's reasons and the author's instruction attached, at most `retries` times. Then it goes to a human state.** Requirements are written and edited in a Workflow view that draws the definition as a UML state diagram.

### Definition (packages/shared/src/workflow/schema.ts)
```json
"on": {
  "done": {
    "goto": "build",
    "requirements": {
      "items": ["New code paths have unit tests", "No TODO comments in changed files"],
      "on_unmet": {
        "goto": "implement",
        "instruction": "Add the missing tests before anything else.",
        "retries": 2,
        "else": "needs_input"
      },
      "model": "opus"
    }
  }
}
```
- `items`: 1–30 plain-language requirements.
- `on_unmet.goto`: the state to go back to. `instruction` is free text for the agent. `retries` defaults to 2 and is at most 10. `else` defaults to `needs_input`.
- **Validator rules** (05 §Validation on save):
  - `on_unmet.goto` and `else` exist.
  - `else` is a `human` state, so every failure path ends at a human.
  - `retries` is bounded.
  - A gate is allowed only on transitions out of `agent` and `command` states.
  - A transition into a `terminal` state may carry a gate: "done" can have requirements.

### Engine semantics
- **Starting the review.** An outcome that selects a gated transition does not enter the target. The session enters a **review step** for that transition: it shows on the board as `reviewing` (state label `<from> → <to>`). The step emits a `start_session` for a **fresh** Claude session (never `--resume`):
  - read-only tools: Read, Glob, Grep, and git inspection (`git diff`, `git log`, `git show` against the session's base);
  - cwd = the session worktree;
  - a prompt that lists the items, names the transition, and includes the source state's `complete_state` result / command output tail.
- **The reviewer's outcome.** The reviewer reports through `complete_state {result: {verdict: [{item, met, reason}]}}`. The engine treats this as the review step's outcome, so transitions still happen only on outcomes.
  - **All `met`** → enter the target state.
  - **Otherwise** → `on_unmet.goto`, with an attachment the next prompt receives: "Requirements for <from> → <to> were not met:", then the unmet items and their reasons, then the `instruction`. This works like `attach: output` today.
  - **Counter.** Retries are counted per gated transition (`retry_counters`). When exhausted → `else`, with a needs_input question listing the unmet items.
- **Review failures.**
  - A reviewer timeout (default 10m) → `else`, with the reason "review timed out".
  - A malformed verdict (missing items, a non-boolean `met`) → the existing U-028 no-outcome handling: nudge once, then `else`.
- **Budget.** Reviewer spend and time count toward the session budget.
- **Versions.** Running sessions keep their pinned workflow version (05 §Versioning). Edits create a new version, which applies to new tickets and reopens.

### Workflow view (web)
- A page per workflow (latest version, with older versions selectable) draws the definition as a **UML state diagram**:
  - start pseudostate;
  - states as rounded boxes labelled with their type;
  - terminal states as double circles;
  - transitions as arrows labelled with their outcome;
  - gated transitions marked with a requirements badge;
  - `on_unmet` loops as dashed arrows;
  - failure `goto` / `retries` / `else`.
- From a session's Details tab, the same diagram highlights the current state.
- **Editing.** Clicking a transition opens its requirements: add, remove, reorder or edit items; choose the `on_unmet` state; write the instruction; set the retry count. Saving POSTs the edited definition (a new version), and server validation errors show inline.
- **API.** `GET /api/workflows/:id[?version=N]` → `WorkflowDetail` (packages/shared/src/api/rest.ts).

## Alternatives considered
| Option | Why not |
|---|---|
| The working agent attests to each requirement in `complete_state` | Cheaper, but the agent grades its own work. Ben chose an independent reviewer |
| Requirements as shell commands only | Deterministic, but can't express most of what Ben wants ("explains the migration"). Command states already cover checks that can be scripted |
| Ask a human whenever requirements are unmet | Too noisy. A human is the `else` once retries run out |
| An LLM-free "guard" expression | `guard` exists for data conditions. It can't judge code or prose |

## Consequences
- **Good:**
  - Quality bars are explicit, versioned with the workflow, visible on the diagram, and enforced by something other than the author.
  - The feedback loop is automatic and bounded.
- **Bad / accepted cost:**
  - Each gated transition costs a reviewer run: quota and roughly 1–3 minutes.
  - LLM judgement is not deterministic, so a flaky verdict can cost a retry. The `else` human backstop bounds the damage.
  - The reviewer reads the worktree, so it sees whatever the agent wrote, including any secrets. That is the same exposure as the agent itself.
- **Follow-ups:** the backend gate (engine, daemon, validator), the web Workflow view and editor, and an e2e scenario with the fake reviewer.

## Revisit when
Reviewer verdicts prove too flaky (add majority-of-N, or a cheaper deterministic pre-check), or M4's full visual editor lands: this view becomes its first part.
