import { health, type Health } from '@conductor/shared';

// Placeholder from M1-T01 (scaffold). Fastify server, pg and the outbox arrive in later M1 tasks.
export const PACKAGE_NAME = '@conductor/orchestrator';

export function orchestratorHealth(): Health {
  return health(PACKAGE_NAME);
}
