import {
  API_PATHS,
  AcceptProposalRequestSchema,
  DismissProposalRequestSchema,
} from '@conductor/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { BoardBus } from '../contracts.js';
import type { Db } from '../main.js';
import { acceptProposal, dismissProposal } from '../proposals/store.js';
import { parseBody, sendError } from './errors.js';

// ADR-0034: /api/proposals/:id/accept | dismiss, a human's decision on a follow-up ticket an
// agent proposed. Thin routes over proposals/store.ts (the MCP tool calls the same functions),
// always scoped to the caller's account.

export interface ProposalRoutesOptions {
  db: Db;
  boardBus: BoardBus;
  now: () => Date;
}

type IdParams = { Params: { id: string } };

export const registerProposalRoutes: FastifyPluginAsync<ProposalRoutesOptions> = (
  app,
  { db, boardBus, now },
) => {
  app.post<IdParams>(API_PATHS.proposalAccept(':id'), async (req, reply) => {
    const body = parseBody(AcceptProposalRequestSchema, req.body ?? {}, reply);
    if (!body) return reply;
    const res = await acceptProposal(
      { db, boardBus },
      req.auth!.scope,
      req.params.id,
      body,
      req.auth!.user.email,
      now(),
    );
    if (!res.ok) return sendError(reply, res.status, res.code, res.message);
    return reply.code(201).send({ proposal: res.proposal, ticket: res.ticket });
  });

  app.post<IdParams>(API_PATHS.proposalDismiss(':id'), async (req, reply) => {
    const body = parseBody(DismissProposalRequestSchema, req.body ?? {}, reply);
    if (!body) return reply;
    const res = await dismissProposal(
      db,
      req.auth!.scope,
      req.params.id,
      req.auth!.user.email,
      now(),
    );
    if (!res.ok) return sendError(reply, res.status, res.code, res.message);
    return res.proposal;
  });
  return Promise.resolve();
};
