import { CONDUCTOR_V1, CONDUCTOR_WORKFLOW_ID, validateWorkflow } from '@conductor/shared';
import type { Queryable } from '../contracts.js';

// ADR-0010: the orchestrator seeds `conductor` v1 (the shipped definition, packages/shared
// workflow/conductor.ts = docs/design/workflows/conductor.v1.json) when no `conductor` version
// exists. Idempotent and safe on concurrent starts: one INSERT that only fires while no version
// exists, and `ON CONFLICT DO NOTHING` on the (id, version) primary key for the race where two
// starts both saw none. A saved v2+ is never touched.

/** true = this call inserted v1; false = some `conductor` version already existed. */
export async function seedConductorWorkflow(db: Queryable): Promise<boolean> {
  const checked = validateWorkflow(CONDUCTOR_V1);
  if (!checked.ok) {
    // A shipped definition that fails its own validator is a build bug: fail loudly.
    throw new Error(
      `the shipped ${CONDUCTOR_WORKFLOW_ID} workflow is invalid: ${checked.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ')}`,
    );
  }
  const res = await db.query(
    'INSERT INTO workflow_definition (id, version, definition, created_by) ' +
      "SELECT $1::text, 1, $2::jsonb, 'conductor' " +
      'WHERE NOT EXISTS (SELECT 1 FROM workflow_definition WHERE id = $1::text) ' +
      'ON CONFLICT (id, version) DO NOTHING',
    [CONDUCTOR_WORKFLOW_ID, JSON.stringify(checked.def)],
  );
  return res.rowCount === 1;
}
