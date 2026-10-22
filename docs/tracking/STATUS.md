# Status

> Living dashboard. Rewritten (not appended) by the lead session at the end of every session. Keep it under one screen.

**Updated**: 2026-10-22 · session [2026-10-22-m1-group-d2](sessions/2026-10-22-m1-group-d2.md)

## Now
- **Milestone**: [M1 · Single machine](../plan/milestones/M1-single-machine.md), groups A–D2 merged (T14 via `integrate/D2`, main at c97bfed)
- **Phase**: Orchestrate (group E: M1-T10 E2E is the last M1 task)
- **Next action**: pay TD-068 (run_cmd live output dropped after idle; QA strongly recommends it before T10), then brief M1-T10 (daemon needs `CONDUCTOR_ALLOW_LOCAL_REPOS=1` for the fixture repo). Ben rules on U-045 and U-048 (repo validation in the shared ticket schema, a contract change). Lead decides U-047 and U-043, confirms U-029, watches U-046 (flaky daemon test). Do the T05a real-mode manual check ([UNFINISHED](UNFINISHED.md)).

## In flight
| Task | Branch | Agent | State |
|---|---|---|---|
| — | — | — | nothing in flight |

## Health
| Open unknowns | Open blockers | Tech debt items | Unfinished handoffs |
|---|---|---|---|
| 28 open of 48 ([UNKNOWNS](UNKNOWNS.md)) | 0 of 4 ([BLOCKERS](BLOCKERS.md)) | 57 open of 73 ([TECH_DEBT](TECH_DEBT.md)) | 1 ([UNFINISHED](UNFINISHED.md)) |

## Milestone progress
M1: 17 / 18 tasks done (T00, T01, T12, T13, T02, T03, T05a, T05b, T09, T04a, T04b, T06, T08, T11, T07, T09b, T14). Left: T10 (E). T04, T05 and T09 were split into a/b.

## Last session
Merged M1-T14 security hardening via `integrate/D2` (c97bfed); `scripts/ci.sh` green on the merged tree (503 passed / 2 skipped). Seven local security findings fixed (MCP token out of argv, CLAUDE.md symlink read, repo allow-list with local repos off by default, API Host/Origin/content-type guard, WS Origin check, gateway machine + exact-token authorization, output ownership). Paid TD-058; TD-059 deferred to U-008 (M2); filed TD-068..TD-073 and U-046..U-048.
