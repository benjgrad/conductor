# ADR-0006 · Agents inherit the user's Claude Code settings, with conductor's hard guards

- **Status**: accepted (Ben, 2026-10-23)
- **Date**: 2026-10-23
- **Deciders**: Ben (+ Claude session 2026-10-23-agent-inherit-settings)
- **Supersedes**: the permission and settings parts of [ADR-0005](0005-claude-code-driver.md) (§Spawn `--setting-sources ""` and `--permission-mode dontAsk`; §Tool allow-list mapping "everything else is denied by dontAsk"). The rest of ADR-0005 stands.

## Context
ADR-0005 ran every agent with `--setting-sources ""` and `--permission-mode dontAsk`. Only the rules that the workflow aliases produce were allowed: `npm run/test/install/ci` and a few git commands. Ben's first real sessions showed this was too narrow. `ls`, `node`, `pnpm` and `python` were denied, and agents could not do ordinary work. Ben wants agent sessions to behave like his own Claude Code, using the permission system he has already configured. Agents run on his Claude subscription, so there is no per-token cost to guard.

Verified facts (Claude Code 2.1.309; docs checked by a claude-code-guide agent; one real `-p` session on Opus 5.5):
- `--setting-sources user,project` loads `~/.claude/settings.json` and the worktree's `.claude/settings.json`, including CLAUDE.md, hooks and skills. `~/.claude/settings.local.json` is local scope and loads only in sessions started in `$HOME`.
- `defaultMode: "auto"` in user settings works in `-p`, and the real session started in `permissionMode=auto`. Project settings cannot set auto or bypassPermissions. Anything that would prompt is denied under `--permission-prompts none`.
- Deny rules apply in every mode, including bypassPermissions, and deny beats allow.
- **No permission rule can express "edits only inside the worktree"**. `Edit(./**)` only pre-approves. A deny on `//**` or `~/**` also denies the worktree, which lives under `~/.conductor`, and allow rules can't carve exceptions out of a deny. In auto mode an out-of-cwd edit goes to the classifier, which may allow it. A PreToolUse hook that exits 2 blocks the call before permission rules are evaluated, in every mode.
- `--strict-mcp-config` drops user, project and plugin MCP servers, but not the claude.ai connectors. `ENABLE_CLAUDEAI_MCP_SERVERS=false` drops those. The real session reported `mcp_servers=[]`.

## Decision
**Agents load the user's and the repo's Claude Code settings, so the user's permission mode, rules, hooks, skills and CLAUDE.md apply. Conductor adds hard guards on top: the edit-guard hook, deny rules and the MCP lockdown.**

Spawn changes against ADR-0005 §Spawn:
```
--setting-sources user,project          (was "")
--settings <private dir>/settings.json  (new: the edit-guard PreToolUse hook)
(no --permission-mode)                  (was dontAsk: the user's defaultMode applies)
env += ENABLE_CLAUDEAI_MCP_SERVERS=false
```
These are unchanged: `--strict-mcp-config`, `--permission-prompts none`, the conductor `--mcp-config`, and the state's `--tools`, `--allowedTools` and `--disallowedTools`.
- **Workflow `tools` aliases** still pick the visible built-ins per state (a read-only state stays read-only) and still pre-approve their rules. They are no longer the only things allowed: whatever the user's mode and rules would allow is allowed too.
- **Hard guards**, which hold whatever the user's settings say:
  - The edit-guard hook (`packages/daemon/src/claude/edit-guard.ts`) runs for Edit, Write, MultiEdit and NotebookEdit. It resolves the target through symlinks and exits 2 unless the path is inside the session worktree. It fails closed on bad input.
  - `Bash(git push:*)` and the other alias denies.
  - No MCP servers except conductor's.
  - The hook script and settings file live in the per-session 0700 directory with the MCP config, and are removed on exit.
- **CLAUDE.md**: Claude Code loads it from the project source, so the daemon no longer reads it and pastes it into `--append-system-prompt`. `Workspace.readClaudeMd` is removed. The append now carries only `CONDUCTOR_INSTRUCTIONS`.
- **Model**: unchanged, but now visible in practice. With no `model` in the workflow and none in user settings, a subscription login uses the account default (Opus 5.5 on Max, as observed).

## Alternatives considered
| Option | Why not |
|---|---|
| Keep ADR-0005's own allowlist and widen the bash alias | Ben wants his existing Claude Code config to govern agents, not a second list to maintain |
| Inherit settings with no conductor guards | An unattended agent could push or use Ben's personal connectors (Gmail, Slack, Calendar) with nobody watching |
| `--restricted` + `--settings <copy of user settings>` | `--restricted` confines file tools natively, but it ignores the user/project sources (CLAUDE.md, skills, project rules) and would need the daemon to re-merge settings files itself |
| Deny rules for out-of-worktree edits | Not expressible: no carve-out from a deny (see Context) |

## Consequences
- Good: agents can run whatever Ben's own Claude Code would (auto mode's classifier decides unlisted commands), and they follow the repo's CLAUDE.md and project settings natively. One permission system to configure.
- Bad / accepted cost:
  - Behaviour now depends on each machine's `~/.claude/settings.json`. Two daemons with different settings behave differently (TD-081).
  - The repo's `.claude/settings.json` (project scope) loads, so a cloned repo can add allow rules and hooks. That is no new exposure: agents already run the repo's own scripts through `npm run` (TD-019). Project settings cannot enable auto or bypassPermissions.
  - The user's hooks and plugins run in agent sessions.
  - Bash is still not confined to the worktree. Auto mode's classifier is the only check on what an allowed command touches (U-004 sandbox).
  - The `git` alias pre-approves `git commit:*`, which includes `git commit -F <any file>` (a read outside the worktree into a commit message). Before ADR-0006 that was the only way past dontAsk; now auto mode would judge the command anyway, so the alias could be narrowed (TD-082).
- Follow-ups: TD-081, TD-082; U-004 (sandbox) stays the real Bash boundary.

## Revisit when
Agents run on machines whose owner is not the person who configured them (M2 fleet with shared daemons), or a sandbox lands (U-004).
