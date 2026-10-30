import { API_PATHS, rankRepos, type RepoListResponse } from '@conductor/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { Queryable } from '../contracts.js';
import type { Db } from '../main.js';

// GET /api/repos (10-contracts §Repo suggestions): the create-ticket form's repo list. Signed in,
// like every /api/* route; only the signed-in account's tickets and machines count.

/** Older tickets than the newest this many add next to nothing to a score (half-life 14 days). */
const RECENT_TICKETS = 1000;

export async function listRepos(
  q: Queryable,
  accountId: string,
  now = new Date(),
): Promise<RepoListResponse> {
  const uses = await q.query<{ repo: string; created_at: Date }>(
    'SELECT repo, created_at FROM ticket WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2',
    [accountId, RECENT_TICKETS],
  );
  // A repo without an allowed remote is never routed to (02 §machine_repo), so not suggested.
  const known = await q.query<{ remote: string }>(
    'SELECT DISTINCT r.remote FROM machine_repo r JOIN machine m ON m.id = r.machine_id ' +
      'WHERE r.account_id = $1 AND m.revoked_at IS NULL AND r.remote IS NOT NULL',
    [accountId],
  );
  return rankRepos(
    uses.rows,
    known.rows.map((r) => r.remote),
    now,
  );
}

export interface RepoRoutesOptions {
  db: Db;
}

export const registerRepoRoutes: FastifyPluginAsync<RepoRoutesOptions> = (app, { db }) => {
  app.get(API_PATHS.repos, async (req): Promise<RepoListResponse> => {
    return listRepos(db, req.auth!.scope.account_id);
  });
  return Promise.resolve();
};
