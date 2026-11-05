import {
  API_PATHS,
  ListChangeProposalsQuerySchema,
  type ApiErrorCode,
  type ChangeProposalDetail,
} from '@conductor/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  applyProposal,
  getProposal,
  listProposals,
  proposalBodies,
  rejectProposal,
  reviewProposal,
  type ProposalActor,
  type ProposalFailure,
} from '../advisor/proposals.js';
import type { Db } from '../main.js';
import { parseBody, sendError } from './errors.js';

// ADR-0033 P3 (MA-T05/T07): the board's side of the workflow advisor's change proposals. The
// advisor proposes over MCP (propose_change); a human reads the diff here and applies or rejects
// it. Applying runs the same guards as apply_change (advisor/proposals.ts): the workflow admin
// gate, the approvals guard (model-written changes never weaken approvals, on either path) and the
// base the proposal was made from.

export interface ChangeProposalRoutesOptions {
  db: Db;
}

type IdParams = { Params: { id: string } };

const EmptyBodySchema = z.object({}).strict();

const HTTP: Record<ProposalFailure['code'], [number, ApiErrorCode]> = {
  invalid_input: [400, 'bad_request'],
  invalid_workflow: [400, 'invalid_workflow'],
  no_change: [400, 'bad_request'],
  too_many_open: [409, 'conflict'],
  not_found: [404, 'not_found'],
  forbidden: [403, 'forbidden'],
  conflict: [409, 'conflict'],
  approval_weakened: [409, 'approval_weakened'],
  already_applied: [409, 'wrong_state'],
  wrong_state: [409, 'wrong_state'],
  failed: [500, 'internal'],
};

const sendFailure = (reply: FastifyReply, f: ProposalFailure) => {
  const [status, code] = HTTP[f.code];
  return sendError(reply, status, code, f.message, f.details);
};

const actorOf = (req: FastifyRequest): ProposalActor => ({
  accountId: req.auth!.scope.account_id,
  by: req.auth!.user.email,
  mayEditWorkflows: req.auth!.mode === 'local' || req.auth!.user.is_admin,
});

export const registerChangeProposalRoutes: FastifyPluginAsync<ChangeProposalRoutesOptions> = (
  app,
  { db },
) => {
  /** UXR-73: the board reads a proposal's whole change for its readable diff. */
  const withBodies = async (req: FastifyRequest, p: ChangeProposalDetail) => ({
    ...p,
    ...(await proposalBodies(db, req.auth!.scope.account_id, p.id)),
  });

  app.get(API_PATHS.changeProposals, async (req, reply) => {
    const q = ListChangeProposalsQuerySchema.safeParse(req.query ?? {});
    if (!q.success)
      return sendError(reply, 400, 'bad_request', 'bad status, cursor, kind or target');
    return listProposals(db, req.auth!.scope.account_id, q.data);
  });

  app.get<IdParams>(API_PATHS.changeProposal(':id'), async (req, reply) => {
    const found = await getProposal(db, req.auth!.scope.account_id, req.params.id);
    if (found === null) return sendError(reply, 404, 'not_found', 'no such change proposal');
    return withBodies(req, found);
  });

  app.post<IdParams>(API_PATHS.changeProposalApply(':id'), async (req, reply) => {
    if (!parseBody(EmptyBodySchema, req.body, reply)) return reply;
    const res = await applyProposal(db, actorOf(req), req.params.id);
    return res.ok ? withBodies(req, res.value) : sendFailure(reply, res);
  });

  app.post<IdParams>(API_PATHS.changeProposalReject(':id'), async (req, reply) => {
    if (!parseBody(EmptyBodySchema, req.body, reply)) return reply;
    const res = await rejectProposal(db, actorOf(req), req.params.id);
    return res.ok ? withBodies(req, res.value) : sendFailure(reply, res);
  });

  app.post<IdParams>(API_PATHS.changeProposalReview(':id'), async (req, reply) => {
    if (!parseBody(EmptyBodySchema, req.body, reply)) return reply;
    const res = await reviewProposal(db, req.auth!.scope.account_id, req.params.id);
    return res.ok ? withBodies(req, res.value) : sendFailure(reply, res);
  });
  return Promise.resolve();
};
