import { isDeepStrictEqual } from 'node:util';
import {
  CONDUCTOR_V1,
  CONDUCTOR_V2,
  CONDUCTOR_V3,
  CONDUCTOR_V4,
  CONDUCTOR_WORKFLOW_ID,
  LOCAL_ACCOUNT_ID,
  ROUTINE_V1,
  ROUTINE_WORKFLOW_ID,
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
// ADR-0032: `routine` (recurring tickets) is seeded by the same rules (`seedShippedWorkflow`).
// M2-T12: workflows belong to an account (primary key (account_id, id, version)), so every rule
// above runs per account: `seedAccount` seeds one (sign-up), `seedAllAccounts` every one (start).
// One account's edits never stop another account's upgrade. `accountId` defaults to `local`.

/** The message logged on start when the user's edits kept the seed from inserting a newer default. */
export const NEWER_DEFAULT_MESSAGE = 'A newer default conductor workflow is available';

export interface SeedOptions {
  /** Where the "newer default" notice goes; default stderr. null = silent (the ticket route). */
  log?: ((msg: string) => void) | null;
  /** The account to seed; default `local`. */
  accountId?: string;
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
      `the shipped ${input.id} v${input.version} workflow is invalid: ${checked.errors
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
 * The newest shipped `conductor` definition (ADR-0030 amendment: `adopt_default_workflow` saves it
 * as the next version).
 */
export function newestShippedConductor(): WorkflowDefinition {
  return shipped().at(-1)!;
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
export async function conductorDefaultAvailable(
  db: Queryable,
  id: string,
  accountId: string = LOCAL_ACCOUNT_ID,
): Promise<number | null> {
  if (id !== CONDUCTOR_WORKFLOW_ID) return null;
  const rows = await db.query<{ definition: unknown }>(
    'SELECT definition FROM workflow_definition WHERE account_id = $1 AND id = $2',
    [accountId, id],
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
  const accountId = opts.accountId ?? LOCAL_ACCOUNT_ID;
  return seedShippedWorkflow(db, CONDUCTOR_WORKFLOW_ID, shipped(), async (latestVersion) => {
    if (opts.log === null) return;
    const available = await conductorDefaultAvailable(db, CONDUCTOR_WORKFLOW_ID, accountId);
    if (available === null) return;
    const log =
      opts.log ?? ((m: string) => void process.stderr.write(`[conductor-orchestrator] ${m}\n`));
    log(
      `${NEWER_DEFAULT_MESSAGE} (v${available}); ` +
        `your edited version ${latestVersion} was kept as the latest` +
        (accountId === LOCAL_ACCOUNT_ID ? '.' : ` (account ${accountId}).`),
    );
  }, accountId);
}

/** ADR-0032: the shipped `routine` versions, oldest first, each validated. */
function shippedRoutine(): WorkflowDefinition[] {
  return [ROUTINE_V1].map((v) => checkedDef(v, false));
}

/**
 * ADR-0032: seed the shipped `routine` workflow (recurring tickets), by the same rules as
 * `conductor`; an edited latest version is kept silently. true = it inserted a version.
 */
export function seedRoutineWorkflow(
  db: Queryable,
  accountId: string = LOCAL_ACCOUNT_ID,
): Promise<boolean> {
  return seedShippedWorkflow(db, ROUTINE_WORKFLOW_ID, shippedRoutine(), null, accountId);
}

/**
 * M2-T12: give one account its shipped workflows (`conductor` and `routine`), silently. Sign-up
 * calls it inside its transaction; true = it inserted a version.
 */
export async function seedAccount(db: Queryable, accountId: string): Promise<boolean> {
  const conductor = await seedConductorWorkflow(db, { log: null, accountId });
  const routine = await seedRoutineWorkflow(db, accountId);
  return conductor || routine;
}

/**
 * M2-T12: seed every account on start (each account's unedited shipped versions are upgraded; an
 * account that edited its own is told a newer default exists, through `log`).
 */
export async function seedAllAccounts(db: Queryable, opts: SeedOptions = {}): Promise<void> {
  const accounts = await db.query<{ id: string }>('SELECT id FROM account ORDER BY id');
  for (const { id } of accounts.rows) {
    await seedConductorWorkflow(db, { ...opts, accountId: id });
    await seedRoutineWorkflow(db, id);
  }
}

/**
 * Seed a shipped workflow `id` (`versions` oldest first): v1 when none is stored, then each next
 * shipped version while the latest stored one is an unedited shipped one. `onEdited` runs when the
 * latest stored version is the user's own (the "newer default" notice).
 */
export async function seedShippedWorkflow(
  db: Queryable,
  id: string,
  versions: readonly WorkflowDefinition[],
  onEdited: ((latestVersion: number) => Promise<void>) | null,
  accountId: string = LOCAL_ACCOUNT_ID,
): Promise<boolean> {
  const insertedV1 = await db.query(
    'INSERT INTO workflow_definition (account_id, id, version, definition, created_by) ' +
      "SELECT $3::uuid, $1::text, 1, $2::jsonb, 'conductor' " +
      'WHERE NOT EXISTS (SELECT 1 FROM workflow_definition ' +
      'WHERE account_id = $3::uuid AND id = $1::text) ' +
      'ON CONFLICT (account_id, id, version) DO NOTHING',
    [id, JSON.stringify(versions[0]), accountId],
  );
  let inserted = insertedV1.rowCount === 1;

  for (;;) {
    const latest = await db.query<{ version: number; definition: unknown }>(
      'SELECT version, definition FROM workflow_definition WHERE account_id = $1 AND id = $2 ' +
        'ORDER BY version DESC LIMIT 1',
      [accountId, id],
    );
    const row = latest.rows[0];
    if (row === undefined) return inserted;
    const at = versions.findIndex(
      (v) => v.version === row.version && isShippedDefinition(row.definition, v),
    );
    const next = at >= 0 ? versions[at + 1] : undefined;
    if (next === undefined) {
      if (at < 0 && onEdited !== null) await onEdited(row.version);
      return inserted;
    }
    // Only fires while no version at or above `next` exists; a concurrent start that won the race
    // makes this a no-op, and the next read carries on from whatever is latest then.
    const res = await db.query(
      'INSERT INTO workflow_definition (account_id, id, version, definition, created_by) ' +
        "SELECT $4::uuid, $1::text, $2::int, $3::jsonb, 'conductor' " +
        'WHERE NOT EXISTS (SELECT 1 FROM workflow_definition ' +
        'WHERE account_id = $4::uuid AND id = $1::text AND version >= $2::int) ' +
        'ON CONFLICT (account_id, id, version) DO NOTHING',
      [id, next.version, JSON.stringify(next), accountId],
    );
    if (res.rowCount === 1) inserted = true;
  }
}
