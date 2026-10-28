# Status

> Living dashboard. Rewritten (not appended) by the lead session at the end of every session. Keep it under one screen.

**Updated**: 2026-10-28 · sessions [2026-10-28-agent-permissions](sessions/2026-10-28-agent-permissions.md), [2026-10-28-stuck-resume-and-plan-approval](sessions/2026-10-28-stuck-resume-and-plan-approval.md)

## Now
- **Permission prompts built (2026-10-28, local main, not pushed/deployed)**: M2-T29b (daemon), T29c (orchestrator), T29d (web) merged. Deploy order (U-102): orchestrator first via `deploy/gradyserver/deploy.sh`, then the daemons. Until then agents' off-list tool calls are still silently denied. Follow-ups: TD-187 (too-old-CLI alert), TD-188 (`session_allow` not fed to new processes), U-104, U-105.
- **Milestone**: [M2 · Accounts & machines](../plan/milestones/M2-accounts-machines.md), **in progress**, built by conductor on itself (dogfood tickets on Ben's pinned board). T01–T10, T08b, T09b, T10b and T30 are done.
- **Plan change**: early you-only deploy (T15a / T15b split). Added this session: T13a (fetch per session), T27 / T27b (update from main), T28..T28e (layered settings, [ADR-0022](../adr/0022-layered-agent-settings.md) proposed), T29..T29d (permission prompts, [ADR-0023](../adr/0023-permission-prompts-through-conductor.md) accepted), T30 (pnpm-aware checks, done).
- **Why**: Hazel (M2-T18b) could not see ADR-0021 or update its branch (stale clone, TD-026; planning is read-only). Nova (M2-T18) had 18 tool calls silently denied (no `defaultMode`, prompts `none`; npm run in a pnpm repo). Ops fix: daemon clone and Hazel's branch fast-forwarded to eb45d46.
- **Open PRs**: #44 (this plan, ADRs, tracking; includes T30), #47 (M2-T29 contracts, QA PASS WITH DEBT TD-178..180), #48 (M2-T13a, QA PASS WITH DEBT TD-181). #47 and #48 target main: merge after #44.
- **Next action**:
  - Ben: OK the deploy (orchestrator via `deploy/gradyserver/deploy.sh`; upgrade the gradyserver and Mac daemons), then push main (local main is merged with origin/main). Then use "Start fresh conversation…" on the stuck "CI/CD" card (see [UNFINISHED](UNFINISHED.md)).
  - Ben: merge #44, then #47 and #48. Answer Hazel's and Nova's `ask_user` on the board. Approve ADR-0022 and answer U-098 (may the daemon refuse remote widening; default `full`?) before T28b. Decide U-099 (`permission_decision` as outbox kind without Effect, or through apply) before T29c, and U-102 (deploy order: T29c before T29b).
  - Lead: after the merges, T29b (daemon) and T29c (orchestrator) in parallel once U-099 is decided; T27 after T13a + T29b; T28 contracts after ADR-0022 approval. Nova's lint failure (`packages/daemon/src/credential.ts:80`, preserve-caught-error) still needs fixing on its branch.
  - Still open from before: U-083 (Done with an open PR) and U-084 (lease renewal; before T20).

## In flight
| Task | Where | State |
|---|---|---|
| M2-T07b, M2-T14 | dogfood tickets | running |
| M2-T18, M2-T18b | dogfood tickets (hosted board) | running; Hazel and Nova wait on Ben's answers |
| M2-T29 | PR #47 | in_review, QA passed with debt; merge after #44 |
| M2-T13a | PR #48 | in_review, QA passed with debt; merge after #44 |
| UX-3b, UX-6, M2-T15a | dogfood tickets | as of 2026-10-27 (not re-checked) |

## Health
| Open unknowns | Open blockers | Tech debt items | Unfinished handoffs |
|---|---|---|---|
| 61 open of 103 ([UNKNOWNS](UNKNOWNS.md)) | 0 of 4 ([BLOCKERS](BLOCKERS.md)) | 154 open of 187 ([TECH_DEBT](TECH_DEBT.md)); high: TD-026 (stale base paid by T13a once merged), TD-109, TD-144, TD-149 among them | 9 open: stuck "CI/CD" ticket + deploy, M1-T05a manual check, M1b branch cleanup, UX-9..16 waves, M3 waves, M2 tickets in flight, PR #47, PR #48, Hazel / Nova follow-ups ([UNFINISHED](UNFINISHED.md)) |

## Milestone progress
- M1: 18 / 18 done; awaiting sign-off. M1b: 10 / 10 done; awaiting sign-off.
- M2 (49 rows, counted from the table): 14 done, 4 in progress (T07b, T14, T18, T18b), 2 in review (T13a PR #48, T29 PR #47), 1 split (T15), 28 todo (incl. T27, T27b, T28..T28e, T29b..d). Out-of-plan: UX-1..UX-5, BUG-1, BUG-1b, BUG-2 merged.
- M2c, M2b: approved, not started. M3–M5: outlined.

## Last session
- **Stuck-resume incident (production)**: ticket "CI/CD" (session 4b5cde62) asked for plan approval on the Mac; `start_session` timed out, gradyserver claimed it and got `--resume` for a Mac-only conversation: "No conversation found", exit 1, forever.
- **Merged to main (QA'd, local only)**: `fix-resume-no-conversation` (7cf97f2: daemon refuses a resume without the transcript at its exact path; engine resets and starts fresh; QA FAIL on raw stderr in the event row, then PASS), `feat-fresh-conversation` (220e79f: "Start fresh conversation…" event, API, button, help; PASS WITH DEBT), `feat-plan-approval-ui` (cf880dc: plan panel, Approve plan / Request changes, board card; QA FAIL on missing card tests, then PASS WITH DEBT).
- **Tracking**: TD-182..TD-186 and U-103 added (renumbered from TD-171..175 / U-097 when merging origin/main); 3 decisions logged; UNFINISHED entry for the stuck ticket and the pending deploy.
- **Agent permissions and fresh base**: traced two stuck dogfood sessions to a stale daemon clone and silent permission denials. Planned T13a, T27, T28, T29, T30; ADR-0023 accepted, ADR-0022 proposed.
- **PRs**: #44 plan (merged main in; renumbered U-097..101 to U-098..102, TD-171..173 to TD-175..177; backfilled TD-173 / TD-174), #46 T30 merged, #47 T29 and #48 T13a QA-passed with debt.
- **Env issues**: full test suite times out under load (load average 20+); `pnpm db:up` fails when another worktree's docker Postgres holds :54329.
