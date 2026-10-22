# 09 · Security and budgets

## Threat model (v1, one org)
Agents run arbitrary code on developer machines with that developer's credentials. The goals are to limit the blast radius per state, keep shared-system writes in one audited place, and stop runaway spend.

## Controls
| Control | Mechanism | Slice |
|---|---|---|
| Per-state tool permissions | `tools` allow-list per agent state, passed to Claude Code (`--allowedTools` / settings) by the daemon | 1 |
| Worktree confinement | Agent cwd is its worktree; the shared clone is never edited | 1 |
| Sandbox | Container per session where the machine supports it; worktree-only on macOS for now ([U-004](../tracking/UNKNOWNS.md)) | 3 |
| Connector secrets | Only in the orchestrator (env / secret store), never sent to daemons | 3 |
| Skill credentials | Machine-local (gh, Slack skill). Documented as a deliberate split ([01](01-architecture.md#credentials-split)) | 1 |
| Daemon enrollment | Per-machine token, revocable; TLS for the WS ([U-008](../tracking/UNKNOWNS.md)) | 2 |
| UI auth | TBD ([U-008](../tracking/UNKNOWNS.md)). M1 runs on localhost only | 2 |
| Audit | Every transition and connector call is an `event` row | 1 |

## Budgets
- Workflow-level: `budget.usd`, `budget.minutes`, `budget.max_loop_retries`.
- The daemon reports `spend` events, from Claude Code usage/cost output ([U-001](../tracking/UNKNOWNS.md)). The orchestrator accumulates `session.spend_usd` and `wall_seconds`.
- Exceeded → `on_budget_exceeded` (default `needs_input`, kind `budget_exceeded`). The human can raise the budget or abort.
- Parked time (`waiting_external`, `needs_input` after release) does **not** count toward `minutes`.
