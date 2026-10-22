// M1-T05b: the real Claude Code driver (ADR-0005) and the daemon-hosted MCP outcome server.
export {
  CLAUDE_BIN_ENV,
  DEFAULT_END_GRACE_MS,
  DEFAULT_KILL_GRACE_MS,
  buildClaudeArgs,
  createCliDriver,
  userMessageLine,
  type CliDriver,
  type CliDriverOptions,
  type CliDriverSession,
} from './cli-driver.js';
export {
  ASK_USER_RETURN,
  ASK_USER_TOOL,
  COMPLETE_STATE_RETURN,
  COMPLETE_STATE_TOOL,
  OUTCOME_SERVER_NAME,
  OUTCOME_TOOL_NAMES,
  startOutcomeServer,
  type OutcomeHandlers,
  type OutcomeRegistration,
  type OutcomeServer,
  type OutcomeServerOptions,
} from './outcome-server.js';
