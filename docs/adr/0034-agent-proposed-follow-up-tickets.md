# ADR-0034 · Agents propose follow-up tickets; a human confirms each one

- **Status**: accepted (Ben approved the plan, 2026-11-03, on ticket "Next Step"; reconciled with PR #125, 2026-11-04)
- **Date**: 2026-11-03, amended 2026-11-04
- **Deciders**: Ben (+ the conductor planning and implementing sessions on that ticket)
- **Extends**: [ADR-0011](0011-transition-rules.md) (`complete_state` result), [ADR-0030](0030-per-repo-checks-and-mcp-workflow-tools.md) / [ADR-0033](0033-workflow-advisor.md) (configuring the workflow over MCP)

## Context
Agents often find separate work while they do a ticket: missing docs, a flaky test, a refactor that would help. That work should be offered as new tickets once the user agrees. Ben wants:
- the workflow to **encourage** agents to propose them, never to require it;
- the user to confirm each one, one by one, while the ticket is in Needs input;
- the feature to be configurable from the workflow screen, over MCP and by the workflow advisor.

Two branches built this at the same time. PR #125 landed first: proposals read from `session.context`, decisions in `ticket_proposal_decision`, routes under `/api/tickets/:id/proposals/*`, the Needs input panel and the card badge, with the hint always on in the built-in planning and implementing prompts. PR #119 (this ADR's first version) had its own table, engine effect and routes, plus a per-state setting and an MCP tool. Ben chose (2026-11-04) to keep #125's storage and UI and to port only #119's configuration and MCP pieces onto it.

## Decision
1. **The proposals ride on the `complete_state` result.** The optional key `proposed_tickets: [{title, repo, why}]` (`PROPOSED_TICKETS_KEY`) is stored in `context.<state>` like any extra key. The daemon forwards `result` verbatim, so neither daemon, nor the WS protocol, nor the outcome MCP tool changes. Validator rule 5 refuses `proposed_tickets` among a state's required `result` keys.
2. **Per agent state, with a default.** `follow_ups: {enabled, max (1..10, default 3), guidance?}` on an agent state (`FollowUpsSchema`):
   - **unset**: today's behaviour. The built-in `plan_template` / `implement_template` carry a one-line hint, and up to 3 are read per state;
   - **on**: `renderPrompt` adds a `## Follow-up tickets (optional)` section before How to finish, with `max` and `guidance`, in place of the hint; up to `max` are read;
   - **off**: no hint, and that state's proposals are not read.
   `proposalLimitsOf(def)` gives the read limit of each agent state.
3. **Decided by a human** (06 §Proposed tickets, from #125): `ticket_proposal_decision`, approve or dismiss in Needs input, the "N proposed" card badge, `POST /api/tickets/:id/proposals/{approve,dismiss}`. Over MCP, `get_ticket_artifacts what=proposals` lists them, and **`decide_proposed_ticket`** approves (optionally with an edited title and body) or dismisses one through the same code as the routes.
4. **Configured like the rest of the workflow.** The column editor has a checkbox with At most and Guidance, showing the effective setting. MCP `get_workflow` / `save_workflow` carry the field, and the advisor prompt names it as a lever.
5. **No new shipped workflow version.** Conductor v4 already uses the built-in templates, so it already has proposals on; the v5 of this ADR's first version (v4 with `follow_ups` on in Implementing) would have changed nothing that matters, and is dropped.

## Alternatives considered
| Option | Why not |
|---|---|
| Keep #119's `ticket_proposal` table, `ticket_proposals` effect and `/api/proposals/:id` routes | Duplicates #125, already on `main`; two stores for one feature |
| A `propose_ticket` tool on the agent's outcome MCP server | A daemon change in TypeScript and Rust, and a new WS event; the result already reaches the engine |
| Create the tickets directly | Agents would fill the queue with work nobody asked for; Ben wants each one confirmed |
| A child-ticket dependency (ADR-0018, U-010) | The proposals are parallel work, not sub-tasks the source waits on |
| Off unless configured | Would turn off what #125 shipped for every existing workflow |

## Consequences
- **Good:**
  - no protocol, daemon or schema change beyond #125's table;
  - existing workflows behave exactly as with #125 until someone sets `follow_ups`;
  - every ticket is still created by a person's decision.
- **Bad / accepted cost:**
  - unset means on for two built-in templates and off-but-readable elsewhere, which the editor has to explain by showing the effective setting;
  - the MCP tool list grows to 31 tools, and its budget rises from 22 KB to 23 KB.
- **Follow-ups:**
  - proposal counts (proposed / approved / dismissed per state) in `get_process_metrics`, so the advisor can tune `max` and `guidance` from evidence.

## Revisit when
- Per-account workflows (M2-T12) land: the default can differ per account.
- Users ask for proposals that depend on the source ticket (then ADR-0018's links).
