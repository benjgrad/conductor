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

## M1 local hardening
M1 has no auth (U-008), so these controls (M1-T14) keep a localhost install from being driven by a web page or a hostile repo:

- **API** (`packages/orchestrator/src/api/security.ts`, a Fastify `onRequest` hook): **403** unless `Host` is loopback (`localhost`, `127.0.0.0/8`, `::1`) or listed in `CONDUCTOR_ALLOWED_HOSTS` (defeats DNS rebinding); **403** for a POST/PUT/PATCH/DELETE whose `Origin` is present and not allowed. Always allowed: same-origin (Origin host = Host), `http://{localhost,127.0.0.1}:<CONDUCTOR_PORT>`, the Vite dev/preview origins (`:5173`, `:4173`), plus `CONDUCTOR_ALLOWED_ORIGINS`. **415** for a POST without `content-type: application/json`, so no "simple" cross-site form post gets through. Bodies keep the frozen `ApiError` shape (`code: bad_request`, the status says which). The static web app files served before Fastify are not checked (public, read-only).
- **Daemon WS upgrade**: refused (403) when it carries an `Origin` that isn't allowed by the same rules. Browsers always send `Origin`; the daemon's `ws` client never does. Daemon authentication waits for enrollment tokens (U-008).
- **Gateway authorization**: `session_event` (including `build_slot` badges and lease heartbeats) and `command_ack` refusals are applied only for a session whose `machine_id` is the connection's machine (else `unknown_session`), and a `session_event` needs `fencing_token` **equal** to the session's current token (lower or higher → kill under the event's token). `output` is accepted only for a session the connection owns under that token: a per-connection map filled from its work claims, DB-verified heartbeat leases and accepted session events, and pruned to what each heartbeat confirms.
- **Daemon**: the per-session MCP URL token is never on the `claude` argv: `--mcp-config` gets a path to a 0600 file in a fresh 0700 temp dir, deleted when the process exits. `ticket.repo` must be canonical `host/org/repo`, `https://host/org/repo` or `user@host:org/repo`; absolute paths and `file://` need `CONDUCTOR_ALLOW_LOCAL_REPOS=1` (default off; tests/E2E set it), other schemes/transports (`ext::`, `git://`, `http://`) and `.`/`..` segments are refused, and `CONDUCTOR_ALLOWED_REPO_HOSTS` (optional) limits hosts. The worktree's `CLAUDE.md` is read only if `lstat` says it is a regular file (not a symlink), its realpath is inside the worktree, and it is ≤ 64 KB; otherwise it is skipped and logged.
