import { safeNextPath } from '@conductor/shared';

/**
 * Where to go after signing in: an SPA path (`goTo`), or a server page that needs a real load.
 * ADR-0028: `/oauth/authorize` (an MCP client's consent page) is served by the orchestrator.
 */
export function afterSignIn(next: string | null): { path: string; reload: boolean } {
  const path = safeNextPath(next);
  return { path, reload: path.startsWith('/oauth/') };
}
