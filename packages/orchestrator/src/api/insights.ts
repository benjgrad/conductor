import { API_PATHS, InsightsQuerySchema } from '@conductor/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { proposalsForFindings } from '../advisor/proposals.js';
import {
  readFindings,
  readInsight,
  readProcessMetrics,
  readProcessReport,
} from '../advisor/read.js';
import type { Db } from '../main.js';
import { sendError } from './errors.js';

// UXR-84 (ADR-0033): the board's read-only view of the workflow advisor's data. Each route returns
// what its MCP tool returns (advisor/read.ts), scoped to the signed-in account; findings also carry
// the change proposal that cites them, so the Insights page can open it.

export interface InsightsRoutesOptions {
  db: Db;
}

const accountOf = (req: FastifyRequest) => req.auth!.scope.account_id;

function query(req: FastifyRequest, reply: FastifyReply) {
  const q = InsightsQuerySchema.safeParse(req.query ?? {});
  if (!q.success) {
    void sendError(reply, 400, 'bad_request', 'bad window_days, group_by, repo, workflow_id or cursor');
    return null;
  }
  return q.data;
}

export const registerInsightsRoutes: FastifyPluginAsync<InsightsRoutesOptions> = (app, { db }) => {
  app.get(API_PATHS.insightsMetrics, async (req, reply) => {
    const q = query(req, reply);
    if (q === null) return reply;
    return readProcessMetrics(db, accountOf(req), q);
  });

  app.get(API_PATHS.insightsFindings, async (req, reply) => {
    const q = query(req, reply);
    if (q === null) return reply;
    const page = await readFindings(db, accountOf(req), q);
    const linked = await proposalsForFindings(
      db,
      accountOf(req),
      page.findings.map((f) => f.id),
    );
    return {
      ...page,
      findings: page.findings.map((f) => ({ ...f, proposal: linked.get(f.id) ?? null })),
    };
  });

  app.get(API_PATHS.insightsReport, async (req, reply) => {
    const q = query(req, reply);
    if (q === null) return reply;
    return readProcessReport(db, accountOf(req), q);
  });

  app.get<{ Params: { id: string } }>(API_PATHS.insightSession(':id'), async (req, reply) => {
    const found = await readInsight(db, accountOf(req), req.params.id);
    if (found === null) return sendError(reply, 404, 'not_found', 'no insight for that session');
    return found;
  });
  return Promise.resolve();
};
