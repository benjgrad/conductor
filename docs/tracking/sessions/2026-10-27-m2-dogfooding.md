# Session 2026-10-27 · m2-dogfooding

- **Lead**: Claude (Opus 5.5) with Ben · session link: https://claude.ai/code/session_01NhmNbZ2iRArH99MxNSABmj
- **Milestone / phase**: M2 · Orchestrate | QA (dogfooding round 1)
- **Goal for this session**: build M2 with conductor itself: each M2 task block runs as a ticket on Ben's pinned board, the agent opens a PR, the lead QAs and records.

## What happened
- **Conductor building M2 on itself.** Every M2 task, and a set of UX and bug tickets Ben raised from using the board, ran as `personal` tickets on the live board (pinned to the M1b build, U-075) against `github.com/benjgrad/conductor`. 23 PRs merged: M2-T01..T10 (#1–#5, #7, #11, #13, #14, #16), the follow-ups T08b (#21), T09b (#17), T10b (#19), UX-1..UX-5 (#8, #9, #10, #12, #20), BUG-1 (#18), BUG-1b (#22), BUG-2 (#23), the TD-111 test fix (#15) and the M2 plan update (#6).
- **Plan change (Ben)**: an early you-only deploy. T15 split into T15a (bootstrap, `conductor-admin` CLI, resets) and T15b (invites, sign-up, admin routes; after T12). Critical path: T09b, T08b, T14, T15a, T17, T07b. No second account until T16 / T19 / T21 (TD-149).
- **QA follow-ups**: T08's QA found change-password brute force (→ T08b); T09's found the revoke race (→ T09b; post-merge QA passed 6 attack probes); T10's found capability-name gaps (→ T10b); T07's found the `.env` generation bug (TD-144 → T07b, running).

### Problems hit and their fixes
| Problem | What happened | Fix |
|---|---|---|
| Push credentials | `open_pr` couldn't push over https from the daemon: system git config is ignored under `GIT_CONFIG_NOSYSTEM`, so the gh credential helper wasn't used | The daemon passes `-c credential.helper= -c credential.helper=!<abs gh> auth git-credential` on its own push only (M2-T13 owns it). A failed `open_pr` can only be redone through the agent until M2-T26 adds Retry (TD-143) |
| gh too old | `gh pr create` failed on an old gh | `open_pr` refuses gh older than 2.40.0 with a clear message (U-076, M2-T10); the Machines page will flag it (M2-T11) |
| Merge conflicts | Parallel tickets touched the same files; PRs went stale against main, and agents that rebased couldn't push (no force-with-lease, TD-141) | `conductor_dev` workflow v2 adds a "Merges cleanly with main" check; the ticket preamble requires merging `origin/main` before finishing (never rebase) |
| Overload | Up to 6 sessions plus their full check runs on one Mac: e2e timed out (TD-148), web tests hit `findBy` timeouts (TD-153, TD-170) | Session cap via `machine.max_sessions` (6 → 4 → 2 → 3); light QA policy (reviewers run targeted tests only); agents run targeted tests only and conductor's checks are the single authoritative full run (no duplicate full runs) |
| Premature merges | T03 / T07 were marked Done at 14:05 with open PRs (T07 reopened); Ben merged #10 (UX-3), #18 (BUG-1) and #20 (UX-5) before their QA verdicts, and T06 (#11) / T10 (#14) at 15:29 before QA. BUG-1's QA then found the orphan-sweep safety gap | Ben: the lead merges conductor PRs after QA. Done on the board ≠ merged (U-083 asks whether Done should warn). Post-merge QA then ran: T06 OK (every item verified on main), T10's follow-ups done as T10b (#19), T09b's security QA passed; BUG-1b fixed BUG-1's gap |
| The lead's worktree blocked QA subagents | Entering a worktree in the lead session made every resumed QA subagent's Bash refuse ("isolated in the worktree") | Lead edits go through a conductor ticket, or are kept very short and never while QA agents are running |
| Phantom "running" cards | During a move step (checks / review / open_pr in conductor's own checkout, no agent process) the card still read "implementing · running", which looked like a disconnected agent | UX-5 (#20): the card and panel show "Conductor is running checks" with the phase and progress (TD-152 for durations and evidence) |
| A leaked process | A parked claude process survived Done / cancel / supersede: T03's ran 1 h 26 min after Done | BUG-1 (#18) kills a parked agent when its session leaves the state (including a human move off it). Its QA found the startup orphan sweep could kill a process that wasn't ours → BUG-1b (#22): the sweep kills only a process that is provably ours (binary basename, argv, start time). Residual debt TD-154, TD-164..167 |

- **Live board**: web-only and additive changes were hot-swapped onto the pinned branch `board-pinned` (worktree `.claude/worktrees/board-m1b`): now 2e88cf8 + UX-1..UX-5 @ d75d320, orchestrator not restarted. The daemon's shared clone is fast-forwarded by hand after each merge (TD-026, until M2-T13).
- **Flaky tests seen**: `daemon.test.ts:769` `cmd_exit` ordering (TD-168), orchestrator `schema.test.ts` 57P01 on drop (TD-169), web `WorkflowsView.test.tsx` under load (TD-170), `apply.property` unseeded coverage (BUG-2, fixed; TD-163 residual), the daemon teardown `ENOTEMPTY` (TD-111, mitigated by #15; root cause `sendInventory` in `startSession`).

## Agents dispatched
| Agent | Task | Branch | Result (PASS / FAIL / partial) |
|---|---|---|---|
| conductor sessions (implementer) | M2-T01..T10, T08b, T09b, T10b | `conductor/<ticket>/<session>` | merged (#1–#5, #7, #11, #13, #14, #16, #17, #19, #21) |
| conductor sessions (implementer) | UX-1..UX-5, BUG-1, BUG-1b, BUG-2 | `conductor/<ticket>/<session>` | merged (#8, #9, #10, #12, #18, #20, #22, #23) |
| lead | TD-111 teardown fix | `fix/td-111-teardown` | merged (#15) |
| qa-reviewer | M2 tasks and bug tickets, several post-merge (T06: OK on main; T10: follow-ups → T10b; T09b: 6 attack probes, OK) | — | findings became T07b, T08b, T09b, T10b, BUG-1b and TD-120..TD-167 |
| conductor sessions (implementer) | M2-T07b, M2-T14, UX-3b, UX-6 (M2-T15a queued) | `conductor/<ticket>/<session>` | running |

## Tracking changes
- Unknowns raised / resolved: U-083 (Done with an open PR), U-084 (lease renewal for sessions in event states; blocks T20)
- Blockers raised / cleared: none
- Tech debt added / paid: added TD-120..TD-170 (TD-151 was cited in code by T10b; TD-168..170 are the flaky tests). Paid: TD-069, TD-070, TD-120, TD-125, TD-126, TD-127 (M2-T08), TD-113 (M2-T09), TD-114 (M2-T06). TD-111 reworded and mitigated test-side (PR #15), production fix open. TD-144 open, fixed by M2-T07b (running). TD-026 open, payoff M2-T13
- ADRs: none
- Unfinished handoffs written: M2 tickets in flight (T07b, T14, UX-3b, UX-6; T15a queued); post-merge QA (resolved: T06 OK, T10 → T10b, T09b passed)

## Next session should start with
1. QA and merge T07b, T14, UX-3b and UX-6 as their PRs open (check "merges cleanly with main" first); start M2-T15a (queued), then M2-T17.
2. Ask Ben about U-083; settle U-084 before T20.
