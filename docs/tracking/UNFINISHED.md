# Unfinished work (session handoff)

Anything started but not merged when a session ends. The next session reads this **first**, before anything else, and picks up from **Next step** without re-deriving context.

Remove the entry once the work is merged or deliberately abandoned. If abandoned, note why in the session log.

<!-- Template — copy per item:

## M1-T05 · Daemon core
- **Branch / worktree**: `m1-t05-daemon-core` @ `.claude/worktrees/m1-t05-daemon-core`
- **Last commit**: abc1234 "WIP: heartbeat sends live mem"
- **Done so far**: WS client + reconnect; register; heartbeat
- **Not done**: worktree creation, spawn, kill
- **Exact next step**: implement `createWorktree()` in packages/daemon/src/worktree.ts; test stub already in worktree.test.ts (skipped)
- **Gotchas**: `git worktree add` fails if branch exists — see note in code
- **Gates**: typecheck ✅ lint ✅ tests ❌ (worktree.test.ts skipped)
-->

## M1-T05a · Real-mode manual check (code merged; one acceptance item outstanding)
- **Branch / worktree**: none; daemon core merged via `integrate/B` (d5841e7), wiring via M1-T07 (66ab745). Work from the main checkout or a fresh worktree off main
- **Last commit**: 344a0c9 (main after group E, M1-T10 merged)
- **Done so far**: the paid real-CLI round trip passed (M1-T07: `E2E_REAL_CLAUDE=1`, claude 2.1.308, 2/2 passed, B-004 cleared); daemon `main.ts` now statically imports `createCliDriver` with the outcome server (TD-021 paid), and the orchestrator has a real process entry (`conductor-orchestrator` bin)
- **Not done**: the T05a real-mode manual check (orchestrator + daemon + real driver against a real repo), documented in the task's QA notes
- **Exact next step**: `pnpm db:up && pnpm db:migrate`, start `conductor-orchestrator` (packages/orchestrator/dist/bin.js) and the daemon against it with the real driver, create a ticket from the board, watch it reach `implement` and record the result in the session log. Simplest route now that M1-T10 is merged: with Ben's spend approval run `E2E_REAL_CLAUDE=1 pnpm test:e2e` (real orchestrator + daemon bins, real `claude`, haiku, local fixture repo) and record the result; or do the manual board run above
- **Gotchas**: `main()` does not migrate; run `pnpm db:migrate` first. pnpm scripts run Node 22 via `.npmrc`, the shell may have Node 20. Since M1-T14 a local-path repo needs `CONDUCTOR_ALLOW_LOCAL_REPOS=1` on the daemon, and if the web dev server is not on port 5173/4173 set `CONDUCTOR_ALLOWED_ORIGINS` (TD-069)
- **Gates**: on main 344a0c9: typecheck ✅ lint ✅ tests ✅ (503 passed / 2 skipped) build ✅ test:e2e ✅ (6 passed / 1 skipped, ~16 s)

## Housekeeping · merged M1b branches and worktrees (no unfinished work)
- **Branch / worktree**: `m1b-t01-contracts` … `m1b-t10-e2e` and 12 `worktree-agent-*` branches, with their `.claude/worktrees/*` checkouts. `git branch --no-merged main` is empty on 5c49010: every M1b task is merged, and there are no M1b WIP handoffs
- **Exact next step**: the lead removes the merged worktrees and branches (`git worktree remove`, `git branch -d`); then delete this entry

## UX-9..UX-16 · board polish, agent team, notifications: ticket waves (2026-10-28)
- **Branch / worktree**: none yet; bodies in `docs/plan/UX-board-and-notifications.md`, posted with `scripts/create-tickets.js --file docs/plan/UX-board-and-notifications.md <ids>`
- **Done so far**: the 9 ticket bodies; **wave 1 posted 2026-10-28** (UX-10, UX-11, UX-13a, UX-14, UX-15, workflow `conductor` v2, all priority 0, queued behind M2-T18/T18b and CI/CD)
- **Not done**: wave 1: UX-10, UX-11, UX-13a (migration), UX-14, UX-15 (migration) · wave 2: UX-9 (after UX-10), UX-13b (after UX-13a), UX-16 (after UX-14 + UX-15) · wave 3: UX-12 (after UX-9 + UX-11)
- **Exact next step**: QA each wave-1 PR as it opens (UX-13a and UX-15 stop at "awaiting Ben" for their migrations); after each merge, post the next tickets whose deps are merged
- **Gotchas**: UX-9, UX-10 and UX-12 all edit `Board.tsx`, so never run them together. After UX-15 merges, VAPID keys for prod are a lead + Ben step (`conductor-admin vapid-keys`, then the deploy env)

## M3 · ticket waves on the hosted board (2026-10-28)
- **Branch / worktree**: none yet; tickets are created by `scripts/create-tickets.js` on https://conductor.gradyserver.com
- **Done so far**: the script and its dry run (16 tickets, T01–T16); nothing posted, because M2r is not done (only M2r-T01 merged)
- **Not done**: every wave. A: T01 · B: T02, T03, T04, T05, T06, T07, T11 · C: T08 (after T02), T09 (T02+T04), T10 (T02+T03+T04) · D: T12 · E: T13 · F: T14, T15 · G: T16
- **Exact next step**: when M2r is merged, Ben runs `! CONDUCTOR_EMAIL=<email> node scripts/create-tickets.js T01` (it prompts for the password). After each merge, post the tickets whose deps are now all merged (`--dry-run` first). Wave B order: T02 T03 T04 T05 T06 T07 T11
- **Gotchas**: no `depends_on` and no edit (TD-172), so never post a wave early. Re-running skips titles already on the board. Session cap 3 queues the rest of wave B

## M2 · dogfood tickets in flight on the board (2026-10-27)
- **Branch / worktree**: conductor-owned branches `conductor/<ticket>/<session>` on the live board (`board-pinned`); no PRs open at 8ad36d1
- **Done so far**: M2-T01..T10, T08b, T09b, T10b, UX-1..UX-5, BUG-1, BUG-1b, BUG-2 and the TD-111 test fix merged (PRs #1–#23)
- **Not done**: M2-T07b (TD-144), M2-T14 (daemon distribution), UX-3b, UX-6 are running as tickets; M2-T15a (bootstrap / CLI / resets) is queued, not started
- **Exact next step**: as each ticket opens its PR, QA it (light policy: targeted tests; conductor's checks are the full run), confirm it merges cleanly with main, then the lead merges. Next on the you-only critical path after these: M2-T17
- **Gotchas**: Done on the board ≠ merged (U-083). Fast-forward the daemon's shared clone after each merge until M2-T13 (TD-026). Keep `machine.max_sessions` at 3 or less while checks run (TD-148). Never enter a worktree in the lead session while QA subagents run

## M2 · post-merge QA (resolved 2026-10-27, nothing owed)
- **Branch / worktree**: none; code on main
- **Done so far**: all three post-merge QAs ran on 2026-10-27. M2-T06 (PR #11): OK, every QA item verified on main. M2-T10 (PR #14): its follow-ups were done as M2-T10b (PR #19, merged). M2-T09b (PR #17): the security QA passed (6 attack probes incl. queued frames, reconnect mid-close, two sockets, a silent peer at 1 002 ms, stress ×10)
- **Not done**: nothing
- **Exact next step**: none; delete this entry at the next session end
