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

## M1-T00 · ADR-0005 acceptance (code merged)
- **Branch / worktree**: `m1-t00-claude-driver-spike` merged to main (cc94883); implementer worktree removed
- **Last commit**: a903c5a "feat(spike): claude code driver spike and ADR-0005 (proposed)"
- **Done so far**: spike scripts + evidence in spikes/claude-driver/; ADR-0005 written (status `proposed`); QA PASS WITH DEBT
- **Not done**: Ben's acceptance of ADR-0005 ([B-001](BLOCKERS.md)); U-001/U-002 still `investigating`
- **Exact next step**: Ben reviews docs/adr/0005-claude-code-driver.md and sets Status to accepted; then lead sets U-001/U-002 to `resolved` with the proposed resolution text already in UNKNOWNS.md, clears B-001, and starts M1-T12
- **Gotchas**: before group B, decide U-020 (Postgres port per worktree); T12 must pin the contract from the ADR, not driver.mjs (TD-002)
- **Gates**: ci.sh green on main after merge (typecheck ✅ lint ✅ test ✅ build ✅ e2e placeholder ✅)
