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
import {
  loadProposals,
  pendingCount,
  PROPOSALS_COLUMN,
  readDecisions,
  sessionProposals,
  type ProposalSession,
} from './proposals.js';
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
  /** Session id → pending proposals, when preloaded (the board load). */
  private proposals: Map<string, number> | null = null;

  constructor(
    private readonly q: Queryable,
    private readonly required: RequiredCaps = requiredCaps,
  ) {}

  /** Read every session's alerts at once (the board load). */
  async preloadAlerts(): Promise<void> {
    this.alerts = await readCardAlerts(this.q);
  }

  /**
   * 06 §Proposed tickets: count the pending proposals of the board's Needs input sessions at once
   * (one decision query); other cards have no badge.
   */
  async preloadProposals(
    sessions: readonly (ProposalSession & { id: string; ticket_id: string })[],
  ): Promise<void> {
    const parsed = new Map<string, Awaited<ReturnType<typeof sessionProposals>>>();
    for (const s of sessions) {
      const ps = await sessionProposals(this.q, s);
      if (ps.length > 0) parsed.set(s.id, ps);
    }
    const withAny = sessions.filter((s) => parsed.has(s.id));
    const decisions = await readDecisions(
      this.q,
      withAny.map((s) => s.ticket_id),
    );
    this.proposals = new Map(
      withAny.map((s) => {
        const d = decisions.get(s.ticket_id);
        return [s.id, parsed.get(s.id)!.filter((p) => !d?.has(p.id)).length];
      }),
    );
  }

  async apply(card: BoardCard, ticket: RoutingTicket): Promise<BoardCard> {
    const { alerts: _a, routing: _r, proposals_pending: _p, ...rest } = card;
    void _a;
    void _r;
    void _p;
    const out: BoardCard = rest;
    if (card.column === PROPOSALS_COLUMN && card.session_id !== null) {
      const n = this.proposals
        ? (this.proposals.get(card.session_id) ?? 0)
        : await this.pendingProposals(card.ticket_id, card.session_id);
      if (n > 0) out.proposals_pending = n;
    }
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

  private async pendingProposals(ticketId: string, sessionId: string): Promise<number> {
    const r = await this.q.query<ProposalSession>(
      'SELECT context, workflow_id, workflow_version FROM session WHERE id = $1',
      [sessionId],
    );
    const session = r.rows[0];
    return session ? pendingCount(await loadProposals(this.q, ticketId, session)) : 0;
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
