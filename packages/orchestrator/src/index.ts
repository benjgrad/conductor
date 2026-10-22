import { health, type Health } from '@conductor/shared';

// Placeholder from M1-T01 (scaffold). Fastify server, pg and the outbox arrive in later M1 tasks.
export const PACKAGE_NAME = '@conductor/orchestrator';

// M1-T12 contracts (docs/design/10-contracts.md).
export * from './contracts.js';
export type * from './db/types.js';

export function orchestratorHealth(): Health {
  return health(PACKAGE_NAME);
}
