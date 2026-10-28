# Session 2026-10-28 · agent-permissions

- **Lead**: Claude (Opus 5.5) with Ben · session link: n/a
- **Milestone / phase**: M2 · Plan + QA
- **Goal for this session**: find out why two dogfood sessions (Hazel, Nova) could not do their work, and plan the fix: fresh base per session, agent settings, permission prompts on the board.

## What happened
- **Trigger, Hazel** (ticket d0f8e9aa, M2-T18b planning, Linux daemon): could not see ADR-0021 or update its branch. The daemon's clone never fetched (TD-026), and planning has only Read/Glob/Grep with `--permission-prompts none`.
- **Trigger, Nova** (M2-T18, session 005f1e8c): 18 tool calls silently denied (pnpm, chmod, diff, prettier, git update-index). The machine has no `defaultMode` and prompts were `none`. Its build check also ran npm in a pnpm repo.
- **Ops**: the lead fast-forwarded the daemon's shared clone and Hazel's branch to eb45d46 (ADR-0021 present). Ran Nova's gates by hand: typecheck OK, prettier OK, lint FAIL at `packages/daemon/src/credential.ts:80` (preserve-caught-error); web `SetupGuide.test.tsx` also fails on main (flaky). Nova's branch is untouched.
- **Decisions (Ben)**: ADR-0023 accepted (auto mode default, prompts go to the board via `--permission-prompt-tool`, bypass is a per-machine opt-in). ADR-0022 (layered settings) proposed, awaiting Ben and U-098.
- **PR #44** (plan, ADRs, tracking) carries T30 via merged #46. Merged main in and renumbered colliding IDs: U-097..101 to U-098..102, TD-171..173 to TD-175..177; backfilled TD-173 and TD-174.
- **PR #47** M2-T29 contracts and **PR #48** M2-T13a fetch per session: both QA PASS WITH DEBT, base main, merge after #44.
- **Env issues**: the full test suite times out under load (load average 20+ with parallel agents). `pnpm db:up` fails when another worktree's docker Postgres holds :54329 (agents used the running server).

## Agents dispatched
| Agent | Task | Branch | Result (PASS / FAIL / partial) |
|---|---|---|---|
| implementer + qa-reviewer | M2-T30 pnpm-aware checks | m2-t30-pnpm-checks (PR #46) | PASS, merged into #44's branch |
| implementer + qa-reviewer | M2-T29 permission-prompt contracts | PR #47 | PASS WITH DEBT (TD-178..180) |
| implementer + qa-reviewer | M2-T13a fetch per session | PR #48 | PASS WITH DEBT (TD-181) |

## Tracking changes
- Unknowns raised: U-098..U-102 (U-098 may the daemon refuse remote widening, default `full`; U-099 `permission_decision` as outbox kind without Effect vs through apply; U-100 Allow-always rule grammar; U-101 tool input over 64 KiB; U-102 deploy order, T29c before T29b).
- Blockers raised / cleared: none.
- Tech debt added: TD-173..TD-181 (TD-178..180 from T29 QA, TD-181 from T13a QA). Paid: TD-026 stale base (by T13a, once merged).
- ADRs: ADR-0022 (proposed), ADR-0023 (accepted).
- Unfinished handoffs written: PR #47 (M2-T29), PR #48 (M2-T13a), Hazel and Nova follow-ups.

## Next session should start with
1. Ben merges #44, then #47 and #48; approves ADR-0022 and answers U-098; decides U-099 and U-102.
2. Start T29b (daemon) and T29c (orchestrator) in parallel after U-099; then T27 (after T13a + T29b); T28 contracts after ADR-0022 approval.
