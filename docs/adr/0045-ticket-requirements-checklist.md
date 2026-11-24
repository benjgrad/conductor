# ADR-0045 · The ticket's requirements checklist

- **Status**: proposed (Ben asked for the behaviour in the conductor ticket "Functional requirements as checklist", 2026-11-24)
- **Date**: 2026-11-24
- **Deciders**: Ben (+ conductor ticket "Functional requirements as checklist")
- **Resolves**: —

## Context
The ticket: the agent sets up a list of criteria that decide whether the ticket is fully implemented. Conductor checks those items off. The user can see which ones have been met and which have not, and it is always clear which are checked off. Any time an AI wants to change the list mid-implementation, a human has to approve the change.

What was already there:
- Requirements gates ([ADR-0009](0009-transition-requirements-review.md), [ADR-0010](0010-one-workflow-columns-are-states.md), [ADR-0011](0011-transition-rules.md)). A fresh reviewer judges `review.items` and reports `{verdict: [{item, met, reason}]}`. Unmet items go back to the worker. The items are fixed per workflow, not per ticket.
- conductor v7's personal hand-off has the item "Every functional requirement in the ticket body is met". It is a single pass/fail item, not a checklist the human can read item by item.

## Decision
- **Where the list lives.** `session.context.__requirements` (`REQUIREMENTS_CONTEXT_KEY`, a reserved context key). It holds `{items: [{text, status: pending|met|unmet, reason, checked_in}], set_by: agent|human, set_in, revision, proposed, ignored}` (`engine/requirements.ts`). It is written only by the engine.
- **Who sets it.** The built-in `plan_template` asks the planner for `"requirements": ["…"]` in its result: 3–12 statements, each checkable against the diff. A `plan_template` state sets or replaces the list whenever it completes, including through a question such as `plan_needs_approval`. A list is 1–30 items of up to 500 characters, trimmed and de-duplicated.
- **Who checks it.** Every gate step with a `review` (transition, entry or move) pins the list's texts when it starts (`GateStep.requirements`). Its reviewer is asked the gate's own items, then those requirements. The verdict sets each requirement's `status` and `reason`, and `checked_in` (the step label). Unmet requirements go back to the worker like any unmet item, under the gate's `on_unmet`. A gate without a review does not check them. There is no workflow flag and no new conductor version: a ticket without a list behaves exactly as before.
- **Changing it after planning needs a human.** Every other agent state sees the list, with each item's status, in its prompt (`## Requirements`). It is told that it cannot change the list.
  - An agent that wants a change takes a question transition (`ask_user`, or `question: true`) with `result.proposed_requirements` (or `requirements`). The engine stores it as `proposed` and the list stays as it is.
  - A changed list on any other transition is ignored. It is kept as `ignored` so the board can say so.
  - The mid-session `ask_user` MCP tool carries no payload, so a proposal goes through `complete_state`.
- **A human decides.** `human.requirements {items | apply_proposal, actor}`, from `PUT /api/sessions/:id/requirements`.
  - It replaces the list: an unchanged text keeps its status, a new one is pending. It bumps `revision` and clears the proposal. "Keep current" sends the current list back unchanged.
  - It is accepted in any non-terminal status except while a review runs (`wrong_status`, 409). A bad list, or no proposal to apply, is `invalid_requirements` (400).
  - Nothing moves. A live agent gets the new list as a `send_message`.
- **The board shows it.**
  - The Details tab has a Requirements section: each item with an icon and words (Met / Not met / Not checked yet), the reviewer's reason under it, "n of m met", Edit, and the proposal with Apply / Keep current.
  - The proposal also shows next to the open question.
  - The card has a `☑ n/m` chip (`BoardCard.requirements`) and a "requirements change proposed" badge.
  - `get_ticket` (MCP) includes the list.

## Alternatives considered
| Option | Why not |
|---|---|
| A ticket column or a new table | The list belongs to the session's run, like `__pr` or `__qa`, and a reopen copies `context` (ADR-0008). A context key needs no migration. |
| An opt-in flag on a gate's `review` | Needs a conductor v8 and an adopt step to get any effect. With the key absent there is nothing to check, so the default changes nothing for older tickets. |
| A `proposed_requirements` field on the `ask_user` MCP tool | A daemon and protocol change. The `complete_state` question result already carries free-form JSON; proposed as a follow-up. |
| Engine routing a silent change to a human state | That would be a move with no outcome behind it (invariant: transitions only on outcomes). Ignoring the change keeps the list safe, and the prompt says how to ask. |

## Consequences
- Good: the checklist is visible, item by item, and only a planner or a person sets it.
- Good: the existing reviewer and `on_unmet` loop do the checking, so there is no second checker and loops stay bounded.
- Bad / accepted cost: a longer reviewer prompt and verdict on tickets with a list. It is capped at 30 items.
- Bad / accepted cost: a planner sent back by a human (`revise_plan`) can replace the list without asking. That is a human's decision, and the new list starts as not checked yet.
