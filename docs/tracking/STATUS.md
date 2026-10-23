# Status

> Living dashboard. Rewritten (not appended) by the lead session at the end of every session. Keep it under one screen.

**Updated**: 2026-10-23 · session [2026-10-23-agent-inherit-settings](sessions/2026-10-23-agent-inherit-settings.md)

## Now
- **Milestone**: [M1 · Single machine](../plan/milestones/M1-single-machine.md) **complete, pending Ben's sign-off**. All groups A–E are merged. Since then:
  - the real-run fixes (819cea6);
  - TD-079/TD-080 (d83acc2);
  - [ADR-0006](../adr/0006-agents-inherit-claude-code-settings.md): agents inherit Ben's Claude Code settings, with conductor's hard guards.
- **Phase**: M1 sign-off, then M2 planning
- **Next action**:
  - Ben restarts the daemon on the new build and runs a ticket on the `m1_basic` workflow (default model, Opus 5.5), then signs off M1.
  - The `E2E_REAL_CLAUDE=1` run now uses subscription quota, not money; with it the T05a real-mode check closes ([UNFINISHED](UNFINISHED.md)).
  - Ben rules on U-045 and U-048.
  - Lead:
    - fixes U-046 (flaky daemon test; fix identified);
    - pays TD-068 and TD-082 (narrow `git commit:*` before M3);
    - decides U-047 and U-043, confirms U-029.
  - Then plan M2.

## In flight
| Task | Branch | Agent | State |
|---|---|---|---|
| — | — | — | nothing in flight |

## Health
| Open unknowns | Open blockers | Tech debt items | Unfinished handoffs |
|---|---|---|---|
| 28 open of 48 ([UNKNOWNS](UNKNOWNS.md)) | 0 of 4 ([BLOCKERS](BLOCKERS.md)) | 62 open of 84 ([TECH_DEBT](TECH_DEBT.md)) | 1 ([UNFINISHED](UNFINISHED.md)) |

## Milestone progress
M1: 18 / 18 tasks done (T00, T01, T12, T13, T02, T03, T05a, T05b, T09, T04a, T04b, T06, T08, T11, T07, T09b, T14, T10). T04, T05 and T09 were split into a/b. Exit criteria met; awaiting Ben's sign-off.

## Last session
ADR-0006, branch `agent-inherit-settings`: agents load Ben's `~/.claude/settings.json` (`--setting-sources user`), so his `auto` mode, rules, hooks and skills apply. A repo's own settings, skills and agents never load.

Hard guards:
- an edit-guard hook keeps edits in the worktree, with `disableAllHooks` and safe mode pinned off;
- a `bypassPermissions` default is capped to `auto`;
- `git push` is denied;
- no MCP servers but conductor's.

Two QA rounds: FAIL (a repo could disable the hook), then PASS WITH DEBT. Verified in real Opus 5.5 sessions. New debt: TD-081..084. Saved the default-model `m1_basic` workflow on the local board.
