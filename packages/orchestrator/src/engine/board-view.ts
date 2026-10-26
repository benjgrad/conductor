import {
  boardColumns,
  CONDUCTOR_WORKFLOW_ID,
  type CardView,
  type WorkflowDefinition,
} from '@conductor/shared';
import type { Queryable } from '../contracts.js';
import { DefinitionCache } from './rows.js';

// ADR-0010: what `toBoardCard` needs besides the rows. The board's columns come from the latest
// `conductor` version; a card's fallback column (old versions, old `m1_*` workflows) from the
// state types of the session's own pinned version.

/** Definitions are immutable per (id, version), so one process-wide cache is safe. */
const shared = new DefinitionCache();

/** The latest `conductor` definition, or null when none is seeded (a bare test database). */
export async function latestConductor(
  q: Queryable,
  defs: DefinitionCache = shared,
): Promise<WorkflowDefinition | null> {
  const r = await q.query<{ v: number | null }>(
    'SELECT max(version) AS v FROM workflow_definition WHERE id = $1',
    [CONDUCTOR_WORKFLOW_ID],
  );
  const v = r.rows[0]?.v ?? null;
  return v === null ? null : defs.get(q, CONDUCTOR_WORKFLOW_ID, v);
}

/** Resolves card views with the columns read once (one board load, one apply). */
export class CardViews {
  private columns: CardView['columns'] | null = null;

  constructor(
    private readonly q: Queryable,
    private readonly defs: DefinitionCache = shared,
  ) {}

  async view(workflowId: string, version: number | null): Promise<CardView> {
    this.columns ??= boardColumns(await latestConductor(this.q, this.defs));
    let def: WorkflowDefinition | null = null;
    if (version !== null) def = await this.defs.get(this.q, workflowId, version).catch(() => null);
    return { columns: this.columns, def };
  }

  /** The board's columns (Queued first). */
  async boardColumns(): Promise<CardView['columns']> {
    this.columns ??= boardColumns(await latestConductor(this.q, this.defs));
    return this.columns;
  }
}

/** One card view (columns + the session's definition) for a single card. */
export function cardView(
  q: Queryable,
  workflowId: string,
  version: number | null,
): Promise<CardView> {
  return new CardViews(q).view(workflowId, version);
}
