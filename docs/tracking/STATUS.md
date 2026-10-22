# Status

> Living dashboard. Rewritten (not appended) by the lead session at the end of every session. Keep it under one screen.

**Updated**: 2026-10-22 · session [2026-10-22-m1-group-c](sessions/2026-10-22-m1-group-c.md)

## Now
- **Milestone**: [M1 · Single machine](../plan/milestones/M1-single-machine.md), group C mostly merged (T04a, T04b, T06, T08 done); T11 passed QA but is not merged (index.ts export conflict)
- **Phase**: Orchestrate (finish group C, then group D: T07, T09b)
- **Next action**: merge M1-T11 (see [UNFINISHED](UNFINISHED.md)); fix TD-055 (DB test teardown flake) and TD-051 (board SSE lost wakeup); lead decides U-040 (one prompt renderer, TD-043) before T07; Ben decides U-039 (command output in `outbox.payload`), U-033 and B-004.

## In flight
| Task | Branch | Agent | State |
|---|---|---|---|
| M1-T11 | `m1-t11-gateway` @ fe5220e | integrator | QA passed; merge pending (conflict in packages/orchestrator/src/index.ts) |

## Health
| Open unknowns | Open blockers | Tech debt items | Unfinished handoffs |
|---|---|---|---|
| 31 open of 44 ([UNKNOWNS](UNKNOWNS.md)) | 1 ([BLOCKERS](BLOCKERS.md)) | 56 open of 62 ([TECH_DEBT](TECH_DEBT.md)) | 2 ([UNFINISHED](UNFINISHED.md)) |

## Milestone progress
M1: 13 / 17 tasks done (T00, T01, T12, T13, T02, T03, T05a, T05b, T09, T04a, T04b, T06, T08). T11 in review (merge pending). T04 and T05 were split into a/b.

## Last session
Integrated M1 group C. T04a (pure `apply()` + prompt render), T04b (engine service, outbox dispatcher, timeout sweep), T06 (real command runner) and T08 (REST + SSE) merged to main via `integrate/C` (098b40e) after `scripts/ci.sh` passed (399 tests, including T04b's real-`apply` test). T11 conflicted on one export line and was left unmerged. Filed U-039..U-044 and TD-040..TD-062.
