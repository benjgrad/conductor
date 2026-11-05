import {
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

/** Insert a validated definition as version max + 1. */
export async function insertWorkflowVersion(
  q: Queryable,
  def: WorkflowDefinition,
  opts: SaveWorkflowOptions = {},
): Promise<SaveWorkflowResult> {
  // A concurrent save of the same id loses the primary-key race and retries.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await q.query<{ version: number }>(
        'INSERT INTO workflow_definition (id, version, definition, created_by, note) ' +
          'SELECT $1::text, coalesce(max(version), 0) + 1, ' +
          "jsonb_set($2::jsonb, '{version}', to_jsonb(coalesce(max(version), 0) + 1)), $3::text, " +
          '$5::text FROM workflow_definition WHERE id = $1::text ' +
          'HAVING $4::int IS NULL OR coalesce(max(version), 0) = $4::int RETURNING version',
        [
          def.id,
          JSON.stringify(def),
          opts.createdBy ?? null,
          opts.baseVersion ?? null,
          opts.note?.trim() ? opts.note.trim() : null,
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
