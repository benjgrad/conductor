# ADR-0034 · Agents propose follow-up tickets; a human confirms each one

- **Status**: accepted (Ben approved the plan, 2026-11-03, on ticket "Next Step")
- **Date**: 2026-11-03
- **Deciders**: Ben (+ the conductor planning and implementing sessions on that ticket)
- **Extends**: [ADR-0011](0011-transition-rules.md) (`complete_state` result), [ADR-0030](0030-per-repo-checks-and-mcp-workflow-tools.md) / [ADR-0033](0033-workflow-advisor.md) (configuring the workflow over MCP)

## Context
Agents often find separate work while they do a ticket: missing docs, a flaky test, a refactor that would help. That work should be offered as new tickets that can run **in parallel** once the user agrees. Ben wants:
- the workflow to **encourage** agents to propose them, never to require it;
- the user to confirm each one, one by one, in the web UI while the ticket is in Needs input;
- the feature to be configurable from the workflow screen, over MCP and by the workflow advisor.

## Decision
1. **The proposals ride on the `complete_state` result.** The agent adds the optional key `proposed_tickets: [{title, body, kind?, why?}]` to the `result` it already sends (`PROPOSED_TICKETS_KEY`, `shared/src/engine/proposals.ts`). The daemon forwards `result` verbatim, so neither the TypeScript nor the Rust daemon, nor the WS protocol, nor the outcome MCP tool changes.
2. **Per agent state, opt-in.** `follow_ups: {enabled, max (1..10, default 3), guidance?}` on an agent state (`FollowUpsSchema`); absent ≡ off. There is no workflow-level default. When it is on:
   - `renderPrompt` adds an optional `## Follow-up tickets (optional)` section before How to finish;
   - `apply()` parses the list (malformed items, repeated titles and anything over `max` are dropped; it never fails the step) and emits `ticket_proposals {state, proposals}`, whatever the outcome (a question or ask_user included);
   - the key is stripped from `context.<state>`.
   When it is off, the result is untouched. Validator rule 5 refuses `proposed_tickets` among a state's required `result` keys.
3. **Stored, then decided by a human.** The EngineService wrapper inserts `ticket_proposal` rows in the apply transaction. The unique `(session_id, lower(title))` index is the idempotency key. The session detail carries them (`SessionDetail.proposed_tickets`). The web's "Proposed tickets" box offers **Queue ticket** (optionally after editing the title and body) and **Dismiss** on each one. Accepting inserts an ordinary, independent ticket: the source ticket's repo, workflow, required tags and allowed machines, with no dependency link. It queues like any other and can run in parallel. `POST /api/proposals/:id/accept | dismiss`, and over MCP `get_ticket` (the pending proposals) and `decide_proposed_ticket`.
4. **Configured like the rest of the workflow.** The column editor gets a checkbox with At most and Guidance. MCP `get_workflow` / `save_workflow` carry the field, and the advisor prompt names it as a lever.
5. **Shipped default: conductor v5** = v4 with `follow_ups {enabled: true, max: 3}` on Implementing only (`CONDUCTOR_V5`). It is seeded after an unedited v4, like every shipped version.

## Alternatives considered
| Option | Why not |
|---|---|
| A `propose_ticket` tool on the agent's outcome MCP server | A daemon change in TypeScript and Rust (MR in progress), and a new WS event; the result already reaches the engine |
| Create the tickets directly | Agents would fill the queue with work nobody asked for; Ben wants each one confirmed |
| A child-ticket dependency (ADR-0018, U-010) | The proposals are parallel work, not sub-tasks the source waits on |
| A workflow-level default | Not needed yet; one more inheritance rule to explain. Per state is enough for Ben's flows |

## Consequences
- **Good:**
  - no protocol or daemon change;
  - the engine stays pure (an effect, written by the wrapper in the same transaction);
  - proposals are idempotent per session and title;
  - every ticket is still created by a person's click.
- **Bad / accepted cost:**
  - v5 changes the Implementing prompt for every account (workflows are instance-wide until M2-T12);
  - one more table;
  - the MCP tool list grows to 26 (still under the 20 KB budget);
  - there is no badge on the board card yet (the card is a seam): the box shows in the session panel.
- **Follow-ups:**
  - a "N proposed" chip on the card;
  - proposal counts (proposed / accepted / dismissed per state) in `get_process_metrics`, so the advisor can tune `max` and `guidance` from evidence.

## Revisit when
- Per-account workflows (M2-T12) land: the default can differ per account.
- Users ask for proposals that depend on the source ticket (then ADR-0018's links).
