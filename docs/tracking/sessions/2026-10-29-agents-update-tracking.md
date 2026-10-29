# Session 2026-10-29 · agents-update-tracking

- **Lead**: Claude (Opus 5.5) with Ben · background job
- **Milestone / phase**: process (all milestones) · Plan
- **Goal for this session**: every agent, local or conductor-based, updates the tracking docs, since they are how we track the status of work.

## What happened
- Found two rules that kept agents out of the docs: CLAUDE.md ("tracking files are edited on `main`, not on task branches") and the conductor ticket preamble in `scripts/create-tickets.js` ("Do not edit `docs/tracking/*`. Report … in the PR description instead"), echoed in M2 §How M2 is run, M2b, and the "Do not touch" lists of every open plan.
- CLAUDE.md gains §Every agent updates the tracking docs. Each agent writes, on its own branch: its task row (`done` / `blocked`), new U/B/TD rows, DECISIONS_LOG lines, UNFINISHED entries and a session log; in STATUS.md, only its own *In flight* row (the full rewrite stays with the lead). Collision rules: IDs come after the highest on `origin/main` + open PRs, the later branch renumbers, and tracking conflicts keep both sides' rows. Lifecycle steps 2.2, 3.2 and 4.5 now point at it.
- `create-tickets.js` preamble, M2/M2b run rules, the QA checklist §5 heading and the STATUS.md header updated to match; `docs/tracking/*` removed from the open plans' "Do not touch" lists (M1/M1b left as history).
- Tickets already on the board (e.g. MR wave 1, e4bbe7dd) carry the old "do not edit" text in their bodies. The rule only reaches new tickets, or old ones edited on the board.

## Agents dispatched
| Agent | Task | Branch | Result (PASS / FAIL / partial) |
|---|---|---|---|
| none | | | |

## Tracking changes
- Unknowns raised / resolved: none
- Blockers raised / cleared: none
- Tech debt added / paid: none
- ADRs: none (a process rule, recorded in DECISIONS_LOG)
- Unfinished handoffs written: none (PR `docs-agents-update-tracking`)

## Next session should start with
Ben merges the `docs-agents-update-tracking` PR. Then edit the open board tickets' "Rules for every ticket" section (or re-post them) so their agents follow the new rule too.
