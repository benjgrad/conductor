import {
  CONDUCTOR_V1,
  CONDUCTOR_V1_DEF,
  CONDUCTOR_V2_DEF,
  CONDUCTOR_V3_DEF,
  CONDUCTOR_V4_DEF,
  CONDUCTOR_V5_DEF,
  WorkflowDefinitionSchema,
} from '@conductor/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NEWER_DEFAULT_MESSAGE,
  conductorDefaultAvailable,
  isShippedDefinition,
  seedConductorWorkflow,
} from '../../src/engine/seed.js';
import { useTestDatabase } from '../db.js';

// ADR-0010 / ADR-0011 (M1b-T09) / ADR-0025 / M2-T34 / M2-T35c: the conductor seed and its upgrades
// along the shipped chain v1 → … → v5. Needs `pnpm db:up`.

const db = useTestDatabase();

interface Row {
  version: number;
  definition: unknown;
  created_by: string | null;
}
const rows = async () =>
  (
    await db.pool.query<Row>(
      "SELECT version, definition, created_by FROM workflow_definition WHERE id = 'conductor' " +
        'ORDER BY version',
    )
  ).rows;
const insert = (version: number, definition: unknown) =>
  db.pool.query(
    "INSERT INTO workflow_definition (id, version, definition) VALUES ('conductor', $1, $2)",
    [version, JSON.stringify(definition)],
  );

beforeEach(async () => {
  await db.pool.query("DELETE FROM workflow_definition WHERE id = 'conductor'");
});

describe('seedConductorWorkflow (ADR-0010, M1b-T09 / ADR-0025 upgrades)', () => {
  it('an empty database gets v1 … v5; v5 is the latest and is the shipped v5', async () => {
    const log = vi.fn();
    expect(await seedConductorWorkflow(db.pool, { log })).toBe(true);
    const r = await rows();
    expect(r.map((x) => [x.version, x.created_by])).toEqual([
      [1, 'conductor'],
      [2, 'conductor'],
      [3, 'conductor'],
      [4, 'conductor'],
      [5, 'conductor'],
    ]);
    expect(isShippedDefinition(r[0]!.definition, CONDUCTOR_V1_DEF)).toBe(true);
    expect(WorkflowDefinitionSchema.parse(r[1]!.definition)).toEqual(CONDUCTOR_V2_DEF);
    expect(WorkflowDefinitionSchema.parse(r[2]!.definition)).toEqual(CONDUCTOR_V3_DEF);
    expect(WorkflowDefinitionSchema.parse(r[3]!.definition)).toEqual(CONDUCTOR_V4_DEF);
    expect(WorkflowDefinitionSchema.parse(r[4]!.definition)).toEqual(CONDUCTOR_V5_DEF);
    expect(log).not.toHaveBeenCalled();
    expect(await conductorDefaultAvailable(db.pool, 'conductor')).toBeNull();
    // Idempotent: nothing more on the next start.
    expect(await seedConductorWorkflow(db.pool, { log })).toBe(false);
    expect((await rows()).map((x) => x.version)).toEqual([1, 2, 3, 4, 5]);
    expect(log).not.toHaveBeenCalled();
  });

  it('an unedited v1 (an M1 database) gets v2 … v5 added', async () => {
    // As the M1 seed stored it: the parsed v1.
    await insert(1, CONDUCTOR_V1_DEF);
    expect(await seedConductorWorkflow(db.pool, { log: null })).toBe(true);
    const r = await rows();
    expect(r.map((x) => x.version)).toEqual([1, 2, 3, 4, 5]);
    expect(WorkflowDefinitionSchema.parse(r[1]!.definition)).toEqual(CONDUCTOR_V2_DEF);
    expect(WorkflowDefinitionSchema.parse(r[2]!.definition)).toEqual(CONDUCTOR_V3_DEF);
  });

  it('an unedited v2 (an M1b database) gets v3 … v5 added', async () => {
    await insert(1, CONDUCTOR_V1_DEF);
    await insert(2, CONDUCTOR_V2_DEF);
    expect(await seedConductorWorkflow(db.pool, { log: null })).toBe(true);
    const r = await rows();
    expect(r.map((x) => x.version)).toEqual([1, 2, 3, 4, 5]);
    expect(WorkflowDefinitionSchema.parse(r[2]!.definition)).toEqual(CONDUCTOR_V3_DEF);
  });

  it('an unedited v3 (the database M2-T31a left) gets v4 and v5 added', async () => {
    await insert(1, CONDUCTOR_V1_DEF);
    await insert(2, CONDUCTOR_V2_DEF);
    await insert(3, CONDUCTOR_V3_DEF);
    expect(await seedConductorWorkflow(db.pool, { log: null })).toBe(true);
    const r = await rows();
    expect(r.map((x) => [x.version, x.created_by])).toEqual([
      [1, null],
      [2, null],
      [3, null],
      [4, 'conductor'],
      [5, 'conductor'],
    ]);
    expect(WorkflowDefinitionSchema.parse(r[3]!.definition)).toEqual(CONDUCTOR_V4_DEF);
    expect(await conductorDefaultAvailable(db.pool, 'conductor')).toBeNull();
  });

  it('an unedited v4 (the database M2-T34 left) gets v5 added', async () => {
    await insert(1, CONDUCTOR_V1_DEF);
    await insert(2, CONDUCTOR_V2_DEF);
    await insert(3, CONDUCTOR_V3_DEF);
    await insert(4, CONDUCTOR_V4_DEF);
    expect(await seedConductorWorkflow(db.pool, { log: null })).toBe(true);
    const r = await rows();
    expect(r.map((x) => x.version)).toEqual([1, 2, 3, 4, 5]);
    expect(WorkflowDefinitionSchema.parse(r[4]!.definition)).toEqual(CONDUCTOR_V5_DEF);
  });

  it('an edit saved on top of the shipped v3 (a v4 of the user’s) is kept', async () => {
    await insert(1, CONDUCTOR_V1_DEF);
    await insert(2, CONDUCTOR_V2_DEF);
    await insert(3, CONDUCTOR_V3_DEF);
    const mine = structuredClone(CONDUCTOR_V3_DEF);
    mine.version = 4;
    mine.budget = { ...mine.budget, usd: 9 };
    await insert(4, mine);
    expect(await seedConductorWorkflow(db.pool, { log: null })).toBe(false);
    expect((await rows()).map((x) => x.version)).toEqual([1, 2, 3, 4]);
    expect(await conductorDefaultAvailable(db.pool, 'conductor')).toBe(5);
  });

  it('an unedited v1 stored raw (before defaults were applied) also counts as unedited', async () => {
    await insert(1, CONDUCTOR_V1);
    expect(await seedConductorWorkflow(db.pool, { log: null })).toBe(true);
    expect((await rows()).map((x) => x.version)).toEqual([1, 2, 3, 4, 5]);
  });

  it('an edited v1 (a v2 of the user’s) gets nothing; the start logs that a default is available', async () => {
    await insert(1, CONDUCTOR_V1_DEF);
    const mine = structuredClone(CONDUCTOR_V1_DEF);
    mine.version = 2;
    mine.states.planning!.title = 'Thinking';
    await insert(2, mine);
    const log = vi.fn();
    expect(await seedConductorWorkflow(db.pool, { log })).toBe(false);
    const r = await rows();
    expect(r.map((x) => x.version)).toEqual([1, 2]);
    expect(r[1]!.created_by).toBeNull();
    expect(WorkflowDefinitionSchema.parse(r[1]!.definition).states.planning?.title).toBe(
      'Thinking',
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain(NEWER_DEFAULT_MESSAGE);
    expect(await conductorDefaultAvailable(db.pool, 'conductor')).toBe(5);
    // The ticket route seeds silently.
    expect(await seedConductorWorkflow(db.pool, { log: null })).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('an edit saved on top of the shipped v2 (a v3 of the user’s) is kept', async () => {
    await insert(1, CONDUCTOR_V1_DEF);
    await insert(2, CONDUCTOR_V2_DEF);
    const mine = structuredClone(CONDUCTOR_V2_DEF);
    mine.version = 3;
    mine.budget = { ...mine.budget, usd: 9 };
    await insert(3, mine);
    expect(await seedConductorWorkflow(db.pool, { log: null })).toBe(false);
    expect((await rows()).map((x) => x.version)).toEqual([1, 2, 3]);
    expect(await conductorDefaultAvailable(db.pool, 'conductor')).toBe(5);
  });

  it('a v1 changed in place (not the shipped one) is an edit too', async () => {
    const changed = structuredClone(CONDUCTOR_V1_DEF);
    changed.budget = { ...changed.budget, usd: 50 };
    await insert(1, changed);
    expect(await seedConductorWorkflow(db.pool, { log: null })).toBe(false);
    expect((await rows()).map((x) => x.version)).toEqual([1]);
    expect(await conductorDefaultAvailable(db.pool, 'conductor')).toBe(5);
  });

  it('concurrent starts on an empty database insert exactly one of each version', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => seedConductorWorkflow(db.pool, { log: null })),
    );
    expect(results.some(Boolean)).toBe(true);
    expect((await rows()).map((x) => x.version)).toEqual([1, 2, 3, 4, 5]);
  });

  it('concurrent starts on an unedited v4 insert exactly one v5', async () => {
    await insert(1, CONDUCTOR_V1_DEF);
    await insert(2, CONDUCTOR_V2_DEF);
    await insert(3, CONDUCTOR_V3_DEF);
    await insert(4, CONDUCTOR_V4_DEF);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => seedConductorWorkflow(db.pool, { log: null })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await rows()).map((x) => x.version)).toEqual([1, 2, 3, 4, 5]);
  });

  it('default_available is null for other workflow ids and unknown ones', async () => {
    expect(await conductorDefaultAvailable(db.pool, 'm1_basic')).toBeNull();
    expect(await conductorDefaultAvailable(db.pool, 'conductor')).toBeNull(); // none stored
  });
});
