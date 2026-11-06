import {
  DIFF_MAX,
  LOCAL_ACCOUNT_ID,
  WorkflowDefinitionSchema,
  capDiff,
  diffWorkflow,
  approvalsWeakened,
  validateWorkflow,
  type StructuralChange,
  type WorkflowDefinition,
  type WorkflowValidationError,
} from '@conductor/shared';
import type { Queryable } from '../contracts.js';
import { conductorDefaultAvailable, newestShippedConductor } from '../engine/seed.js';

// ADR-0009 / ADR-0030 amendment: saving a workflow version. One function behind
// `POST /api/workflows`, `POST /api/workflows/:id/default` (UXR-87) and the MCP `save_workflow` /
// `adopt_default_workflow` tools. The server assigns the version (max + 1). The approval guard is
// `saveGuarded`; the admin gate lives with each caller (mcp/tools.ts, api/index.ts).

const PG_UNIQUE_VIOLATION = '23505';

export type SaveWorkflowResult =
  | { ok: true; id: string; version: number; warnings?: WorkflowValidationError[] }
  | { ok: false; code: 'invalid_workflow'; errors: WorkflowValidationError[] }
  | { ok: false; code: 'conflict'; latest: number | null };

export interface SaveWorkflowOptions {
  /** `workflow_definition.created_by`: `mcp:<email>` for MCP saves; null (REST) leaves it unset. */
  createdBy?: string | null;
  /** Save only while this is still the latest version of the id (optimistic concurrency). */
  baseVersion?: number;
  /** UXR-70: `workflow_definition.note` ('' or null = none). */
  note?: string | null;
  /**
   * The saver's account (`workflow_definition.account_id`, default the local account). Workflows
   * are shared by every account, so `created_by` and `note` are shown only to this account.
   */
  accountId?: string;
}

/** The latest stored version of `id` and its parsed definition (null when it no longer parses). */
export async function latestWorkflow(
  q: Queryable,
  id: string,
): Promise<{ version: number; def: WorkflowDefinition | null } | null> {
  const r = await q.query<{ version: number; definition: unknown }>(
    'SELECT version, definition FROM workflow_definition WHERE id = $1 ' +
      'ORDER BY version DESC LIMIT 1',
    [id],
  );
  const row = r.rows[0];
  if (row === undefined) return null;
  const parsed = WorkflowDefinitionSchema.safeParse(row.definition);
  return { version: row.version, def: parsed.success ? parsed.data : null };
}

/**
 * The `state.transition` names whose approvals `def` would lose against the latest stored version
 * of the same id (`approvalsWeakened`); empty when there is none, or it no longer parses.
 */
export async function weakenedApprovals(q: Queryable, def: WorkflowDefinition): Promise<string[]> {
  const prev = await latestWorkflow(q, def.id);
  return prev?.def ? approvalsWeakened(prev.def, def) : [];
}

/** Sessions that are not finished (done, failed, lost): parked and reopened ones follow a new version. */
const OPEN_SESSION = "status NOT IN ('done', 'failed', 'lost')";

/**
 * Rule 18 (UXR-67): the states of the latest stored version of `def.id` that `def` drops, but
 * that unfinished tickets are still in. Parked and reopened tickets follow the newest version, so
 * dropping their column would strand them. One problem per such state, at `states.<name>`.
 */
export async function removedStatesInUse(
  q: Queryable,
  def: WorkflowDefinition,
): Promise<WorkflowValidationError[]> {
  const prev = await latestWorkflow(q, def.id);
  if (prev === null) return [];
  const prevStates = prev.def?.states ?? {};
  const dropped = Object.keys(prevStates).filter(
    (n) => !Object.prototype.hasOwnProperty.call(def.states, n),
  );
  if (dropped.length === 0) return [];
  const r = await q.query<{ workflow_state: string; n: string }>(
    'SELECT workflow_state, count(*)::text AS n FROM session ' +
      `WHERE workflow_id = $1 AND workflow_state = ANY($2::text[]) AND ${OPEN_SESSION} ` +
      'GROUP BY workflow_state ORDER BY workflow_state',
    [def.id, dropped],
  );
  return r.rows.map((row) => {
    const n = Number(row.n);
    const title = prevStates[row.workflow_state]?.title ?? row.workflow_state;
    return {
      rule: 18 as const,
      path: ['states', row.workflow_state],
      message:
        `${n} ticket${n === 1 ? ' is' : 's are'} in "${title}": move or finish ` +
        `${n === 1 ? 'it' : 'them'} before removing the column`,
    };
  });
}

/**
 * ADR-0039 (B3): the `bases` of the latest stored version of `def.id` that `def` drops, but that a
 * ticket still in Queued (`placeCard`: not finished, and no session with a state yet) names as its `base`. One problem
 * per such base, at `bases.<name>` (rule 26: a ticket's base names a key of `bases`).
 */
export async function removedBasesInUse(
  q: Queryable,
  def: WorkflowDefinition,
): Promise<WorkflowValidationError[]> {
  const prev = await latestWorkflow(q, def.id);
  if (prev === null) return [];
  const prevBases = prev.def?.bases ?? {};
  const dropped = Object.keys(prevBases).filter(
    (n) => def.bases === undefined || !Object.prototype.hasOwnProperty.call(def.bases, n),
  );
  if (dropped.length === 0) return [];
  const r = await q.query<{ name: string; n: string }>(
    "SELECT t.base #>> '{}' AS name, count(*)::text AS n FROM ticket t " +
      "WHERE t.workflow_id = $1 AND t.status NOT IN ('done', 'cancelled') " +
      "AND jsonb_typeof(t.base) = 'string' AND t.base #>> '{}' = ANY($2::text[]) " +
      'AND NOT EXISTS (SELECT 1 FROM session s ' +
      'WHERE s.ticket_id = t.id AND s.workflow_state IS NOT NULL) ' +
      "GROUP BY t.base #>> '{}' ORDER BY 1",
    [def.id, dropped],
  );
  return r.rows.map((row) => {
    const n = Number(row.n);
    return {
      rule: 26 as const,
      path: ['bases', row.name],
      message:
        `${n} queued ticket${n === 1 ? ' uses' : 's use'} base "${row.name}": change ` +
        `${n === 1 ? 'its' : 'their'} base before removing it`,
    };
  });
}

/**
 * Insert a validated definition as version max + 1 (refused by rule 18, `removedStatesInUse`, and
 * by rule 26 for a base queued tickets use, `removedBasesInUse`).
 */
export async function insertWorkflowVersion(
  q: Queryable,
  def: WorkflowDefinition,
  opts: SaveWorkflowOptions = {},
): Promise<SaveWorkflowResult> {
  const inUse = [...(await removedStatesInUse(q, def)), ...(await removedBasesInUse(q, def))];
  if (inUse.length > 0) return { ok: false, code: 'invalid_workflow', errors: inUse };
  // A concurrent save of the same id loses the primary-key race and retries.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await q.query<{ version: number }>(
        'INSERT INTO workflow_definition (id, version, definition, created_by, note, account_id) ' +
          'SELECT $1::text, coalesce(max(version), 0) + 1, ' +
          "jsonb_set($2::jsonb, '{version}', to_jsonb(coalesce(max(version), 0) + 1)), $3::text, " +
          '$5::text, $6::uuid FROM workflow_definition WHERE id = $1::text ' +
          'HAVING $4::int IS NULL OR coalesce(max(version), 0) = $4::int RETURNING version',
        [
          def.id,
          JSON.stringify(def),
          opts.createdBy ?? null,
          opts.baseVersion ?? null,
          opts.note?.trim() ? opts.note.trim() : null,
          opts.accountId ?? LOCAL_ACCOUNT_ID,
        ],
      );
      const row = res.rows[0];
      if (row === undefined) {
        return {
          ok: false,
          code: 'conflict',
          latest: (await latestWorkflow(q, def.id))?.version ?? null,
        };
      }
      return { ok: true, id: def.id, version: row.version };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== PG_UNIQUE_VIOLATION || attempt >= 4) throw err;
    }
  }
}

/** Validate `definition` (`validateWorkflow`) and insert it as version max + 1. */
export async function saveWorkflowDefinition(
  q: Queryable,
  definition: unknown,
  opts: SaveWorkflowOptions = {},
): Promise<SaveWorkflowResult> {
  const result = validateWorkflow(definition);
  if (!result.ok) return { ok: false, code: 'invalid_workflow', errors: result.errors };
  const saved = await insertWorkflowVersion(q, result.def, opts);
  // ADR-0039: warnings never block a save; the editor shows them after it.
  return saved.ok && result.warnings !== undefined
    ? { ...saved, warnings: result.warnings }
    : saved;
}

export type GuardedSaveResult =
  | { ok: true; id: string; version: number }
  | { ok: false; code: 'approval_weakened'; transitions: string[] }
  | { ok: false; code: 'conflict'; latest: number | null }
  /** Rule 18 (UXR-67): a column it drops still has tickets. */
  | { ok: false; code: 'invalid_workflow'; errors: WorkflowValidationError[] };

/**
 * ADR-0030 amendment: the approval guard (`weakenedApprovals`), then the insert. Behind MCP
 * `save_workflow` / `adopt_default_workflow` and UXR-87's `POST /api/workflows/:id/default`; the
 * admin gate is the caller's.
 */
export async function saveGuarded(
  q: Queryable,
  def: WorkflowDefinition,
  opts: SaveWorkflowOptions = {},
): Promise<GuardedSaveResult> {
  const weakened = await weakenedApprovals(q, def);
  if (weakened.length > 0) return { ok: false, code: 'approval_weakened', transitions: weakened };
  const res = await insertWorkflowVersion(q, def, opts);
  return res;
}

/** Save the newest shipped `conductor` default as its next version (replacing local edits). */
export function adoptDefaultWorkflow(
  q: Queryable,
  opts: SaveWorkflowOptions = {},
): Promise<GuardedSaveResult> {
  return saveGuarded(q, newestShippedConductor(), opts);
}

/**
 * UXR-87: what adopting the default would change, for the editor's Compare: the default's version,
 * the latest stored version it is compared with, and the capped structural diff. Null when no
 * newer default is available for `id`.
 */
export async function defaultComparison(
  q: Queryable,
  id: string,
): Promise<{
  version: number;
  base_version: number;
  definition: WorkflowDefinition;
  diff: { changes: StructuralChange[]; more_changes: number };
} | null> {
  const available = await conductorDefaultAvailable(q, id);
  if (available === null) return null;
  const r = await q.query<{ version: number; definition: unknown }>(
    'SELECT version, definition FROM workflow_definition WHERE id = $1 ' +
      'ORDER BY version DESC LIMIT 1',
    [id],
  );
  const row = r.rows[0];
  if (row === undefined) return null;
  const parsed = WorkflowDefinitionSchema.safeParse(row.definition);
  const before = parsed.success ? parsed.data : row.definition;
  const newest = newestShippedConductor();
  return {
    version: available,
    base_version: row.version,
    definition: newest,
    diff: capDiff(diffWorkflow(before, newest), DIFF_MAX),
  };
}
