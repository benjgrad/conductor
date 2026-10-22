# 09 · Security and budgets

## Threat model (v1, one org)
Agents run arbitrary code on developer machines with that developer's credentials. The goals are to limit the blast radius per state, keep shared-system writes in one audited place, and stop runaway spend.

## Controls
| Control | Mechanism | Slice |
|---|---|---|
| Per-state tool permissions | `tools` allow-list per agent state. The daemon maps it to an [ADR-0005](../adr/0005-claude-code-driver.md) `ToolPolicy`: `--tools` (visible built-ins) + `--allowedTools` rules + `--disallowedTools`, under `--permission-mode dontAsk --permission-prompts none` (anything not pre-approved is denied, without prompting). File tools are always path-scoped (`Edit(./**)`, `Write(./**)`), because a bare `Edit` escapes the worktree. Bash entries are prefix rules, and pushing stays denied for agents. The name → policy table is `TOOL_ALIASES` / `resolveToolPolicy` in `shared` ([10](10-contracts.md#tools)). `--setting-sources ""` + `--strict-mcp-config` keep user/repo settings, hooks and connectors out; the worktree's CLAUDE.md is passed via `appendSystemPrompt` ([U-013](../tracking/UNKNOWNS.md)). Path rules don't confine Bash ([U-004](../tracking/UNKNOWNS.md)) | 1 |
| Worktree confinement | Agent cwd is its worktree; the shared clone is never edited | 1 |
| Sandbox | Container per session where the machine supports it; worktree-only on macOS for now ([U-004](../tracking/UNKNOWNS.md)) | 3 |
| Connector secrets | Only in the orchestrator (env / secret store), never sent to daemons | 3 |
| Skill credentials | Machine-local (gh, Slack skill). Documented as a deliberate split ([01](01-architecture.md#credentials-split)) | 1 |
| Daemon enrollment | Per-machine token, revocable; TLS for the WS ([U-008](../tracking/UNKNOWNS.md)) | 2 |
| UI auth | TBD ([U-008](../tracking/UNKNOWNS.md)). M1 runs on localhost only | 2 |
| Audit | Every transition and connector call is an `event` row | 1 |

## Budgets
- Workflow-level: `budget.usd`, `budget.minutes`, `budget.max_loop_retries`.
- The daemon reports `spend` events from Claude Code's `result.total_cost_usd` ([ADR-0005](../adr/0005-claude-code-driver.md)). That total is **cumulative per Claude session and survives `--resume`**, so the orchestrator keeps the last total per `claude_session_id` (`session.claude_spend_totals`, [02](02-data-model.md#session)) and adds only the positive delta to `session.spend_usd`. It also accumulates `wall_seconds`: apply adds `now − state_entered_at` on each transition, skipping `human`/`event` states ([10](10-contracts.md#wall-time)).
- The daemon passes the remaining budget to Claude as `--max-budget-usd`, a hard backstop independent of the orchestrator.
- Exceeded → engine event `budget.exceeded` → `on_budget_exceeded` (default `needs_input`, kind `budget_exceeded`). The human can raise the budget or abort. **M1**: the routing exists in the engine, but nothing emits `budget.exceeded` yet (no enforcement trigger; [10](10-contracts.md)).
- Parked time (`waiting_external`, `needs_input` after release) does **not** count toward `minutes`.
