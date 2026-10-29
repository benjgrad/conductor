# ADR-0023 · Agents run in auto mode; permission prompts reach a human through conductor

- **Status**: accepted (Ben, 2026-10-28)
- **Date**: 2026-10-28
- **Deciders**: Ben (+ Claude session 2026-10-28-agent-permissions)
- **Supersedes**: these parts of [ADR-0006](0006-agents-inherit-claude-code-settings.md):
  - §Decision "`--permission-mode auto` only when the user's defaultMode is bypassPermissions";
  - "`--permission-prompts none`" in the unchanged list.

  The rest of ADR-0006 stands: user settings only, the edit-guard hook, the pinned off-switches, conductor's MCP server only, and `git push` denied.

## Context
On 2026-10-28 two dogfood sessions stalled on the Linux machine:
- **M2-T18 ("Nova")** had 18 tool calls auto-denied: `pnpm exec vitest`, `pnpm i`, `./node_modules/.bin/prettier`, `chmod 755`, `diff <(…)`, `git update-index --chmod=+x`, `git -C <wt> add -A` and others. Its build check then failed, and it asked a human to run the gates.
- **M2-T18b ("Hazel")** could not refresh its branch and could not read outside the worktree.

Why:
- That machine's `~/.claude/settings.json` has no `defaultMode`. The daemon passes no `--permission-mode`, so the session runs in the default mode.
- Everything outside the state's alias rules (`bash` = `npm run|test|install|ci` only) would prompt. `--permission-prompts none` turns every prompt into a silent denial.
- The daemon counts denials (`stream-parser.ts` `permissionDenials`) and then drops the count. No human ever saw them.

ADR-0006 assumed each machine's own Claude Code settings would govern agents. In practice, a machine whose settings were never tuned denies most real work, and there is no way to say yes from the board.

Verified (Claude Code 2.1.312, `claude --help`):
- `--permission-prompts host` sends prompts to "the SDK host or `--permission-prompt-tool`".
- `none` denies them.
- The permission mode still decides everything else.

## Decision
1. **Auto mode by default.** The daemon passes `--permission-mode auto` to every working agent, whatever the machine's `defaultMode` is.
   - Requirements reviewers keep `dontAsk` (ADR-0009).
   - The classifier approves routine work (package scripts, chmod, diff, local git) without a list for each one.
2. **Prompts reach a human.** The daemon passes `--permission-prompts host --permission-prompt-tool mcp__conductor__permission`. When auto mode would still ask:
   - Claude calls the conductor `permission` tool.
   - The daemon sends `permission_request` to the orchestrator and holds the call open.
   - The session shows **Needs permission** on its card, with the tool and input. This is a sub-status, not an FSM transition: the run is still inside its state.
   - A human picks **Allow once**, **Allow always** or **Deny (with a note)**.
     - *Allow always* records an exact allow rule: on the ticket until ADR-0022's machine override exists, then on the machine override.
   - With no answer within 30 min (configurable per machine later), the call is denied with "no human answered". The agent can then `ask_user`.
3. **`bypassPermissions` is opt-in per machine, never a default.** It is an ADR-0022 machine-override value, set by the owner and shown on the Machines page. Without it, a user-settings `bypassPermissions` is still capped to `auto` (ADR-0006).
4. **Deny rules never reach a human.** `Bash(git push:*)` and the other alias denies are evaluated before the prompt tool, in every mode. A prompt can't approve a push.
5. **Denials are visible.** Each turn's `permissionDenials` count and the denied tool names go on the session event, and the card shows "N tool calls denied".

## Consequences
- Agents can do ordinary build and test work on an untuned machine.
- A human can unblock the rest from the board, without a shell on the machine.
- The orchestrator stores permission requests and decisions. They are new protocol frames (10-contracts §Permission prompts), and the decision carries an idempotency key `request_id`.
- A long-held MCP call keeps the turn open. That counts against the session's lease and turn time, so the 30-min default timeout bounds it. Every loop stays bounded and every failure ends at a human (the engine invariants).
- Auto mode needs a Claude Code version that supports it. The daemon reports the version already, and an unsupported version falls back to the old behaviour with a machine alert.
- TD-019 still holds: allow rules and the classifier are not a sandbox (U-004).

## Alternatives considered
| Option | Why not |
|---|---|
| Prompts to the UI, default mode | Safe, but every pnpm or chmod interrupts a human until "Allow always" rules build up |
| `--dangerously-skip-permissions` everywhere | No classifier at all on unattended agents. Kept only as an explicit per-machine opt-in (§3) |
| Widen the alias allowlists only | The lists can't keep up with real work (ADR-0006's own finding), and denials stay silent |

## Implementation
M2-T29 (contracts), M2-T29b (daemon), M2-T29c (orchestrator), M2-T29d (web). Also M2-T30 (pnpm-aware build checks and the pnpm alias rules).
