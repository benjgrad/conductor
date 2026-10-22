// `DriverStartOptions.appendSystemPrompt` (ADR-0005; U-013). The CLI runs with
// `--setting-sources ""`, so the repo's own CLAUDE.md is not loaded by Claude Code; the daemon
// reads the worktree's CLAUDE.md and appends it here instead. Repo hooks and permission rules
// are deliberately NOT loaded.

export const CONDUCTOR_INSTRUCTIONS = [
  'You are running unattended as a conductor session, inside a git worktree on your own branch.',
  'When the task for this step is finished, call the `complete_state` tool (conductor MCP server) once with a JSON `result` object, then stop.',
  'If you need a decision only a human can make, call the `ask_user` tool with one clear question and end your turn; the answer arrives as the next user message.',
  'Never push; later workflow steps do that.',
].join('\n');

export function buildAppendSystemPrompt(claudeMd: string | null): string {
  if (claudeMd === null || claudeMd.trim() === '') return CONDUCTOR_INSTRUCTIONS;
  return `${CONDUCTOR_INSTRUCTIONS}\n\n# Repository instructions (CLAUDE.md)\n\n${claudeMd}`;
}
