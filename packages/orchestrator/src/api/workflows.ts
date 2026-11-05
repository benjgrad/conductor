import {
  LOCAL_ACCOUNT_ID,
  WorkflowDefinitionSchema,
  approvalsWeakened,
  validateWorkflow,
  type WorkflowDefinition,
  type WorkflowValidationError,
} from '@conductor/shared';
import type { Queryable } from '../contracts.js';

// ADR-0009 / ADR-0030 amendment: saving a workflow version. One function behind both
// `POST /api/workflows` and the MCP `save_workflow` / `adopt_default_workflow` tools. The server
// assigns the version (max + 1). The MCP-only guards (admin gate, approvals, truncation) live in
// mcp/tools.ts; this only validates, checks `base_version` and inserts.

const PG_UNIQUE_VIOLATION = '23505';

export type SaveWorkflowResult =
  | { ok: true; id: string; version: number }
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

/** Insert a validated definition as version max + 1 (refused by rule 18, `removedStatesInUse`). */
export async function insertWorkflowVersion(
  q: Queryable,
  def: WorkflowDefinition,
  opts: SaveWorkflowOptions = {},
): Promise<SaveWorkflowResult> {
  const inUse = await removedStatesInUse(q, def);
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
  return insertWorkflowVersion(q, result.def, opts);
}
