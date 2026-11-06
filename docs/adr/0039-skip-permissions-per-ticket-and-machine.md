# ADR-0039 · Skip permissions per ticket, and as a machine's default

- **Status**: accepted (Ben's ticket "Dangerously-skip-permissions", 2026-11-06)
- **Date**: 2026-11-06
- **Deciders**: Ben (+ the conductor session on that ticket)
- **Amends**: [ADR-0023](0023-permission-prompts-through-conductor.md) §3 ("`bypassPermissions` is opt-in per machine … an ADR-0022 machine-override value"). The machine opt-in exists before ADR-0022's `machine_settings` does, and a ticket can opt in too.

## Context
Every working agent runs in `--permission-mode auto` (ADR-0023 §1). What auto mode would still ask goes to the board as **Needs permission**. A human must answer each prompt. On a trusted machine, or for a ticket whose agent keeps getting stopped, Ben wants Claude Code's "dangerously skip permissions" mode (`bypassPermissions`). He wants to turn it on for a ticket during any session, and also as a machine's default.

ADR-0023 §3 already allows `bypassPermissions` as a per-machine opt-in, but only through ADR-0022's machine override (M2-T28..T28e, MR-T17b). None of that is built yet.

## Decision
1. **Two settings.** The effective value is `ticket ?? machine default`. It applies to **working agents only**: requirements reviewers and QA sessions keep `dontAsk` (ADR-0009, ADR-0022 D2), and triage and assistant jobs are unaffected.
   - **Ticket**: `ticket.skip_permissions` is `true`, `false` or `null`. Null means "the machine's default". It can be changed in any column, at any time, including while the agent runs. It is not gated by `ticket_editable`.
   - **Machine**: `machine.skip_permissions_default`, default `false`. It is set in the Machines drawer.
2. **At process start.** Every `start_session` reads both values (`withSkipPermissions`, `orchestrator/src/engine/skip-permissions.ts`). This covers a new state, a resume after `ask_user`, and a reopen. When the value is on, `start_session.permission_mode` is `'bypassPermissions'`, and the Rust daemon passes `--permission-mode bypassPermissions` instead of `auto`. The field is sent only to a daemon that advertises `DAEMON_FEATURE_PERMISSION_MODE`; an older daemon keeps auto mode, and the Machines drawer says so. The field is a literal, so no other mode can be pushed.
3. **Mid-run.** While the value is on, a `permission_request` from the session is stored already **allowed once** with the message "skip permissions is on for this ticket". The allow goes back on the socket at once, the same way the "not running" deny does, so the board never shows it. Turning the ticket's setting on also allows the session's pending prompts (`decided_by` = the user). A stuck **Needs permission** card therefore unblocks immediately. The running process itself stays in auto mode until its next start, so an action that auto mode's classifier denies outright is still denied until then (see Alternatives).
4. **What still holds in bypass mode** (ADR-0006, `edit_guard.rs`):
   - deny rules (`Bash(git push:*)` and every alias deny; `--disallowedTools` is evaluated in every mode);
   - the edit-guard PreToolUse hook, which runs before permission rules in every mode, including bypass;
   - `--setting-sources user` (never the repo's settings), the agent env allowlist, and pushes only through conductor's entry actions.
   
   It is still not a sandbox (TD-019, U-004).
5. **Board only.** The setting is never exposed over MCP: no MCP tool reads or writes it, and advisor proposals still reject `permission_mode` (ADR-0033).
6. **Interim storage.** `machine.skip_permissions_default` is a column for now. When M2-T28c builds `machine_settings`, it moves into the override's `permission_mode`, and MR-T17b folds it into `resolveEffectivePolicy`. The ticket's setting stays on the ticket.

## Consequences
- An agent can run without a human answering prompts, per ticket or per machine. It runs without the classifier too, so a bad instruction now executes instead of being asked about.
- Any member of the account can flip both settings today. There is no role in the API's auth scope yet, so ADR-0022's "owner or admin" rule isn't enforced (tracked as an open question).
- Claude Code refuses `bypassPermissions` when it runs as root, unless `IS_SANDBOX=1` is set. Conductor doesn't set it. On such a machine the agent's process exits with Claude's error in the stderr tail on the card.

## Alternatives considered
| Option | Why not (yet) |
|---|---|
| Switch the live process's mode (stream-json `control_request` `set_permission_mode`) | Needs every worker spawned with `--allow-dangerously-skip-permissions`, and neither has been verified on the pinned Claude Code. Proposed as a follow-up; auto-allowing prompts covers the stuck-card case now |
| Restart the agent process with the new mode | Loses the in-flight turn, and needs an engine effect for a kill-and-resume |
| Wait for ADR-0022's machine override | Leaves the per-ticket case out, and that whole stack is still `todo` |
