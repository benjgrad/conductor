import { API_PATHS, type TeamResponse } from '@conductor/shared';
import type { FastifyPluginAsync } from 'fastify';
import { listTeam } from '../agents/team.js';
import type { Db } from '../main.js';

// UX-13a: GET /api/team (10-contracts §Agent team). Signed in, like every /api/* route; the team
// is the signed-in account's only.

export interface TeamRoutesOptions {
  db: Db;
}

export const registerTeamRoutes: FastifyPluginAsync<TeamRoutesOptions> = (app, { db }) => {
  app.get(API_PATHS.team, async (req): Promise<TeamResponse> => {
    return listTeam(db, req.auth!.scope.account_id);
  });
  return Promise.resolve();
};
