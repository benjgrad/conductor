# Status

> Living dashboard. Rewritten (not appended) by the lead session at the end of every session. Keep it under one screen.

**Updated**: 2026-10-28 · session [2026-10-28-stuck-resume-and-plan-approval](sessions/2026-10-28-stuck-resume-and-plan-approval.md)

## Now
- **Milestone**: [M2 · Accounts & machines](../plan/milestones/M2-accounts-machines.md), **in progress**, built by conductor on itself (dogfood tickets on Ben's pinned board). T01–T10 and follow-ups T08b, T09b, T10b are merged (main 8ad36d1 at last M2 count; main is now cf880dc, 3 bugfix/feature merges ahead, not pushed).
- **Plan change**: Ben chose an **early you-only deploy**. T15 is split into T15a (bootstrap, CLI, resets) and T15b (invites, sign-up, admin routes; after T12). Critical path: T09b ✅, T08b ✅, T14, T15a, T17, T07b (TD-144). No second account until T16 / T19 / T21 (TD-149).
- **Board**: pinned to `board-pinned` @ d75d320 (2e88cf8 + UX-1..UX-5); session cap `machine.max_sessions` = 3. The daemon's shared clone is fast-forwarded by hand after each merge (TD-026, until T13).
- **Next action** (2026-10-28 additions first):
  - Ben: OK the deploy (orchestrator via `deploy/gradyserver/deploy.sh`; upgrade the gradyserver and Mac daemons), then push main. Then use "Start fresh conversation…" on the stuck "CI/CD" card (see [UNFINISHED](UNFINISHED.md)).
  - Lead: QA and merge T07b, T14, T15a, UX-3b, UX-6 as their PRs open; start T15a (queued), then T17.
  - Ben: decide U-083 (Done with an open PR: warn, or "merge, then Done"?). Review this tracking PR.
  - Before T20 starts: settle U-084 (lease renewal for sessions parked in event states).

## In flight
| Task | Where | State |
|---|---|---|
| M2-T07b | dogfood ticket | running (pays TD-144; must land before T25) |
| M2-T14 | dogfood ticket | running |
| UX-3b, UX-6 | dogfood tickets | running (web-only) |
| M2-T15a | dogfood ticket | queued, not started |

## Health
| Open unknowns | Open blockers | Tech debt items | Unfinished handoffs |
|---|---|---|---|
| 55 open of 97 ([UNKNOWNS](UNKNOWNS.md)) | 0 of 4 ([BLOCKERS](BLOCKERS.md)) | 142 open of 175 ([TECH_DEBT](TECH_DEBT.md)); high: TD-026, TD-109, TD-144, TD-149 among them | 4 open: stuck "CI/CD" ticket + deploy, M1-T05a manual check, M1b branch cleanup, M2 tickets in flight; the post-merge QA entry is resolved ([UNFINISHED](UNFINISHED.md)) |

## Milestone progress
- M1: 18 / 18 done; awaiting sign-off. M1b: 10 / 10 done; awaiting sign-off.
- M2: 13 done (T01–T10, T08b, T09b, T10b); 2 in progress (T07b, T14); T15 split into T15a / T15b; 16 todo (incl. T15a queued, T15b); 32 rows. Out-of-plan: UX-1..UX-5, BUG-1, BUG-1b, BUG-2 merged; UX-3b, UX-6 running.
- M2c, M2b: approved, not started. M3–M5: outlined.

## Last session
- **Stuck-resume incident (production)**: ticket "CI/CD" (session 4b5cde62) asked for plan approval on the Mac; `start_session` timed out, gradyserver claimed it and got `--resume` for a Mac-only conversation: "No conversation found", exit 1, forever.
- **Merged to main (QA'd, local only)**: `fix-resume-no-conversation` (7cf97f2: daemon refuses a resume without the transcript at its exact path; engine resets and starts fresh; QA FAIL on raw stderr in the event row, then PASS), `feat-fresh-conversation` (220e79f: "Start fresh conversation…" event, API, button, help; PASS WITH DEBT), `feat-plan-approval-ui` (cf880dc: plan panel, Approve plan / Request changes, board card; QA FAIL on missing card tests, then PASS WITH DEBT).
- **Tracking**: TD-171..TD-175 and U-097 added; 3 decisions logged; UNFINISHED entry for the stuck ticket and the pending deploy.
