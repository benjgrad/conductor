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
