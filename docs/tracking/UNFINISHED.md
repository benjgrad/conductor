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

## M1-T12 · Contracts
- **Branch / worktree**: `m1-t12-contracts` @ `.claude/worktrees/wf_ecda817e-573-1` (pushed to origin)
- **Last commit**: 6ae2815 (fix round 2: orphaned-process rule, `KillPayload.target_command_id`, 04 mermaid line)
- **Done so far**: every seam file in the T12 scope plus fakes and fixtures; `docs/design/10-contracts.md`; gates green on Node 22 (10 files, 109 tests). QA confirmed all acceptance items except the interface review and Ben's approval; round-2 fixes closed.
- **Not done**: QA verdict FAIL on the interface review, which found 13 gaps. Items 1–6 force a contract edit or a cross-task guess in group C:
  1. The `send_input` `no_live_process` re-answer: neither the snapshot nor `command.refused` carries the answer text. Add `answer` + `input_request_id` to the event, or `pending_answer` to the snapshot.
  2. The board `Last-Event-ID` bigserial cursor can skip rows when T04, T08 and T11 write concurrently. Add one `insertBoardEvents(tx, drafts)` helper behind `pg_advisory_xact_lock`.
  3. `BoardCard` derivation is duplicated across T04, T08 and T09b. Add a pure `toBoardCard(ticket, session, openInput)` + `toInputRequestDto`.
  4. No owner for the orchestrator composition root (`main.ts`) or the daemon WS path/port. Add `API_PATHS.daemonWs`, the port env var, factory signatures, and name an owner.
  5. No `CommandRunner` factory for T05 to wire T06. Add `CreateCommandRunner`, a placeholder `commands/index.ts`, and optionally a `FakeCommandRunner`.
  6. seq after a daemon restart. Next seq = max(local, `registered.last_seq` + 1).
  7. Guard evaluation (`branch_has_commits`). Add `guards` to `complete_state`, or say M1 treats guards as passing (TD).
  8. Effect → WS fields: `start_session.env`, `kill.target_command_id` for engine kills, and which envelope fencing token outbox commands use.
  9. `FakeEngineService` can't script ignored, rejected or `boardEvents` results. Add `respondWith` and export `APPLY_IGNORE_REASONS` (TD-016).
  10. ApplyRejectReason / ignored → HTTP status + `ApiError.code` map; `/approve` bodies.
  11. `fencing_seq` and the one-live-session-per-ticket partial unique index are missing from 02-data-model.
  12. Who maintains `wall_seconds`.
  13. `TOOL_ALIASES` mapping workflow tool names to `ToolPolicy`.

  QA also found minor drift: 10-contracts:123 says `ApplyOutcome` where the type is `ApplyEventResult`; 02:81 doesn't mention the fencing bump on a `start_session` refusal; 04 §4 Leases doesn't mention the heartbeat backstop kill.
- **Exact next step**: Ben picks which gaps to fix before merge (the lead recommends 1–6 + 8 + 9 + 11, with the rest as U/TD rows). Then run implementer fix round 3 on `m1-t12-contracts` for those gaps, the 3 drift items and the TD-015 marker swap, re-run QA, and get Ben's approval of 10-contracts. The integrator then merges T12 and closes U-009 and TD-002.
- **Gotchas**: T12 must rebase or merge onto main (ded29ca, T13 toolchain: TS 7 / vitest 5 / eslint 10 / Node 22 via .npmrc) and re-run gates; the round-2 gates ran against the old toolchain majors on 64717bc. Its ADR-0004 node-pg-migrate line edit is out of scope but harmless (it counts toward TD-009).
- **Gates**: typecheck ✅ lint ✅ test ✅ build ✅ (on the pre-T13 base)
