import { isDeepStrictEqual } from 'node:util';
import {
  CONDUCTOR_V1,
  CONDUCTOR_V1_DEF,
  CONDUCTOR_V2,
  CONDUCTOR_V2_DEF,
  CONDUCTOR_WORKFLOW_ID,
  WorkflowDefinitionSchema,
  validateWorkflow,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
} from '@conductor/shared';
import type { Queryable } from '../contracts.js';

// ADR-0010 / ADR-0011 (M1b-T09): the orchestrator seeds the shipped `conductor` workflow.
// - v1 when no `conductor` version exists: one INSERT that only fires while no version exists,
//   and `ON CONFLICT DO NOTHING` on the (id, version) primary key for the race where two starts
//   both saw none.
// - v2 when the latest version is the **unedited** shipped v1 (its parsed definition deep-equals
//   CONDUCTOR_V1_DEF): one INSERT of version 2 that only fires while no version above 1 exists,
//   with the same ON CONFLICT, so concurrent starts insert exactly one v2. An empty database gets
//   v1 then v2 (v2 latest).
// - Anything else (the user saved a version of their own) is never touched: the start logs that a
//   newer default is available, and `GET /api/workflows/conductor` carries `default_available`.

/** The message logged on start when the user's edits kept the seed from inserting v2. */
export const NEWER_DEFAULT_MESSAGE = 'A newer default conductor workflow is available';

export interface SeedOptions {
  /** Where the "newer default" notice goes; default stderr. null = silent (the ticket route). */
  log?: ((msg: string) => void) | null;
}

function checkedDef(input: WorkflowDefinitionInput): WorkflowDefinition {
  const checked = validateWorkflow(input);
  if (!checked.ok) {
    // A shipped definition that fails its own validator is a build bug: fail loudly.
    throw new Error(
      `the shipped ${CONDUCTOR_WORKFLOW_ID} v${input.version} workflow is invalid: ${checked.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ')}`,
    );
  }
  return checked.def;
}

/**
 * Whether a stored definition is `shipped` unedited: parsed (defaults applied, as for every read)
 * and compared as JSON, ignoring `version` (the row's version is the key, not the content). A row
 * that no longer parses is an edit.
 */
export function isShippedDefinition(stored: unknown, shipped: WorkflowDefinition): boolean {
  const parsed = WorkflowDefinitionSchema.safeParse(stored);
  if (!parsed.success) return false;
  const norm = (d: WorkflowDefinition): unknown => JSON.parse(JSON.stringify({ ...d, version: 0 }));
  return isDeepStrictEqual(norm(parsed.data), norm(shipped));
}

/**
 * The shipped default `conductor` version this id does not have yet (2 when no stored version is
 * the shipped v2), else null; null for every other id. `GET /api/workflows/:id` sends it as
 * `default_available` so the editor can offer the new defaults.
 */
export async function conductorDefaultAvailable(db: Queryable, id: string): Promise<number | null> {
  if (id !== CONDUCTOR_WORKFLOW_ID) return null;
  const rows = await db.query<{ definition: unknown }>(
    'SELECT definition FROM workflow_definition WHERE id = $1',
    [id],
  );
  if (rows.rowCount === 0) return null;
  return rows.rows.some((r) => isShippedDefinition(r.definition, CONDUCTOR_V2_DEF))
    ? null
    : CONDUCTOR_V2_DEF.version;
}

/** true = this call inserted a version (v1, v2 or both); false = nothing changed. */
export async function seedConductorWorkflow(
  db: Queryable,
  opts: SeedOptions = {},
): Promise<boolean> {
  const v1 = checkedDef(CONDUCTOR_V1);
  const v2 = checkedDef(CONDUCTOR_V2);
  const insertedV1 = await db.query(
    'INSERT INTO workflow_definition (id, version, definition, created_by) ' +
      "SELECT $1::text, 1, $2::jsonb, 'conductor' " +
      'WHERE NOT EXISTS (SELECT 1 FROM workflow_definition WHERE id = $1::text) ' +
      'ON CONFLICT (id, version) DO NOTHING',
    [CONDUCTOR_WORKFLOW_ID, JSON.stringify(v1)],
  );

  const latest = await db.query<{ version: number; definition: unknown }>(
    'SELECT version, definition FROM workflow_definition WHERE id = $1 ' +
      'ORDER BY version DESC LIMIT 1',
    [CONDUCTOR_WORKFLOW_ID],
  );
  const row = latest.rows[0];
  let insertedV2 = false;
  if (row?.version === 1 && isShippedDefinition(row.definition, CONDUCTOR_V1_DEF)) {
    const res = await db.query(
      'INSERT INTO workflow_definition (id, version, definition, created_by) ' +
        "SELECT $1::text, $2::int, $3::jsonb, 'conductor' " +
        'WHERE NOT EXISTS (SELECT 1 FROM workflow_definition WHERE id = $1::text AND version > 1) ' +
        'ON CONFLICT (id, version) DO NOTHING',
      [CONDUCTOR_WORKFLOW_ID, v2.version, JSON.stringify(v2)],
    );
    insertedV2 = res.rowCount === 1;
  } else if (row !== undefined && opts.log !== null) {
    const available = await conductorDefaultAvailable(db, CONDUCTOR_WORKFLOW_ID);
    if (available !== null) {
      const log =
        opts.log ?? ((m: string) => void process.stderr.write(`[conductor-orchestrator] ${m}\n`));
      log(
        `${NEWER_DEFAULT_MESSAGE} (v${available}); ` +
          `your edited version ${row?.version ?? '?'} was kept as the latest.`,
      );
    }
  }
  return insertedV1.rowCount === 1 || insertedV2;
}
