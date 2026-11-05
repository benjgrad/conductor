import {
  approvalsWeakened,
  capDiff,
  compareMetrics,
  diffRepoChecks,
  diffWorkflow,
  ExpectedEffectSchema,
  OPEN_PROPOSALS_MAX,
  ProposalChangeSchema,
  ProposeChangeInputSchema,
  RepoChecksSchema,
  repoChecksKey,
  reviewWindowDays,
  stableJson,
  validateWorkflow,
  WORKFLOW_CHANGE_WARNING,
  WORKFLOW_NOTE_MAX,
  WorkflowDefinitionSchema,
  type ChangeKind,
  type ChangeProposalDetail,
  type ChangeProposalListResponse,
  type ChangeProposalSummary,
  type ChangeStatus,
  type EvidenceItem,
  type ExpectedEffect,
  type ProposalChange,
  type ProposalReview,
  type RepoChecks,
  type StructuralChange,
  type WorkflowValidationError,
} from '@conductor/shared';
import type { Queryable } from '../contracts.js';
import { withTransaction, type Tx } from '../db/index.js';
import type { ChangeProposalRow, RepoChecksRow } from '../db/types.js';
import type { Db } from '../main.js';
import { clearRepoChecks, setRepoChecks } from '../api/repo-checks.js';
import { insertWorkflowVersion, latestWorkflow, weakenedApprovals } from '../api/workflows.js';
import { pathString } from '../api/errors.js';
import { TRUNCATED } from '../mcp/cap.js';
import { loadAdvisorRows } from './queries.js';

// ADR-0033 P3 (MA-T05): the change-proposal store. One set of functions behind the MCP tools
// (propose_change; list_change_proposals, which reviews an applied one; apply_change) and the REST
// routes (/api/change-proposals), always scoped to the caller's account. Applying runs the same
// guarded save paths as save_workflow / set_repo_checks, in one transaction with the proposal row
// locked, so a proposal is applied at most once. Nothing here retries: every refusal goes back to
// the human (the status and `error` show on the board).

/** save_workflow / propose_change: the largest definition accepted, as JSON. */
export const WORKFLOW_MAX_BYTES = 256 * 1024;
/** list_change_proposals: proposals per page. */
export const PROPOSALS_PAGE = 10;

/** What a caller may do: its account, its name for `created_by`, and the workflow admin gate. */
export interface ProposalActor {
  accountId: string;
  /** `mcp:<email>` over MCP, the email on the board. */
  by: string | null;
  /** ADR-0030 §Amendment: an instance admin (or local mode) may change workflows. */
  mayEditWorkflows: boolean;
}

export type ProposalErrorCode =
  | 'invalid_input'
  | 'invalid_workflow'
  | 'not_found'
  | 'conflict'
  | 'approval_weakened'
  | 'no_change'
  | 'too_many_open'
  | 'forbidden'
  | 'already_applied'
  | 'wrong_state'
  | 'failed';

export interface ProposalFailure {
  ok: false;
  code: ProposalErrorCode;
  message: string;
  details?: { path: string; message: string }[];
  /** conflict on a workflow: the latest version. */
  latest?: number | null;
  /** approval_weakened: the `state.transition` names. */
  transitions?: string[];
}
export type ProposalResult<T> = { ok: true; value: T } | ProposalFailure;

const failure = (
  code: ProposalErrorCode,
  message: string,
  extra: Omit<ProposalFailure, 'ok' | 'code' | 'message'> = {},
): ProposalFailure => ({ ok: false, code, message, ...extra });

/**
 * save_workflow's and propose_change's checks on a raw definition before it is validated: the
 * size cap, and a result that was cut short by the MCP cap and must never be saved back.
 */
export function workflowJsonProblem(definition: unknown): string | null {
  const json = JSON.stringify(definition);
  if (Buffer.byteLength(json, 'utf8') > WORKFLOW_MAX_BYTES) {
    return `The definition is over ${WORKFLOW_MAX_BYTES} bytes.`;
  }
  if (json.includes(TRUNCATED)) {
    return (
      `The definition contains "${TRUNCATED}": a tool result was cut short. Read that part ` +
      'again (get_workflow with `state`) before saving.'
    );
  }
  return null;
}

/** The validator's errors as `details` (the first 20). */
const workflowDetails = (errors: readonly WorkflowValidationError[]) =>
  errors.slice(0, 20).map((e) => ({ path: pathString(e.path), message: e.message }));

// ---------------------------------------------------------------- DTOs

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

function targetOf(row: ChangeProposalRow): string {
  const p = row.payload as { repo?: string; workflow_id?: string };
  return p.repo ?? p.workflow_id ?? '';
}

export function toSummary(row: ChangeProposalRow): ChangeProposalSummary {
  const effect = row.expected_effect as { text?: string };
  return {
    id: row.id,
    kind: row.kind as ChangeKind,
    status: row.status as ChangeStatus,
    title: row.title,
    target: targetOf(row),
    requires_admin: row.kind === 'workflow',
    changes: row.diff.length,
    expected_effect: effect.text ?? '',
    created_at: row.created_at.toISOString(),
    applied_at: iso(row.applied_at),
  };
}

export function toDetail(row: ChangeProposalRow): ChangeProposalDetail {
  const base = row.base as { version?: number };
  return {
    ...toSummary(row),
    rationale: row.rationale,
    evidence: row.evidence as EvidenceItem[],
    effect: row.expected_effect as ExpectedEffect,
    rollback: row.rollback,
    diff: capDiff(row.diff as StructuralChange[]),
    base_version: row.kind === 'workflow' ? (base.version ?? null) : null,
    created_by: row.created_by,
    decided_by: row.decided_by,
    decided_at: iso(row.decided_at),
    applied_version: row.applied_version,
    error: row.error,
    review: row.review as ProposalReview | null,
    warning: row.kind === 'workflow' ? WORKFLOW_CHANGE_WARNING : null,
  };
}

// ---------------------------------------------------------------- propose

type RepoChecksNow = Pick<RepoChecksRow, 'config' | 'updated_at'> | null;

async function repoChecksNow(
  q: Queryable,
  accountId: string,
  repo: string,
  lock = false,
): Promise<RepoChecksNow> {
  const r = await q.query<Pick<RepoChecksRow, 'config' | 'updated_at'>>(
    `SELECT config, updated_at FROM repo_checks WHERE account_id = $1 AND repo = $2${
      lock ? ' FOR UPDATE' : ''
    }`,
    [accountId, repo],
  );
  return r.rows[0] ?? null;
}

const parsedChecks = (row: RepoChecksNow): RepoChecks | null => {
  const parsed = RepoChecksSchema.safeParse(row?.config);
  return parsed.success ? parsed.data : null;
};

/** The repo-checks base snapshot, as stored in `base` and compared on apply. */
const repoBase = (row: RepoChecksNow) => ({
  config: row?.config ?? null,
  updated_at: iso(row?.updated_at ?? null),
});

interface Prepared {
  change: ProposalChange;
  base: Record<string, unknown>;
  diff: StructuralChange[];
}

async function prepare(
  q: Queryable,
  accountId: string,
  change: ProposalChange,
): Promise<ProposalResult<Prepared>> {
  if (change.kind === 'repo_checks') {
    const repo = repoChecksKey(change.repo);
    const now = await repoChecksNow(q, accountId, repo);
    return {
      ok: true,
      value: {
        change: { ...change, repo },
        base: repoBase(now),
        diff: diffRepoChecks(parsedChecks(now), change.checks),
      },
    };
  }
  const problem = workflowJsonProblem(change.definition);
  if (problem !== null) return failure('invalid_input', problem);
  const checked = validateWorkflow(change.definition);
  if (!checked.ok) {
    return failure('invalid_workflow', 'workflow definition is invalid', {
      details: workflowDetails(checked.errors),
    });
  }
  if (checked.def.id !== change.workflow_id) {
    return failure(
      'invalid_input',
      `definition.id is ${checked.def.id}, not the workflow_id ${change.workflow_id}.`,
    );
  }
  const latest = await latestWorkflow(q, change.workflow_id);
  if (latest === null) return failure('not_found', `No workflow ${change.workflow_id}.`);
  if (latest.version !== change.base_version) {
    return failure(
      'conflict',
      `${change.workflow_id} is at version ${latest.version}, not ${change.base_version}: read it ` +
        'again with get_workflow.',
      { latest: latest.version },
    );
  }
  const weakened = latest.def ? approvalsWeakened(latest.def, checked.def) : [];
  if (weakened.length > 0) {
    return failure(
      'approval_weakened',
      `This would remove or bypass a human approval (${weakened.join(', ')}); approvals are ` +
        'changed on the board.',
      { transitions: weakened },
    );
  }
  return {
    ok: true,
    value: {
      change: { ...change, definition: checked.def as unknown as Record<string, unknown> },
      base: { version: latest.version },
      diff: diffWorkflow(latest.def ?? {}, checked.def),
    },
  };
}

/** Validate a proposal, diff it against what it would change, and store it as `proposed`. */
export async function createProposal(
  q: Queryable,
  actor: ProposalActor,
  input: unknown,
): Promise<ProposalResult<ChangeProposalDetail>> {
  const parsed = ProposeChangeInputSchema.safeParse(input);
  if (!parsed.success) {
    return failure('invalid_input', 'invalid proposal', {
      details: parsed.error.issues.map((i) => ({ path: pathString(i.path), message: i.message })),
    });
  }
  const open = await q.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM change_proposal WHERE account_id = $1 AND status = 'proposed'",
    [actor.accountId],
  );
  // A soft cap (count, then insert): two racing proposals may both land, which is harmless.
  if ((open.rows[0]?.n ?? 0) >= OPEN_PROPOSALS_MAX) {
    return failure(
      'too_many_open',
      `${OPEN_PROPOSALS_MAX} proposals are already open: apply or reject some first ` +
        '(list_change_proposals).',
    );
  }
  const prepared = await prepare(q, actor.accountId, parsed.data.change);
  if (!prepared.ok) return prepared;
  const { change, base, diff } = prepared.value;
  if (diff.length === 0) {
    return failure('no_change', 'The change is the same as what is there now.');
  }
  const m = parsed.data;
  const r = await q.query<ChangeProposalRow>(
    'INSERT INTO change_proposal (account_id, kind, title, payload, base, diff, rationale, ' +
      'evidence, expected_effect, rollback, created_by) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *',
    [
      actor.accountId,
      change.kind,
      m.title,
      JSON.stringify(change),
      JSON.stringify(base),
      JSON.stringify(diff),
      m.rationale,
      JSON.stringify(m.evidence),
      JSON.stringify(m.expected_effect),
      m.rollback,
      actor.by,
    ],
  );
  return { ok: true, value: toDetail(r.rows[0]!) };
}

// ---------------------------------------------------------------- read

export async function listProposals(
  q: Queryable,
  accountId: string,
  opts: {
    status?: ChangeStatus | 'all' | undefined;
    cursor?: number | undefined;
    /** UXR-73: only this kind, and only this target (a repo or a workflow id). */
    kind?: ChangeKind | undefined;
    target?: string | undefined;
  } = {},
): Promise<ChangeProposalListResponse> {
  const status = opts.status === undefined || opts.status === 'all' ? null : opts.status;
  const cursor = Math.max(0, opts.cursor ?? 0);
  const kind = opts.kind ?? null;
  // A repo target is stored normalised (`prepare`), a workflow id as is: match either form.
  const target = opts.target === undefined ? null : [opts.target, repoChecksKey(opts.target)];
  const where =
    'WHERE account_id = $1 AND ($2::text IS NULL OR status = $2) ' +
    'AND ($3::text IS NULL OR kind = $3) ' +
    "AND ($4::text[] IS NULL OR coalesce(payload->>'repo', payload->>'workflow_id') = ANY($4))";
  const [rows, total] = await Promise.all([
    q.query<ChangeProposalRow>(
      `SELECT * FROM change_proposal ${where} ORDER BY created_at DESC, id OFFSET $5 LIMIT $6`,
      [accountId, status, kind, target, cursor, PROPOSALS_PAGE],
    ),
    q.query<{ n: number }>(`SELECT count(*)::int AS n FROM change_proposal ${where}`, [
      accountId,
      status,
      kind,
      target,
    ]),
  ]);
  const n = total.rows[0]?.n ?? 0;
  const end = cursor + rows.rows.length;
  return {
    proposals: rows.rows.map(toSummary),
    next_cursor: end < n ? end : null,
    total: n,
  };
}

/**
 * UXR-84: for each finding id, the account's change proposal whose evidence cites it: an open one
 * first, else the newest. Findings with none are absent from the map.
 */
export async function proposalsForFindings(
  q: Queryable,
  accountId: string,
  findingIds: readonly string[],
): Promise<Map<string, { id: string; status: ChangeStatus; title: string }>> {
  const out = new Map<string, { id: string; status: ChangeStatus; title: string }>();
  if (findingIds.length === 0) return out;
  const r = await q.query<{ finding_id: string; id: string; status: ChangeStatus; title: string }>(
    `SELECT DISTINCT ON (e->>'finding_id') e->>'finding_id' AS finding_id, p.id, p.status, p.title
       FROM change_proposal p, jsonb_array_elements(p.evidence) e
      WHERE p.account_id = $1 AND e->>'finding_id' = ANY ($2::text[])
      ORDER BY e->>'finding_id', (p.status = 'proposed') DESC, p.created_at DESC, p.id`,
    [accountId, [...findingIds]],
  );
  for (const row of r.rows) {
    out.set(row.finding_id, { id: row.id, status: row.status, title: row.title });
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadRow(
  q: Queryable,
  accountId: string,
  id: string,
  lock = false,
): Promise<ChangeProposalRow | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await q.query<ChangeProposalRow>(
    `SELECT * FROM change_proposal WHERE id = $1 AND account_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [id, accountId],
  );
  return r.rows[0] ?? null;
}

export async function getProposal(
  q: Queryable,
  accountId: string,
  id: string,
): Promise<ChangeProposalDetail | null> {
  const row = await loadRow(q, accountId, id);
  return row === null ? null : toDetail(row);
}

/**
 * UXR-73: a proposal's whole change, for the board's readable diff (the REST routes add it to the
 * detail; MCP results leave it out to stay small). Workflow: the definition it was based on and
 * the proposed one; repo checks: the override before (null = the workflow's checks) and after.
 */
export async function proposalBodies(
  q: Queryable,
  accountId: string,
  id: string,
): Promise<
  Pick<
    ChangeProposalDetail,
    'base_definition' | 'proposed_definition' | 'checks_before' | 'checks_after'
  >
> {
  const row = await loadRow(q, accountId, id);
  if (row === null) return {};
  const change = ProposalChangeSchema.safeParse(row.payload);
  if (!change.success) return {};
  if (change.data.kind === 'repo_checks') {
    const base = row.base as { config?: unknown };
    const before = RepoChecksSchema.safeParse(base.config);
    return {
      checks_before: before.success ? before.data : null,
      checks_after: change.data.checks,
    };
  }
  const proposed = WorkflowDefinitionSchema.safeParse(change.data.definition);
  const stored = await q.query<{ definition: unknown }>(
    'SELECT definition FROM workflow_definition WHERE id = $1 AND version = $2',
    [change.data.workflow_id, change.data.base_version],
  );
  const base = WorkflowDefinitionSchema.safeParse(stored.rows[0]?.definition);
  return {
    base_definition: base.success ? base.data : null,
    proposed_definition: proposed.success ? proposed.data : null,
  };
}

const notFound = (id: string) =>
  failure('not_found', `No change proposal ${id} in this account. Try list_change_proposals.`);

const notProposed = (row: ChangeProposalRow) =>
  row.status === 'applied'
    ? failure('already_applied', `The proposal was already applied (${iso(row.applied_at)}).`)
    : failure('wrong_state', `The proposal is ${row.status}, not proposed.`);

// ---------------------------------------------------------------- apply / reject

type Decided = Partial<Pick<ChangeProposalRow, 'applied_version' | 'error'>>;

async function decide(
  tx: Tx,
  row: ChangeProposalRow,
  status: ChangeStatus,
  by: string | null,
  extra: Decided = {},
): Promise<ChangeProposalRow> {
  const r = await tx.query<ChangeProposalRow>(
    'UPDATE change_proposal SET status = $2, decided_by = $3, decided_at = now(), ' +
      "applied_at = CASE WHEN $2 = 'applied' THEN now() ELSE applied_at END, " +
      'applied_version = $4, error = $5 WHERE id = $1 RETURNING *',
    [row.id, status, by, extra.applied_version ?? null, extra.error ?? null],
  );
  return r.rows[0]!;
}

type ApplyOutcome =
  { ok: true; value: ChangeProposalDetail } | (ProposalFailure & { row?: ChangeProposalRow });

async function applyLocked(tx: Tx, actor: ProposalActor, id: string): Promise<ApplyOutcome> {
  const row = await loadRow(tx, actor.accountId, id, true);
  if (row === null) return notFound(id);
  if (row.status !== 'proposed') return notProposed(row);
  const change = ProposalChangeSchema.safeParse(row.payload);
  if (!change.success) {
    const err = 'The stored change no longer parses.';
    await decide(tx, row, 'failed', actor.by, { error: err });
    return failure('failed', err);
  }
  const conflict = async (
    message: string,
    extra: Omit<ProposalFailure, 'ok' | 'code' | 'message'> = {},
    code: ProposalErrorCode = 'conflict',
  ) => {
    await decide(tx, row, 'conflict', actor.by, { error: message });
    return failure(code, message, extra);
  };

  if (change.data.kind === 'workflow') {
    if (!actor.mayEditWorkflows) {
      return failure(
        'forbidden',
        'Workflows are shared by every account on this instance: only an instance admin can ' +
          'apply a workflow change.',
      );
    }
    const checked = validateWorkflow(change.data.definition);
    if (!checked.ok) {
      const err = 'The stored definition is no longer valid.';
      await decide(tx, row, 'failed', actor.by, { error: err });
      return failure('invalid_workflow', err, { details: workflowDetails(checked.errors) });
    }
    const weakened = await weakenedApprovals(tx, checked.def);
    if (weakened.length > 0) {
      return conflict(
        `Applying it now would remove or bypass a human approval (${weakened.join(', ')}).`,
        { transitions: weakened },
        'approval_weakened',
      );
    }
    const res = await insertWorkflowVersion(tx, checked.def, {
      createdBy: actor.by,
      baseVersion: change.data.base_version,
      // UXR-70: the version history says where the version came from.
      note: `Applied proposal: ${row.title}`.slice(0, WORKFLOW_NOTE_MAX),
      accountId: actor.accountId,
    });
    if (!res.ok && res.code === 'conflict') {
      return conflict(
        `${checked.def.id} changed since version ${change.data.base_version} (now ` +
          `${res.latest}): propose the change again from the latest version.`,
        { latest: res.latest },
      );
    }
    if (!res.ok) {
      // UXR-67 rule 18: a column it drops still has tickets. Applying may work once they move on.
      const err = `The workflow definition is invalid: ${res.errors.map((e) => e.message).join('; ')}`;
      return conflict(err, { details: workflowDetails(res.errors) }, 'invalid_workflow');
    }
    const done = await decide(tx, row, 'applied', actor.by, { applied_version: res.version });
    return { ok: true, value: toDetail(done) };
  }

  const { repo, checks } = change.data;
  const now = await repoChecksNow(tx, actor.accountId, repo, true);
  if (stableJson(repoBase(now)) !== stableJson(row.base)) {
    return conflict(`${repo}'s checks changed since the proposal: propose it again.`);
  }
  if (checks === null) {
    await clearRepoChecks(tx, actor.accountId, repo);
  } else {
    const res = await setRepoChecks(tx, actor.accountId, { repo, ...checks }, actor.by);
    if (!res.ok) {
      const err = `The checks are invalid: ${res.message}.`;
      await decide(tx, row, 'failed', actor.by, { error: err });
      return failure('failed', err, { details: res.details });
    }
  }
  const done = await decide(tx, row, 'applied', actor.by);
  return { ok: true, value: toDetail(done) };
}

/**
 * Apply a `proposed` proposal through the existing guards (the workflow admin gate, the approvals
 * guard, `base_version`; the repo checks' snapshot), once: the row is locked, and a second apply
 * gets `already_applied`. A refusal that depends on what changed since (`conflict`,
 * `approval_weakened`) marks the proposal `conflict`; an error marks it `failed`. Never retried.
 */
export async function applyProposal(
  db: Db,
  actor: ProposalActor,
  id: string,
): Promise<ProposalResult<ChangeProposalDetail>> {
  try {
    const out = await withTransaction(db, (tx) => applyLocked(tx, actor, id));
    return out;
  } catch (err) {
    const message =
      `Applying it failed on the server: ${err instanceof Error ? err.message : String(err)}`.slice(
        0,
        500,
      );
    if (UUID_RE.test(id)) {
      await db.query(
        "UPDATE change_proposal SET status = 'failed', error = $3, decided_by = $4, decided_at = now() " +
          "WHERE id = $1 AND account_id = $2 AND status = 'proposed'",
        [id, actor.accountId, message, actor.by],
      );
    }
    return failure('failed', message);
  }
}

export async function rejectProposal(
  q: Queryable,
  actor: ProposalActor,
  id: string,
): Promise<ProposalResult<ChangeProposalDetail>> {
  if (!UUID_RE.test(id)) return notFound(id);
  const r = await q.query<ChangeProposalRow>(
    "UPDATE change_proposal SET status = 'rejected', decided_by = $3, decided_at = now() " +
      "WHERE id = $1 AND account_id = $2 AND status = 'proposed' RETURNING *",
    [id, actor.accountId, actor.by],
  );
  if (r.rows[0]) return { ok: true, value: toDetail(r.rows[0]) };
  const row = await loadRow(q, actor.accountId, id);
  return row === null ? notFound(id) : notProposed(row);
}

// ---------------------------------------------------------------- review

/**
 * Compare the proposal's expected metric over the days after it was applied with as many days
 * before, scoped to its repo (repo checks) or workflow. Stored in `review` (the last one wins).
 */
export async function reviewProposal(
  q: Queryable,
  accountId: string,
  id: string,
  now = new Date(),
): Promise<ProposalResult<ChangeProposalDetail>> {
  const row = await loadRow(q, accountId, id);
  if (row === null) return notFound(id);
  if (row.status !== 'applied' || row.applied_at === null) {
    return failure('wrong_state', `Only an applied proposal can be reviewed; it is ${row.status}.`);
  }
  const effect = ExpectedEffectSchema.parse(row.expected_effect);
  const appliedAt = row.applied_at;
  const days = reviewWindowDays(appliedAt, now);
  let review: ProposalReview;
  if (days === null) {
    review = {
      metric: effect.metric,
      scope: effect.scope,
      direction: effect.direction,
      window_days: 0,
      before: { value: null, sample: 0 },
      after: { value: null, sample: 0 },
      delta: null,
      direction_met: null,
      too_early: true,
      reviewed_at: now.toISOString(),
    };
  } else {
    const p = row.payload as { repo?: string; workflow_id?: string };
    const scope = {
      accountId,
      windowDays: days,
      repo: p.repo ?? effect.scope.repo,
      workflowId: p.workflow_id,
    };
    const [before, after] = await Promise.all([
      loadAdvisorRows(q, { ...scope, until: appliedAt }),
      loadAdvisorRows(q, { ...scope, until: new Date(appliedAt.getTime() + days * 86_400_000) }),
    ]);
    review = {
      ...compareMetrics(before, after, effect),
      window_days: days,
      too_early: false,
      reviewed_at: now.toISOString(),
    };
  }
  const r = await q.query<ChangeProposalRow>(
    'UPDATE change_proposal SET review = $2, reviewed_at = $3 WHERE id = $1 RETURNING *',
    [row.id, JSON.stringify(review), now],
  );
  return { ok: true, value: toDetail(r.rows[0]!) };
}
