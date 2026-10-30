# ADR-0027 · An agent's `git push` is a board prompt, not a hard deny

- **Status**: accepted (Ben, 2026-10-30)
- **Date**: 2026-10-30
- **Deciders**: Ben (+ Claude session 2026-10-30-promptable-push)
- **Supersedes**:
  - [ADR-0023](0023-permission-prompts-through-conductor.md) §4 ("Deny rules never reach a human … A prompt can't approve a push") for `git push` only.
  - The "`git push` denied" item in [ADR-0006](0006-agents-inherit-claude-code-settings.md).

  Every other alias deny stays a hard deny.

## Context
On 2026-10-30, "Morgan" (ticket "Mobile-friendly UX", session `66729315`) needed a draft PR so Ben could see its UX-audit screenshots. Ben chose that option. The agent ran `git push -u origin HEAD`, and Claude Code answered "Permission to use Bash with command git push … has been denied." The push was blocked by `BASE_TOOL_POLICY`'s `Bash(git push:*)`, passed as `--disallowedTools`. Deny rules are evaluated before `--permission-prompt-tool`, so nothing reached the board. The agent fell back to `ask_user` and offered "allow it through the permission prompt", which was not possible.

Spike (CLI 2.1.314, the production worker argv in `--permission-mode auto`, `cli-driver.real.test.ts`):

| Setup | Result |
|---|---|
| No rule for `git push` | Auto mode pushes **without asking** |
| `permissions.ask: ["Bash(git push:*)"]` in the `--settings` file | Reaches `mcp__conductor__permission`; Allow once → pushed |
| A PreToolUse hook answering `permissionDecision: "ask"` | Same as the ask rule |
| Prompt tool in the model's tool list | No (`init.tools` lacks it; answers part of U-104) |

So dropping the deny alone would let agents push unprompted. An `ask` rule is what turns the push into a prompt.

## Decision
1. **A worker whose prompts reach the board gets `git push` as an `ask` rule, not a deny.** That means `--permission-prompts host`, not a reviewer.
   - `shared` keeps `Bash(git push:*)` in `BASE_TOOL_POLICY.deny` and lists it in `PROMPTABLE_DENY_RULES`.
   - The daemon's `splitPromptableDenies` leaves it out of `--disallowedTools` and writes it to `permissions.ask` in the edit-guard `--settings` file. No CLI flag carries ask rules.
   - The flag scope's ask outranks any allow rule in the user's settings and auto mode's classifier, so every push asks.
2. **Requirements reviewers (`dontAsk`) and the no-prompt fallback (`--permission-prompts none`) keep the hard deny.** Nobody could answer their prompt.
3. **A push is Allow once or Deny, never Allow always.** Claude ranks deny > ask > allow, so an exact allow rule for a push would never take effect. `alwaysRuleFor` returns null for any Bash command containing `git push`, and the UI hides Allow always for it.
4. **The agent prompt changes.** It used to say "Never push"; it now says: later steps push and open the PR; push yourself only when the task needs it earlier (e.g. a draft PR to show work); every push waits for a human; never force-push. `open_pr` already reuses a branch and PR that an agent pushed.

## Consequences
- A human can let an agent publish work in progress (a draft PR, screenshots) with one click from the board, without a shell on the machine.
- The board can show a push to any remote or ref (`git push origin main`), and the human approves the exact command shown. A misclick is the risk; Allow always can't apply to pushes, so there is no standing approval to misuse.
- `gh pr create` (and `Bash(gh:*)` for `qa`) stays denied (TD-020). An agent can push a branch, but it cannot open the PR itself. Morgan's "draft PR" still needs a human (or the workflow's open-PR step) to open it.
- The Rust daemon (ADR-0026, MR-T07/MR-T08) must port `splitPromptableDenies` and the `permissions.ask` settings key. The PARITY rows for the changed TS tests track it.

## Implementation
M2-T29e (`m2-t29e-promptable-push`).
