# Status

> Living dashboard. Rewritten (not appended) by the lead session at the end of every session. Keep it under one screen.

**Updated**: 2026-10-27 · session [2026-10-27-m2-dogfooding](sessions/2026-10-27-m2-dogfooding.md)

## Now
- **Milestone**: [M2 · Accounts & machines](../plan/milestones/M2-accounts-machines.md), **in progress**, built by conductor on itself (dogfood tickets on Ben's pinned board). T01–T10 and follow-ups T08b, T09b, T10b are merged (main 8ad36d1).
- **Plan change**: Ben chose an **early you-only deploy**. T15 is split into T15a (bootstrap, CLI, resets) and T15b (invites, sign-up, admin routes; after T12). Critical path: T09b ✅, T08b ✅, T14, T15a, T17, T07b (TD-144). No second account until T16 / T19 / T21 (TD-149).
- **Board**: pinned to `board-pinned` @ d75d320 (2e88cf8 + UX-1..UX-5); session cap `machine.max_sessions` = 3. The daemon's shared clone is fast-forwarded by hand after each merge (TD-026, until T13).
- **Next action**:
  - Lead: QA and merge T07b, T14, T15a, UX-3b, UX-6 as their PRs open; then start T17. Run the owed post-merge QA of T06 and T10 ([UNFINISHED](UNFINISHED.md)).
  - Ben: decide U-083 (Done with an open PR: warn, or "merge, then Done"?). Review this tracking PR.
  - Before T20 starts: settle U-084 (lease renewal for sessions parked in event states).

## In flight
| Task | Where | State |
|---|---|---|
| M2-T07b | dogfood ticket | running (pays TD-144; must land before T25) |
| M2-T14 | dogfood ticket | running |
| M2-T15a | dogfood ticket | running |
| UX-3b, UX-6 | dogfood tickets | running (web-only) |

## Health
| Open unknowns | Open blockers | Tech debt items | Unfinished handoffs |
|---|---|---|---|
| 49 open of 84 ([UNKNOWNS](UNKNOWNS.md)) | 0 of 4 ([BLOCKERS](BLOCKERS.md)) | 137 open of 170 ([TECH_DEBT](TECH_DEBT.md)); high: TD-026, TD-109, TD-144, TD-149 among them | 4: M1-T05a manual check, M1b branch cleanup, M2 tickets in flight, post-merge QA of T06 / T10 ([UNFINISHED](UNFINISHED.md)) |

## Milestone progress
- M1: 18 / 18 done; awaiting sign-off. M1b: 10 / 10 done; awaiting sign-off.
- M2: 13 done (T01–T10, T08b, T09b, T10b); 3 in progress (T07b, T14, T15a); T15 split into T15a / T15b; 15 todo (incl. T15b); 32 rows. Out-of-plan: UX-1..UX-5, BUG-1, BUG-1b, BUG-2 merged; UX-3b, UX-6 running.
- M2c, M2b: approved, not started. M3–M5: outlined.

## Last session
- **Conductor built M2 on itself**: 23 PRs merged in one day (M2-T01..T10, three follow-ups, five UX tickets, three bugs, a test fix, the M2 plan update).
- **Problems → fixes**: push credentials (gh credential helper on the daemon's push); gh too old (2.40.0 floor); merge conflicts (`conductor_dev` v2 "Merges cleanly with main" check, merge-main preamble); overload (session cap, light QA, no duplicate full runs); premature merges (lead merges after QA); phantom "running" cards (UX-5); a leaked claude process (BUG-1 / BUG-1b).
- **Tracking**: TD-120..TD-170 added (51 rows; TD-120, TD-125..127 already paid by T08); TD-069, TD-070, TD-113, TD-114 paid; TD-111 mitigated. U-083, U-084 raised. 14 decisions logged.
