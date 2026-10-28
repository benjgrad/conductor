# ADR-0022 · Layered agent settings: workflow profile, then a per-machine override

- **Status**: proposed (shape chosen by Ben 2026-10-28, "both layers"; details pending his approval of this ADR)
- **Date**: 2026-10-28
- **Deciders**: Ben (+ Claude session 2026-10-28-agent-permissions)

## Context
What an agent may do today is decided in three places that nobody can see together:
1. **The workflow state's `tools`** (`docs/design/workflows/*.json`, resolved by `packages/shared/src/workflow/tools.ts`).
2. **The machine's `~/.claude/settings.json`** (ADR-0006). Conductor neither records nor checks it (TD-081).
3. **The daemon's env and `<root>/config.json`** (max sessions, tags, repo roots, allowed repo hosts).

The Machines page shows repos, capabilities and alerts. It shows none of the above, and `PATCH /api/machines/:id` can only rename. On 2026-10-28 two sessions stalled on permissions, and the only way to see why was reading transcripts on the machine (ADR-0023 §Context). Ben wants each machine's settings visible and editable from conductor.

## Decision
**The effective agent policy for a session is computed from these layers, in order:**
1. **Workflow profile (base).** The state's `tools` aliases, as today. Edited with the workflow.
2. **Machine override.** Stored by the orchestrator in `machine_settings` and edited on the Machines page by the account owner or an admin. It holds:
   - `states: {<state>: {add_aliases?, allow?, deny?}}` plus `all_states`. Extra aliases, extra **exact** allow rules, extra deny rules.
   - `permission_mode`: `auto` (default, ADR-0023) | `default` | `bypassPermissions` (opt-in).
   - `permission_timeout_min`, `max_sessions`, `tags`, `roots`, `allowed_repo_hosts`.
3. **Daemon ceiling (local).** `config.json` `remote_settings: "full" | "deny_only" | "off"`, default `full`.
   - `deny_only` applies only the override's denies and narrowing values.
   - `off` ignores the override and reports that it did.
   - The machine's owner can refuse remote widening without trusting the orchestrator.

**Invariants (in `resolveEffectivePolicy`, `packages/shared`; enforced on save and again on the daemon):**
- `Bash(git push:*)` and every base alias deny stay. An override can add denies, never remove them.
- No `Bash` / `Bash(*)` wildcard. No prefix rule on `git diff|log|show` (the `--output` file write, TD-082). No `Read(//**)` or other rules outside the worktree.
- A session uses the policy computed when it **starts**. Changes apply to the next session, never mid-run.
- Every change is audited: who, when, before and after.

**Visibility:**
- The daemon reports `reported_settings` in its inventory: `config.json` (no credential), env-derived limits, the `~/.claude` `defaultMode` and whether user settings exist (pays TD-081's "neither records"), its ceiling, and the Claude Code version.
- `GET /api/machines/:id/settings` returns `{override, reported, effective_by_state}`. `effective_by_state` lists, for each state of each workflow the account uses, the `--tools`, allow and deny lists and the permission mode a session would get.
- The orchestrator pushes `settings_update {version, override}` on connect and on change. The daemon acks with the version it applied, or the reason it refused.

## Consequences
- A web edit can widen what agents run on a machine, so the ceiling and invariants are the safety story. A per-machine sandbox stays U-004.
- `machine_settings` is a new table, the first schema change of this kind after M1 (Ben agreed to the shape on 2026-10-28).
- ADR-0023's "Allow always" writes into this override.
- Reported settings are the daemon's claim, not proof. The daemon runs on the user's machine, which is trusted for its own sessions.

## Alternatives considered
| Option | Why not |
|---|---|
| Workflow-only profiles | Can't express "this Linux box may run pnpm, Ben's Mac already allows it", or a per-machine bypass opt-in |
| Machine-only settings | Loses the per-state shape (a read-only plan state) that the workflow encodes |
| Edit `~/.claude/settings.json` remotely | Writes into the user's own config, which affects their interactive Claude Code too |

## Implementation
M2-T28 (this ADR + contracts), M2-T28b (shared), M2-T28c (orchestrator), M2-T28d (daemon), M2-T28e (web).
