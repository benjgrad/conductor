# ADR-0029 · Agents inherit the machine owner's MCP servers

- **Status**: accepted (Ben, 2026-11-01; supersedes ADR-0006's "only conductor's MCP server" guard, 09 hard guard (3))
- **Date**: 2026-11-01
- **Deciders**: Ben (+ Claude session, background job "Eamon session stuck in queued")
- **Resolves**: —

## Context
The first conductor ticket on Ben's work machine (PC115, NCNG-2630 in `methodcrm/method-platform-ui`) asked the agent to "follow the local claude workflow, updating the jira ticket as we go". The agent said it had no Jira access. Ben's local Claude Code has the Atlassian claude.ai connector, the Method plugins and their skills, but conductor dropped every MCP server except its own: `--strict-mcp-config` (user, project and plugin servers) and `ENABLE_CLAUDEAI_MCP_SERVERS=false` (claude.ai connectors), ADR-0006 / [09](../design/09-security-and-budgets.md) hard guard (3). The skills loaded (`--setting-sources user`), but the tools they call were missing.

Ben, 2026-11-01, choosing between a per-machine allow-list, a per-workflow / per-repo setting and no change: *"I'd say 2, but it should default to allowing everything the local claude session has"*.

## Decision
1. **Default `inherit`.** A worker agent gets every MCP server and claude.ai connector the machine owner's Claude Code has, plus conductor's own (`--mcp-config`, unchanged). The daemon leaves out `--strict-mcp-config` and doesn't set `ENABLE_CLAUDEAI_MCP_SERVERS`.
2. **Per workflow, per state.** The workflow definition and each agent state take an optional `mcp: { mode: 'inherit' | 'none', deny?: string[] }`. A state's `mcp` replaces the workflow's, never merges with it; absent everywhere = `{ mode: 'inherit' }` (`resolveMcpPolicy`). `none` is the pre-ADR-0029 behaviour. `deny` names servers as Claude Code lists them (`claude.ai Gmail`, `plugin:azure:azure`, `chrome-devtools`). Each becomes a `--disallowedTools mcp__<prefix>` rule (`mcpServerRule`: every character outside `[A-Za-z0-9_-]` → `_`), which removes all of that server's tools in every permission mode.
3. **On the wire.** The engine puts the resolved policy on a worker's `start_session` effect, and `commandPayloadForEffect` copies it to `start_session.mcp`. **Absent = `none`**, so a start from an old orchestrator keeps the old guard. Requirements reviewers (ADR-0009) and QA states (ADR-0020) never carry it and always get `none`: they run in `dontAsk`, which would deny the tools anyway, and their job is to judge the worker's work.
4. **What still holds.** The edit-guard hook, deny rules, auto mode's classifier and permission prompts to the board (ADR-0023) apply to MCP tool calls as to any other. An MCP tool call that would prompt goes to the board.

## Consequences
- The agent can act through everything the owner connected: Jira, Slack, Gmail, Drive, Azure. A prompt injection in an untrusted repo can now reach those tools, limited only by auto mode's classifier and the board's prompts. A workflow that runs untrusted code should set `mcp: { mode: 'none' }` or deny the risky servers.
- An MCP server's own file or shell access (a filesystem server, chrome-devtools) is not confined by the edit-guard hook, which only sees Edit/Write/MultiEdit/NotebookEdit.
- `MCP_TOOL_TIMEOUT` (35 min, for a held permission prompt) now applies to the owner's servers too.
- The machine owner's servers start with every session. A server that needs auth shows as `needs-auth` and is skipped; one that hangs on start could delay the session (not observed).
- There is no allow-list (`mode: 'only'`): selecting by inclusion would mean reading and re-emitting the owner's server configs. Recorded as TD-199.
- Per repo is not separate: a repo gets its policy through the workflow it runs. Recorded as TD-199 too.
- The Rust daemon (MR-T09, `claude/cli_driver`) has to port `agentMcp`; the two new cli-driver test cases have `todo` rows in `PARITY.md`.

## Alternatives considered
- **A per-machine allow-list in the daemon config** (`mcp_allow`): off by default, so every machine needs setup, and the same machine can't treat a trusted and an untrusted repo differently.
- **No change, Jira through `ask_user`:** keeps the guard, but every external update needs Ben.
