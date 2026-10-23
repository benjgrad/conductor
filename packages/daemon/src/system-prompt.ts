// `DriverStartOptions.appendSystemPrompt` (ADR-0005; U-013). Since ADR-0006 the CLI loads the
// user and project setting sources, so Claude Code reads the worktree's CLAUDE.md itself; the
// daemon appends only its own instructions.

export const CONDUCTOR_INSTRUCTIONS = [
  'You are running unattended as a conductor session, inside a git worktree on your own branch.',
  'When the task for this step is finished, call the `complete_state` tool (conductor MCP server) once with a JSON `result` object, then stop.',
  'If you need a decision only a human can make, call the `ask_user` tool with one clear question and end your turn; the answer arrives as the next user message.',
  'Never push; later workflow steps do that.',
].join('\n');
