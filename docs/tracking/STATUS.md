# Status

> Living dashboard. Rewritten (not appended) by the lead session at the end of every session. Keep it under one screen.

**Updated**: 2026-10-22 · session [2026-10-22-m1-group-b](sessions/2026-10-22-m1-group-b.md)

## Now
- **Milestone**: [M1 · Single machine](../plan/milestones/M1-single-machine.md), group B merged (T02, T03, T05a, T05b, T09 done); contracts frozen (Ben approved 10-contracts)
- **Phase**: Orchestrate (group C next: T04a, T04b, T06, T08, T11)
- **Next action**: Ben decides U-033 (validator rule 4 / event-driven loops, shapes T04a) and B-004 (approve the ~$0.01 paid real-CLI run). Lead answers U-037 (quick-action mapping) and U-038 (pool factory) in the group C briefs, pays the TD-039 doc drift, then starts group C.

## In flight
| Task | Branch | Agent | State |
|---|---|---|---|
| none | | | |

## Health
| Open unknowns | Open blockers | Tech debt items | Unfinished handoffs |
|---|---|---|---|
| 25 open of 38 ([UNKNOWNS](UNKNOWNS.md)) | 1 ([BLOCKERS](BLOCKERS.md)) | 33 open of 39 ([TECH_DEBT](TECH_DEBT.md)) | 1 ([UNFINISHED](UNFINISHED.md)) |

## Milestone progress
M1: 9 / 17 tasks done (T00, T01, T12, T13, T02, T03, T05a, T05b, T09). T04 and T05 were split into a/b.

## Last session
Integrated M1 group B. T02 (DB schema, `.sql` migrations), T03 (validator, rules 1-7), T05a (daemon core), T05b (real CLI driver + MCP outcome server + fake claude) and T09 (web kanban vs mock API) all passed QA and merged to main via `integrate/B` (d5841e7) after `scripts/ci.sh` passed (265 tests). Cleared B-003, raised B-004. Resolved U-022; filed U-028..U-038. Paid TD-001 and TD-003; filed TD-021..TD-039 (TD-020 moved out of the example comment).
