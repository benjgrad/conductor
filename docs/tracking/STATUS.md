# Status

> Living dashboard. Rewritten (not appended) by the lead session at the end of every session. Keep it under one screen.

**Updated**: 2026-10-22 · session [2026-10-22-m1-group-e](sessions/2026-10-22-m1-group-e.md)

## Now
- **Milestone**: [M1 · Single machine](../plan/milestones/M1-single-machine.md) **complete, pending Ben's sign-off**. All groups A–E merged (T10 via `integrate/E`, main at the group E tracking commit after 344a0c9)
- **Phase**: M1 sign-off, then M2 planning
- **Next action**: Ben signs off M1 (exit criteria met: `pnpm test:e2e` green, 6 passed / 1 skipped in ~16 s; all 18 tasks done and QA-passed). Ben approves the paid `E2E_REAL_CLAUDE=1 pnpm test:e2e` run, which also closes the T05a real-mode check ([UNFINISHED](UNFINISHED.md)). Ben rules on U-045 and U-048. Lead fixes U-046 (flaky daemon test, recurred; fix identified), pays TD-068, decides U-047 and U-043, confirms U-029. Then plan M2.

## In flight
| Task | Branch | Agent | State |
|---|---|---|---|
| — | — | — | nothing in flight |

## Health
| Open unknowns | Open blockers | Tech debt items | Unfinished handoffs |
|---|---|---|---|
| 28 open of 48 ([UNKNOWNS](UNKNOWNS.md)) | 0 of 4 ([BLOCKERS](BLOCKERS.md)) | 58 open of 74 ([TECH_DEBT](TECH_DEBT.md)) | 1 ([UNFINISHED](UNFINISHED.md)) |

## Milestone progress
M1: 18 / 18 tasks done (T00, T01, T12, T13, T02, T03, T05a, T05b, T09, T04a, T04b, T06, T08, T11, T07, T09b, T14, T10). Exit criteria met; awaiting Ben's sign-off. T04, T05 and T09 were split into a/b.

## Last session
Merged M1-T10 E2E suite via `integrate/E` (344a0c9). The real orchestrator and daemon bins, the fake Claude and a local fixture repo pass all 5 fake-mode scenarios plus a shutdown/cleanup test: happy path, test fails twice then passes, retries exhausted → needs_input → "retry", ask → REST answer → same live process, U-028 nudge → needs_input. ~16 s. The first ci.sh run hit the U-046 flake; the rerun was fully green (503 passed / 2 skipped). Filed TD-074.
