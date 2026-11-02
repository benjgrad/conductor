import { z } from 'zod';

// ADR-0029: which of the machine owner's MCP servers an agent gets. Conductor's own MCP server
// (outcome + permission tools) is always there; this decides the rest: the user, plugin and
// claude.ai connector servers the local Claude Code session has.

/**
 * `inherit` (the default): every MCP server and claude.ai connector the machine owner's Claude
 * Code has, minus `deny`. `none`: only conductor's (`--strict-mcp-config`,
 * `ENABLE_CLAUDEAI_MCP_SERVERS=false`), the pre-ADR-0029 behaviour; `deny` is ignored.
 * `deny` names servers as Claude Code lists them (`claude.ai Gmail`, `plugin:azure:azure`,
 * `chrome-devtools`); each becomes a `--disallowedTools mcp__<prefix>` rule (`mcpServerRule`).
 * TD-199: no allow-list (`only`) and no per-repo policy.
 */
export const McpPolicySchema = z.strictObject({
  mode: z.enum(['inherit', 'none']),
  deny: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
});
export type McpPolicy = z.infer<typeof McpPolicySchema>;

/** A workflow or state that says nothing. */
export const DEFAULT_MCP_POLICY: McpPolicy = { mode: 'inherit' };

/**
 * What a start_session without `mcp` means: only conductor's server. Old orchestrators, and the
 * requirements reviewer and QA sessions, which run in dontAsk and would be denied the tools anyway.
 */
export const NO_MCP_POLICY: McpPolicy = { mode: 'none' };

/** The state's `mcp`, else the workflow's, else `inherit` (a state replaces, never merges). */
export function resolveMcpPolicy(
  workflow: { mcp?: McpPolicy | undefined },
  state: { mcp?: McpPolicy | undefined },
): McpPolicy {
  return state.mcp ?? workflow.mcp ?? DEFAULT_MCP_POLICY;
}

/**
 * The permission rule naming every tool of one MCP server: Claude Code's tool prefix
 * `mcp__<server>`, where each character outside `[A-Za-z0-9_-]` becomes `_`
 * (`claude.ai Atlassian` → `mcp__claude_ai_Atlassian`, `plugin:azure:azure` →
 * `mcp__plugin_azure_azure`). A bare `mcp__<server>` rule matches all of that server's tools.
 */
export function mcpServerRule(server: string): string {
  return `mcp__${server.trim().replace(/[^A-Za-z0-9_-]/g, '_')}`;
}
