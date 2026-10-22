import { health, type Health } from '@conductor/shared';

// Placeholder from M1-T01 (scaffold). WS client, worktrees and the Claude driver arrive in later M1 tasks.
export const PACKAGE_NAME = '@conductor/daemon';

export function daemonHealth(): Health {
  return health(PACKAGE_NAME);
}
