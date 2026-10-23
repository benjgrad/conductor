# Session 2026-10-23 · agent-inherit-settings

- **Lead**: Claude (Opus 5.5) with Ben
- **Milestone / phase**: M1 sign-off (no milestone task; driver change Ben asked for after trying M1)
- **Goal for this session**: agents use the local default model (Opus) and Ben's own Claude Code permission settings instead of conductor's narrow allowlist, on his subscription.

## What happened
- **Model.** The board's only workflow was `m1_basic_haiku`, from the README's cheap-trial tip. Saved the standard `m1_basic` (no model) to the local orchestrator; with no model set, Claude Code uses the account default (Opus 5.5).
- **Billing.** Agents run Ben's own `claude` login. No `ANTHROPIC_API_KEY` is set, so there's no per-token billing; the card `$` is Claude Code's estimate.
- **Permissions.** Ben chose "your settings + hard guards" (AskUserQuestion). A claude-code-guide agent checked the docs, and the local `claude --help` (2.1.309) was read.
- **First version (6c93679):**
  - `--setting-sources user,project`, no `--permission-mode`;
  - an edit-guard PreToolUse hook via `--settings`;
  - `ENABLE_CLAUDEAI_MCP_SERVERS=false`;
  - the CLAUDE.md append dropped.
  
  QA **FAIL**:
  - a repo's `.claude/settings.json` with `disableAllHooks: true` switched the hook off (verified on the real CLI);
  - `~` paths, a crash, or a second path field got past the hook.
  
  Two automated security reviews flagged the project source, the dropped permission mode, and a dangling-symlink bypass.
- **Fix round 1 (26f542e):**
  - `--setting-sources user` only; the guarded CLAUDE.md append restored as on main;
  - `disableAllHooks: false` pinned;
  - the guard now:
    - resolves each path component with lstat/readlink;
    - expands `~` and refuses relative paths;
    - checks every path field;
    - fails closed (try/catch and `|| exit 2`);
  - a `bypassPermissions` default is capped to `auto`.
  
  QA **PASS WITH DEBT**: `CLAUDE_CODE_SAFE_MODE=1` (env or user settings `env`) also disables hooks.
- **Final round:**
  - `CLAUDE_CODE_SAFE_MODE=0` pinned in the `--settings` env and in the agent env;
  - a state env's `CLAUDE_CONFIG_DIR` is dropped (automated review);
  - TD-084 recorded for the untrusted CLAUDE.md going into the system prompt.
- **Real sessions on Ben's subscription, three short turns:**
  - Opus 5.5, `permissionMode=auto`, `mcp_servers=[]`;
  - Bash `ls` ran and an inside write worked;
  - outside, `~/x` and dangling-symlink writes were blocked;
  - a hostile repo `.claude/settings.json` was ignored;
  - the repo's skills, agents and commands did not load, while Ben's 73 skills did.
- **Gates on the branch:**
  - typecheck ✅ lint ✅ build ✅;
  - test ✅ 521 passed / 2 skipped;
  - test:e2e ✅ 6 passed / 1 skipped;
  - `E2E_REAL_CLAUDE=flags` ✅.

## Agents dispatched
| Agent | Task | Branch | Result (PASS / FAIL / partial) |
|---|---|---|---|
| claude-code-guide | Claude Code settings/permission facts | — | report (docs-sourced) |
| qa-reviewer (run as general-purpose) | ADR-0006 | agent-inherit-settings @ 6c93679 | FAIL (repo disables the hook; `~`; fail-open) |
| qa-reviewer (same agent, re-QA) | ADR-0006 fix round 1 | agent-inherit-settings @ 26f542e | PASS WITH DEBT (safe mode; fixed after) |

## Tracking changes
- Unknowns raised / resolved: U-013 amended by ADR-0006. QA's question about repo skills under `--setting-sources user` was answered by a real session: they don't load.
- Blockers raised / cleared: none
- Tech debt added / paid: added TD-081 (per-machine settings), TD-082 (`git commit:*` prefix), TD-083 (guard script rewritable by same-uid Bash), TD-084 (CLAUDE.md in the system prompt)
- ADRs: ADR-0006 (accepted, Ben); ADR-0005 permission parts superseded
- Unfinished handoffs written: none

## Next session should start with
Ben restarts the daemon on main and runs a real ticket on `m1_basic`, then signs off M1. The lead pays TD-082 before M3 and fixes U-046, then plans M2.
