import { isDeepStrictEqual } from 'node:util';
import {
  CONDUCTOR_V1,
  CONDUCTOR_V2,
  CONDUCTOR_V3,
  CONDUCTOR_V4,
  CONDUCTOR_WORKFLOW_ID,
  WorkflowDefinitionSchema,
  validateWorkflow,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
} from '@conductor/shared';
import type { Queryable } from '../contracts.js';

// ADR-0010 / ADR-0011 (M1b-T09) / ADR-0025 / M2-T34: the orchestrator seeds the shipped
// `conductor` workflow, v1 → v2 → v3 → v4 (`shipped()`, oldest first).
// - v1 when no `conductor` version exists: one INSERT that only fires while no version exists,
//   and `ON CONFLICT DO NOTHING` on the (id, version) primary key for the race where two starts
//   both saw none.
// - The next shipped version while the latest is an **unedited** shipped one (its parsed
//   definition deep-equals that version's): one INSERT that only fires while no version at or
//   above it exists, with the same ON CONFLICT, so concurrent starts insert exactly one. Repeated
//   until the latest is the newest shipped version: an empty database gets v1 … v4 (v4 latest).
// - Anything else (the user saved a version of their own) is never touched: the start logs that a
//   newer default is available, and `GET /api/workflows/conductor` carries `default_available`.

/** The message logged on start when the user's edits kept the seed from inserting a newer default. */
export const NEWER_DEFAULT_MESSAGE = 'A newer default conductor workflow is available';

export interface SeedOptions {
  /** Where the "newer default" notice goes; default stderr. null = silent (the ticket route). */
  log?: ((msg: string) => void) | null;
}

/**
 * Rules a superseded shipped version may break: v2 and v3 predate rule 17 (their personal `done`
 * opens a PR straight into Done). They stay stored and parsed, because sessions pinned to them
 * still run, but the newest shipped version must pass every rule.
 */
const SUPERSEDED_RULE_EXEMPTIONS: readonly number[] = [17];

function checkedDef(input: WorkflowDefinitionInput, superseded: boolean): WorkflowDefinition {
  const checked = validateWorkflow(input);
  if (
    !checked.ok &&
    superseded &&
    checked.errors.every((e) => SUPERSEDED_RULE_EXEMPTIONS.includes(e.rule))
  ) {
    return WorkflowDefinitionSchema.parse(input);
  }
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

/** The shipped `conductor` versions, oldest first, each validated. */
function shipped(): WorkflowDefinition[] {
  const all = [CONDUCTOR_V1, CONDUCTOR_V2, CONDUCTOR_V3, CONDUCTOR_V4];
  return all.map((v, i) => checkedDef(v, i < all.length - 1));
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
 * The newest shipped `conductor` version when no stored version is it unedited, else null; null
 * for every other id and when nothing is stored. `GET /api/workflows/:id` sends it as
 * `default_available` so the editor can offer the new defaults.
 */
export async function conductorDefaultAvailable(db: Queryable, id: string): Promise<number | null> {
  if (id !== CONDUCTOR_WORKFLOW_ID) return null;
  const rows = await db.query<{ definition: unknown }>(
    'SELECT definition FROM workflow_definition WHERE id = $1',
    [id],
  );
  if (rows.rowCount === 0) return null;
  const newest = shipped().at(-1)!;
  return rows.rows.some((r) => isShippedDefinition(r.definition, newest)) ? null : newest.version;
}

/** true = this call inserted at least one version; false = nothing changed. */
export async function seedConductorWorkflow(
  db: Queryable,
  opts: SeedOptions = {},
): Promise<boolean> {
  const versions = shipped();
  const insertedV1 = await db.query(
    'INSERT INTO workflow_definition (id, version, definition, created_by) ' +
      "SELECT $1::text, 1, $2::jsonb, 'conductor' " +
      'WHERE NOT EXISTS (SELECT 1 FROM workflow_definition WHERE id = $1::text) ' +
      'ON CONFLICT (id, version) DO NOTHING',
    [CONDUCTOR_WORKFLOW_ID, JSON.stringify(versions[0])],
  );
  let inserted = insertedV1.rowCount === 1;

  for (;;) {
    const latest = await db.query<{ version: number; definition: unknown }>(
      'SELECT version, definition FROM workflow_definition WHERE id = $1 ' +
        'ORDER BY version DESC LIMIT 1',
      [CONDUCTOR_WORKFLOW_ID],
    );
    const row = latest.rows[0];
    if (row === undefined) return inserted;
    const at = versions.findIndex(
      (v) => v.version === row.version && isShippedDefinition(row.definition, v),
    );
    const next = at >= 0 ? versions[at + 1] : undefined;
    if (next === undefined) {
      if (at < 0 && opts.log !== null) {
        const available = await conductorDefaultAvailable(db, CONDUCTOR_WORKFLOW_ID);
        if (available !== null) {
          const log =
            opts.log ??
            ((m: string) => void process.stderr.write(`[conductor-orchestrator] ${m}\n`));
          log(
            `${NEWER_DEFAULT_MESSAGE} (v${available}); ` +
              `your edited version ${row.version} was kept as the latest.`,
          );
        }
      }
      return inserted;
    }
    // Only fires while no version at or above `next` exists; a concurrent start that won the race
    // makes this a no-op, and the next read carries on from whatever is latest then.
    const res = await db.query(
      'INSERT INTO workflow_definition (id, version, definition, created_by) ' +
        "SELECT $1::text, $2::int, $3::jsonb, 'conductor' " +
        'WHERE NOT EXISTS (SELECT 1 FROM workflow_definition ' +
        'WHERE id = $1::text AND version >= $2::int) ' +
        'ON CONFLICT (id, version) DO NOTHING',
      [CONDUCTOR_WORKFLOW_ID, next.version, JSON.stringify(next)],
    );
    if (res.rowCount === 1) inserted = true;
  }
}
