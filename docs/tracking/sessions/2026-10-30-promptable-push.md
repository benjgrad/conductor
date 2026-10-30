# Session 2026-10-30 · promptable-push

- **Lead**: Claude (Opus 5.5) with Ben
- **Milestone / phase**: M2 · Plan → Build → QA
- **Goal for this session**: find out why Morgan's permission check never reached the board, and fix it

## What happened
- Morgan (agent on ticket `4bfe56bb` "Mobile-friendly UX", session `66729315`) ran `git push -u origin HEAD` to open a draft PR with screenshots. Ben chose that option. Claude answered "Permission to use Bash … has been denied". Cause: `Bash(git push:*)` in `--disallowedTools` is evaluated before the prompt tool (ADR-0023 §4). The agent fell back to `ask_user` and offered an impossible "allow through the permission prompt".
- Wider finding: `permission_request` on gradyserver has **0 rows ever**. Workers run in auto mode, and the classifier decides or denies by itself (a 2026-10-28 classifier denial never prompted). That's U-118.
- The local daemon is `4d07791`, older than PR #75: Morgan's live prompt lacks the "## Permissions" section.
- Ben: make push promptable. Spike against CLI 2.1.314 in auto mode: a push with no rule runs unprompted; an `ask` rule in `--settings` (or a hook answering `ask`) reaches `mcp__conductor__permission`. The prompt tool isn't in the model's tool list (U-104 resolved).
- M2-T29e built on `m2-t29e-promptable-push`: `PROMPTABLE_DENY_RULES`, `splitPromptableDenies`, `permissions.ask` in the edit-guard settings, no `always_rule` for pushes, the agent prompt and CLAUDE.md lines, the real-CLI probe (auto mode, end to end, passing), ADR-0027, doc amendments, PARITY rows.
- Gates: typecheck, lint and build green; `pnpm test` 2721/2722, with one timing flake in an untouched web test that passes alone (TD-197).

## Agents dispatched
| Agent | Task | Branch | Result (PASS / FAIL / partial) |
|---|---|---|---|
| none | | | |

## Tracking changes
- Unknowns raised / resolved: U-118 raised; U-104 resolved
- Blockers raised / cleared: none
- Tech debt added / paid: TD-196, TD-197 added
- ADRs: ADR-0027
- Unfinished handoffs written: none

## Next session should start with
- Ben pushes `main` (CI deploys the orchestrator), then the local daemon is upgraded past `4d07791` so PR #75 and ADR-0027 are live. Morgan's process still has the old argv: restart its session, then answer `447be338` with "1, retry the push".
- U-118: run the classifier probe. If classifier denials never prompt, prioritise ADR-0023 §5 (denial counts on the card).
