import {
  boardColumns,
  CONDUCTOR_WORKFLOW_ID,
  MachineAlertKindSchema,
  type BoardCard,
  type BoardCardAlert,
  type CardView,
  type TicketKind,
  type WorkflowDefinition,
} from '@conductor/shared';
import type { Queryable } from '../contracts.js';
import {
  loadRoutingFleet,
  requiredCaps,
  routingFor,
  type RequiredCaps,
  type RoutingFleet,
} from '../gateway/routing.js';
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

// ---------------------------------------------------------------- M2-T16a machine fields

/** What a card's routing needs of its ticket. */
export interface RoutingTicket {
  account_id: string;
  repo: string;
  kind: TicketKind | null;
  workflow_id: string;
  workflow_version: number | null;
}

/** Open machine_alert rows per session (all sessions, or only `sessionIds`), oldest first. */
export async function readCardAlerts(
  q: Queryable,
  sessionIds?: readonly string[],
): Promise<Map<string, BoardCardAlert[]>> {
  const r = await q.query<{
    session_id: string;
    kind: string;
    detail: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT session_id, kind, detail, created_at FROM machine_alert
      WHERE cleared_at IS NULL AND session_id IS NOT NULL
        AND ($1::uuid[] IS NULL OR session_id = ANY($1::uuid[]))
      ORDER BY created_at, id`,
    [sessionIds ?? null],
  );
  const out = new Map<string, BoardCardAlert[]>();
  for (const row of r.rows) {
    const kind = MachineAlertKindSchema.safeParse(row.kind);
    if (!kind.success) continue;
    const files = Array.isArray(row.detail.files)
      ? row.detail.files.filter((f): f is string => typeof f === 'string')
      : [];
    const at =
      typeof row.detail.at === 'string' && !Number.isNaN(Date.parse(row.detail.at))
        ? new Date(row.detail.at).toISOString()
        : row.created_at.toISOString();
    const list = out.get(row.session_id) ?? [];
    list.push({ kind: kind.data, files, at });
    out.set(row.session_id, list);
  }
  return out;
}

/**
 * Adds a card's machine fields (ADR-0013 §Routing, U-060): `alerts` (the session's open alerts)
 * and, on a Queued card, `routing` when no online machine of the account can take it. One
 * instance per read: online machines are loaded once per account, alerts once when preloaded.
 * TD: no routing fan-out on machine / inventory changes: a Queued card's routing is recomputed on
 * its own card events and on board load only.
 */
export class MachineCardFields {
  private readonly machines = new Map<string, Promise<RoutingFleet>>();
  private alerts: Map<string, BoardCardAlert[]> | null = null;

  constructor(
    private readonly q: Queryable,
    private readonly required: RequiredCaps = requiredCaps,
  ) {}

  /** Read every session's alerts at once (the board load). */
  async preloadAlerts(): Promise<void> {
    this.alerts = await readCardAlerts(this.q);
  }

  async apply(card: BoardCard, ticket: RoutingTicket): Promise<BoardCard> {
    const { alerts: _a, routing: _r, ...rest } = card;
    void _a;
    void _r;
    const out: BoardCard = rest;
    if (card.session_id !== null) {
      const alerts = this.alerts
        ? this.alerts.get(card.session_id)
        : (await readCardAlerts(this.q, [card.session_id])).get(card.session_id);
      if (alerts && alerts.length > 0) out.alerts = alerts;
    }
    if (card.column === 'queued') {
      const routing = await this.routing(ticket);
      if (routing) out.routing = routing;
    }
    return out;
  }

  private async routing(ticket: RoutingTicket) {
    let version = ticket.workflow_version;
    if (version === null) {
      const r = await this.q.query<{ v: number | null }>(
        'SELECT max(version) AS v FROM workflow_definition WHERE id = $1',
        [ticket.workflow_id],
      );
      version = r.rows[0]?.v ?? null;
    }
    if (version === null) return undefined;
    const reqs = await this.required
      .get(this.q, ticket.workflow_id, version, ticket.kind)
      .catch(() => null);
    if (reqs === null) return undefined;
    let fleet = this.machines.get(ticket.account_id);
    if (!fleet) {
      fleet = loadRoutingFleet(this.q, ticket.account_id);
      this.machines.set(ticket.account_id, fleet);
    }
    const { online, exclusive } = await fleet;
    return routingFor(online, ticket.repo, reqs, exclusive);
  }
}

/** One card's machine fields (see MachineCardFields). */
export function withMachineFields(
  q: Queryable,
  card: BoardCard,
  ticket: RoutingTicket,
): Promise<BoardCard> {
  return new MachineCardFields(q).apply(card, ticket);
}
