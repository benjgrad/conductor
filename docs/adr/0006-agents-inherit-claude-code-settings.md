# ADR-0006 · Agents inherit the user's Claude Code settings, with conductor's hard guards

- **Status**: accepted (Ben, 2026-10-23). The permission mode choice and `--permission-prompts none` are superseded by [ADR-0023](0023-permission-prompts-through-conductor.md) (2026-10-28)
- **Date**: 2026-10-23
- **Deciders**: Ben (+ Claude session 2026-10-23-agent-inherit-settings)
- **Supersedes**: the permission parts of [ADR-0005](0005-claude-code-driver.md): §Spawn `--setting-sources ""` and `--permission-mode dontAsk`, and §Tool allow-list mapping "everything else is denied by dontAsk". The rest of ADR-0005 stands, including the daemon passing the repo's CLAUDE.md via `--append-system-prompt` (U-013).

## Context
ADR-0005 ran every agent with `--setting-sources ""` and `--permission-mode dontAsk`. The only rules allowed were those the workflow aliases produce: `npm run/test/install/ci` and a few git commands. Ben's first real sessions showed this was too narrow. `ls`, `node`, `pnpm` and `python` were denied, and agents could not do ordinary work. Ben wants agent sessions to behave like his own Claude Code, governed by the permission system he has already configured. Agents run on his Claude subscription, so there is no per-token cost to guard.

Verified facts (Claude Code 2.1.309; docs checked by a claude-code-guide agent; QA probes with the real CLI; two real `-p` sessions on Opus 5.5):
- `--setting-sources user` loads `~/.claude/settings.json`, including hooks, skills and plugins. `~/.claude/settings.local.json` is local scope and loads only in sessions started in `$HOME`.
- `defaultMode: "auto"` in user settings works in `-p`, and the sessions started in `permissionMode=auto`. Anything that would prompt is denied under `--permission-prompts none`.
- Deny rules apply in every mode, including bypassPermissions, and deny beats allow.
- **No permission rule can express "edits only inside the worktree"**. `Edit(./**)` only pre-approves. A deny on `//**` or `~/**` also denies the worktree, which lives under `~/.conductor`, and allow rules can't carve exceptions out of a deny. A PreToolUse hook that exits 2 blocks the call before permission rules are evaluated. Any other non-zero exit lets the call through.
- **A repo's project settings can switch the hook off.** QA confirmed that a project `.claude/settings.json` with `disableAllHooks: true` stops a `--settings` hook from running. `"disableAllHooks": false` in the `--settings` file (flag scope) overrides user and project settings. Project hooks also run in read-only sessions without any tool call.
- `CLAUDE_CODE_SAFE_MODE=1`, in the process env or in the user settings' `env` block, also drops non-policy hooks. QA found this; `"env": {"CLAUDE_CODE_SAFE_MODE": "0"}` in the `--settings` file restores the hook (verified).
- Under `--setting-sources user`, a repo's `.claude/skills`, `.claude/agents` and `.claude/commands` do not load (real session: none of the repo's probe items appeared in `system/init`; the user's own 73 skills did).
- Claude hands `~/x` to the hook unexpanded, then expands it itself when writing.
- `--strict-mcp-config` drops user, project and plugin MCP servers, but not the claude.ai connectors. `ENABLE_CLAUDEAI_MCP_SERVERS=false` drops those. The real sessions reported `mcp_servers=[]`.

## Decision
**Agents load the user's own Claude Code settings: their permission mode, rules, hooks and skills. They never load the repo's settings. Conductor adds hard guards that no settings file can switch off.**

Spawn changes against ADR-0005 §Spawn:
```
--setting-sources user                  (was ""; never "project": the repo is untrusted)
--settings <private dir>/settings.json  (new: {"disableAllHooks": false, "env": {"CLAUDE_CODE_SAFE_MODE": "0"}, edit-guard PreToolUse hook})
--permission-mode auto                  only when the user's defaultMode is bypassPermissions (was dontAsk always)
env += ENABLE_CLAUDEAI_MCP_SERVERS=false, CLAUDE_CODE_SAFE_MODE=0 (after the state env, so a state can't override them);
       the state env is allowlisted (STATE_ENV_ALLOWED: CONDUCTOR_*, PORT, GIT_AUTHOR_/GIT_COMMITTER_ NAME/EMAIL);
       any other key (HOME, NODE_OPTIONS, CLAUDE_*, ANTHROPIC_*, …) is dropped with a debug line, so claude reads
       the same settings the cap checked and a state can't switch billing or inject code. A future per-state
       workflow env must extend the list deliberately
```
These are unchanged: `--strict-mcp-config`, `--permission-prompts none`, the conductor `--mcp-config`, the state's `--tools`, `--allowedTools` and `--disallowedTools`, and the CLAUDE.md append (`Workspace.readClaudeMd`: a regular file inside the worktree, ≤ 64 KB, no symlinks).
- **Workflow `tools` aliases** still pick the visible built-ins per state (a read-only state stays read-only) and still pre-approve their rules. They are no longer the only things allowed: whatever the user's mode and rules would allow is allowed too.
- **Hard guards**:
  - **The edit-guard hook** (`packages/daemon/src/claude/edit-guard.ts`) runs for Edit, Write, MultiEdit and NotebookEdit:
    - it checks every path field;
    - it expands `~` the way Claude does and refuses relative paths;
    - it resolves each path component with lstat/readlink, so a symlink (dangling ones included) or a `..` after one goes where the kernel would send it;
    - it exits 2 unless the target is inside the worktree.
    
    It fails closed: any error blocks, and the command ends in `|| exit 2`, so a missing node or script blocks too. The script and the settings file are 0600, in the per-session 0700 directory beside mcp.json, and are removed on exit.
  - **The hook's two known off-switches are pinned off** in the `--settings` file, which outranks user settings: `disableAllHooks: false` and `CLAUDE_CODE_SAFE_MODE=0`.
  - **A `bypassPermissions` default is capped to `auto`**, so an unattended agent keeps the classifier. The daemon logs a debug line when it does this.
  - **`Bash(git push:*)`** and the other alias denies.
  - **No MCP servers except conductor's.**
- **Model**: unchanged, but now visible in practice. With no `model` in the workflow and none in user settings, a subscription login uses the account default (Opus 5.5 on Max, as observed).

## Alternatives considered
| Option | Why not |
|---|---|
| Keep ADR-0005's own allowlist and widen the bash alias | Ben wants his existing Claude Code config to govern agents, not a second list to maintain |
| Inherit settings with no conductor guards | An unattended agent could push, or use Ben's personal connectors (Gmail, Slack, Calendar), with nobody watching |
| Also load the repo's settings (`user,project`) | The first version did, and QA showed a repo could disable the guard hook (`disableAllHooks`), add `Edit(//**)`, and run its own hooks even in read-only states. It could come back later for an explicit trusted-repo allowlist |
| `--restricted` + `--settings <copy of user settings>` | It confines file tools natively, but the daemon would have to re-merge the user's settings files itself, and it drops user skills and plugins |
| Deny rules for out-of-worktree edits | Not expressible: there is no carve-out from a deny (see Context) |

## Consequences
- Good: agents can run whatever Ben's own Claude Code would (auto mode's classifier decides unlisted commands), with his skills and hooks. One permission system to configure. A repo can't change the agent's permissions.
- Bad / accepted cost:
  - Behaviour depends on each machine's `~/.claude/settings.json`. Two daemons with different settings behave differently (TD-081).
  - The user's own hooks and plugins run in agent sessions.
  - A repo's own `.claude/settings.json` rules don't apply to agents.
  - **Bash is not confined to the worktree.** Auto mode's classifier is the only check on what an allowed command touches. With the same uid, an agent's Bash could also delete or rewrite the guard script in `$TMPDIR`; a missing script now blocks, but a rewritten one doesn't (TD-083). The real boundary is a sandbox (U-004).
  - The `git` alias pre-approves `git commit:*`, which includes `git commit -F <any file>` (TD-082).
  - The repo's CLAUDE.md, untrusted text, is still appended to the system prompt as plain text, after conductor's instructions (unchanged since M1-T14; TD-084).
- **Exception: requirements reviewers** ([ADR-0009](0009-transition-requirements-review.md), 2026-10-23). A reviewer (`start_session.review`) does not inherit the user's mode: it always runs with `--permission-mode dontAsk`, so only its pre-approved read-only rules run and everything else is denied without prompting. The other guards here (`--setting-sources user`, the edit-guard hook, AGENT_ENV, the state-env allowlist) apply to it unchanged.
- Follow-ups: TD-081, TD-082, TD-083, TD-084; U-004.

## Revisit when
Agents run on machines whose owner is not the person who configured them (M2 fleet with shared daemons), a repo needs its own project settings honoured (trusted-repo allowlist), or a sandbox lands (U-004).
