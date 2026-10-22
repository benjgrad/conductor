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

## M1-T05a / M1-T05b · Real-mode checks (code merged; acceptance items outstanding)
- **Branch / worktree**: none; both merged to main via `integrate/B` (d5841e7). Work from the main checkout or a fresh worktree off main
- **Last commit**: 504d069 (T05a fix round 1), 9fddabd (T05b fix round 1)
- **Done so far**: daemon core and the real cli-driver are merged and QA-passed against fakes; `E2E_REAL_CLAUDE=flags` (free argv check against the installed CLI) passes
- **Not done**: (1) the paid real-CLI round trip `E2E_REAL_CLAUDE=1` (~$0.01 on haiku) needs Ben's approval ([B-004](BLOCKERS.md)); (2) the T05a real-mode manual check (daemon + real driver), which was blocked on T05b and is now possible; (3) TD-021: daemon `main.ts` still loads the cli-driver via a computed dynamic import
- **Exact next step**: with Ben's approval, from the repo root on main run `E2E_REAL_CLAUDE=1 pnpm exec vitest run --project daemon src/claude/cli-driver.real.test.ts` and record the result in the session log; then have a small task replace the computed import in packages/daemon/src/main.ts:13 with `import { createCliDriver } from './claude/index.js'` (TD-021, U-029) and do the documented real-mode manual check
- **Gotchas**: the real test skips unless `E2E_REAL_CLAUDE` is set; `CONDUCTOR_REAL_CLAUDE` is gone. pnpm scripts run Node 22 via `.npmrc`, the shell may have Node 20
- **Gates**: typecheck ✅ lint ✅ tests ✅ (265 passed / 2 skipped on main) build ✅

## M1-T11 · Orchestrator daemon gateway (QA passed; not merged)
- **Branch / worktree**: `m1-t11-gateway` @ `.claude/worktrees/wf_716565dc-e7a-20` (pushed to origin/m1-t11-gateway)
- **Last commit**: fe5220e (M1-T11 gateway, 1 commit on main 8a6260f)
- **Done so far**: gateway (WS server, register/heartbeat, FIFO claim with SKIP LOCKED, command_ack, SocketTransport, session_event → engine, fencing/seq checks, orphan kills) implemented and QA-passed (PASS WITH DEBT; 298 tests green on its base)
- **Not done**: merge to main. `git merge --no-ff m1-t11-gateway` onto main 098b40e conflicts in packages/orchestrator/src/index.ts: T04b added `// M1-T04b engine service …` + `export * from './engine/index.js';` on the same lines where T11 adds `export { createGateway } from './gateway/index.js';`. Also TD-060: gateway tests still run against `DbTestEngine`, not the real engine now on main
- **Exact next step**: in a scratch worktree off main, `git merge --no-ff m1-t11-gateway -m "merge: M1-T11 Orchestrator daemon gateway"`, resolve index.ts by keeping both export blocks (engine first, then gateway), run `bash scripts/ci.sh`, fast-forward main, then remove the worktree above. Check that `export *` from engine and `createGateway` don't collide on a name (tsc will say). Then do TD-060 (point gateway.test.ts at `createEngineService`) in a follow-up or in M1-T07
- **Gotchas**: the shared harness teardown flake (TD-055) can make `pnpm test` exit 1 with all tests passing; re-run before calling it red. pnpm scripts run Node 22 via `.npmrc`
- **Gates**: typecheck ✅ lint ✅ tests ✅ (on its own base) build ✅; not yet run on the merged tree
