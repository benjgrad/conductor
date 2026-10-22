import { health, type Health } from '@conductor/shared';

// Placeholder from M1-T01 (scaffold). WS client, worktrees and the Claude driver arrive in later M1 tasks.
export const PACKAGE_NAME = '@conductor/daemon';

// M1-T12 contracts (docs/design/10-contracts.md).
export type * from './claude/driver.js';
export * from './claude/fake-driver.js';
export type * from './commands/runner.js';
export * from './commands/fake-runner.js';
export { createCommandRunner } from './commands/index.js';
export * from './claude/index.js';

// M1-T05a daemon core.
export { Daemon, DAEMON_VERSION, type DaemonOptions } from './daemon.js';
export { loadConfig, type DaemonConfig, type PortPoolConfig } from './config.js';
export { PortPool, PortPoolExhaustedError, portEnv } from './ports.js';
export { DaemonStore } from './store.js';
export { Workspace, cloneSource, repoSlug } from './workspace.js';
export { buildAppendSystemPrompt, CONDUCTOR_INSTRUCTIONS } from './system-prompt.js';
export type { LiveResources, SysInfo } from './sysinfo.js';

export function daemonHealth(): Health {
  return health(PACKAGE_NAME);
}
