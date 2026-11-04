import {
  API_PATHS,
  CONDUCTOR_V4_DEF,
  CONDUCTOR_WORKFLOW_ID,
  DeleteRepoChecksRequestSchema,
  PutRepoChecksRequestSchema,
  RepoChecksSchema,
  WorkflowDefinitionSchema,
  checksGatesOf,
  repoChecksKey,
  type RepoChecks,
  type RepoChecksDetail,
  type RepoChecksDto,
  type RepoChecksListResponse,
  type WorkflowDefinition,
} from '@conductor/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { Queryable } from '../contracts.js';
import type { RepoChecksRow } from '../db/types.js';
import type { Db } from '../main.js';
import { parseBody, pathString, sendError, type ErrorDetail } from './errors.js';

// ADR-0030: per-repo check overrides. One set of functions behind both the REST routes
// (/api/repo-checks) and the MCP tools (list/get/set/clear_repo_checks), always scoped to the
// caller's account. The engine reads the override with the session (`readRepoChecks`).

function toDto(row: RepoChecksRow): RepoChecksDto | null {
  const parsed = RepoChecksSchema.safeParse(row.config);
  if (!parsed.success) return null;
  return {
    repo: row.repo,
    setup: parsed.data.setup ?? null,
    checks: parsed.data.checks,
    updated_at: row.updated_at.toISOString(),
    updated_by: row.updated_by,
  };
}

export async function listRepoChecks(
  q: Queryable,
  accountId: string,
): Promise<RepoChecksListResponse> {
  const r = await q.query<RepoChecksRow>(
    'SELECT * FROM repo_checks WHERE account_id = $1 ORDER BY repo',
    [accountId],
  );
  return { repos: r.rows.flatMap((row) => toDto(row) ?? []) };
}

/** The latest `conductor` definition; the newest shipped one when none is stored (a bare DB). */
async function latestConductor(q: Queryable): Promise<WorkflowDefinition> {
  const r = await q.query<{ definition: unknown }>(
    'SELECT definition FROM workflow_definition WHERE id = $1 ORDER BY version DESC LIMIT 1',
    [CONDUCTOR_WORKFLOW_ID],
  );
  const parsed = WorkflowDefinitionSchema.safeParse(r.rows[0]?.definition);
  return parsed.success ? parsed.data : CONDUCTOR_V4_DEF;
}

/** The repo's override (null = none) and what runs at each checking gate of `conductor`. */
export async function getRepoChecks(
  q: Queryable,
  accountId: string,
  repo: string,
): Promise<RepoChecksDetail> {
  const key = repoChecksKey(repo);
  const r = await q.query<RepoChecksRow>(
    'SELECT * FROM repo_checks WHERE account_id = $1 AND repo = $2',
    [accountId, key],
  );
  const override = r.rows[0] ? toDto(r.rows[0]) : null;
  const gates = checksGatesOf(await latestConductor(q));
  return {
    repo: key,
    override,
    effective: gates.map((g) =>
      override !== null
        ? { at: g.at, source: 'override', setup: override.setup, checks: override.checks }
        : { at: g.at, source: 'workflow', setup: g.setup, checks: [...g.checks] },
    ),
  };
}

export type SetRepoChecksResult =
  { ok: true; dto: RepoChecksDto } | { ok: false; message: string; details: ErrorDetail[] };

/** Validate and upsert the repo's override. `by` is recorded as `updated_by`. */
export async function setRepoChecks(
  q: Queryable,
  accountId: string,
  input: unknown,
  by: string | null,
): Promise<SetRepoChecksResult> {
  const req = PutRepoChecksRequestSchema.safeParse(input);
  const fail = (issues: { path: PropertyKey[]; message: string }[]): SetRepoChecksResult => ({
    ok: false,
    message: 'invalid repo checks',
    details: issues.map((i) => ({ path: pathString(i.path), message: i.message })),
  });
  if (!req.success) return fail(req.error.issues);
  const config: RepoChecks = {
    ...(req.data.setup !== undefined ? { setup: req.data.setup } : {}),
    checks: req.data.checks,
  };
  const checked = RepoChecksSchema.safeParse(config);
  if (!checked.success) return fail(checked.error.issues);
  const r = await q.query<RepoChecksRow>(
    'INSERT INTO repo_checks (account_id, repo, config, updated_at, updated_by) ' +
      'VALUES ($1, $2, $3, now(), $4) ON CONFLICT (account_id, repo) DO UPDATE SET ' +
      'config = EXCLUDED.config, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by ' +
      'RETURNING *',
    [accountId, repoChecksKey(req.data.repo), JSON.stringify(checked.data), by],
  );
  return { ok: true, dto: toDto(r.rows[0]!)! };
}

/** Delete the repo's override; true when there was one. */
export async function clearRepoChecks(
  q: Queryable,
  accountId: string,
  repo: string,
): Promise<boolean> {
  const r = await q.query('DELETE FROM repo_checks WHERE account_id = $1 AND repo = $2', [
    accountId,
    repoChecksKey(repo),
  ]);
  return (r.rowCount ?? 0) > 0;
}

export interface RepoChecksRoutesOptions {
  db: Db;
}

type RepoQuery = { Querystring: { repo?: string } };

export const registerRepoChecksRoutes: FastifyPluginAsync<RepoChecksRoutesOptions> = (
  app,
  { db },
) => {
  const repoOf = (raw: string | undefined): string | null => {
    const repo = raw?.trim() ?? '';
    return repo === '' || repo.length > 200 ? null : repo;
  };

  app.get<RepoQuery>(API_PATHS.repoChecks, async (req, reply) => {
    const accountId = req.auth!.scope.account_id;
    if (req.query.repo === undefined) return listRepoChecks(db, accountId);
    const repo = repoOf(req.query.repo);
    if (repo === null) return sendError(reply, 400, 'bad_request', 'repo must be 1..200 chars');
    return getRepoChecks(db, accountId, repo);
  });

  app.put(API_PATHS.repoChecks, async (req, reply) => {
    const body = parseBody(PutRepoChecksRequestSchema, req.body, reply);
    if (!body) return reply;
    const res = await setRepoChecks(db, req.auth!.scope.account_id, body, req.auth!.user.email);
    if (!res.ok) return sendError(reply, 400, 'bad_request', res.message, res.details);
    return res.dto;
  });

  // A JSON body like every unsafe request (the security hook 415s anything else).
  app.delete(API_PATHS.repoChecks, async (req, reply) => {
    const body = parseBody(DeleteRepoChecksRequestSchema, req.body, reply);
    if (!body) return reply;
    if (!(await clearRepoChecks(db, req.auth!.scope.account_id, body.repo))) {
      return sendError(reply, 404, 'not_found', `no repo checks for ${repoChecksKey(body.repo)}`);
    }
    return { ok: true };
  });
  return Promise.resolve();
};
