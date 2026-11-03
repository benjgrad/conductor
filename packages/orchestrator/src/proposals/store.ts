import {
  SESSION_PROPOSALS_LIMIT,
  UuidSchema,
  type AcceptProposalRequest,
  type AccountScope,
  type ApiErrorCode,
  type BoardSseEvent,
  type TicketDto,
  type TicketProposalDto,
} from '@conductor/shared';
import { accountHasRepo, insertTicketRow, sessionlessCardUpserted } from '../api/tickets.js';
import { toTicketDto } from '../api/queries.js';
import type { BoardBus, Queryable } from '../contracts.js';
import { withTransaction } from '../db/index.js';
import type { TicketProposalRow, TicketRow } from '../db/types.js';
import type { Db } from '../main.js';

// ADR-0034: follow-up tickets an agent proposed. One set of functions behind both the REST routes
// (/api/proposals/:id/accept | dismiss) and the MCP tools (get_ticket, decide_proposed_ticket),
// always scoped to the caller's account. The rows are written by the EngineService wrapper
// (`ticket_proposals` effect); a human decides each one.

export interface ProposalDeps {
  db: Db;
  boardBus: BoardBus;
}

export type ProposalFailure = { ok: false; status: number; code: ApiErrorCode; message: string };
export type ProposalResult<T> = ({ ok: true } & T) | ProposalFailure;

const fail = (status: number, code: ApiErrorCode, message: string): ProposalFailure => ({
  ok: false,
  status,
  code,
  message,
});
const notFound = (id: string) => fail(404, 'not_found', `no proposed ticket ${id}`);
const decided = (row: TicketProposalRow) =>
  fail(409, 'conflict', `this proposed ticket was already ${row.status}`);

export function toProposalDto(r: TicketProposalRow): TicketProposalDto {
  return {
    id: r.id,
    ticket_id: r.ticket_id,
    session_id: r.session_id,
    state: r.state,
    title: r.title,
    body: r.body,
    kind: r.kind,
    why: r.why,
    status: r.status,
    created_ticket_id: r.created_ticket_id,
    decided_by: r.decided_by,
    decided_at: r.decided_at?.toISOString() ?? null,
    created_at: r.created_at.toISOString(),
  };
}

/** The ticket's proposals, oldest first (the newest SESSION_PROPOSALS_LIMIT). */
export async function listProposals(
  q: Queryable,
  accountId: string,
  ticketId: string,
): Promise<TicketProposalDto[]> {
  const r = await q.query<TicketProposalRow>(
    'SELECT * FROM (SELECT * FROM ticket_proposal WHERE ticket_id = $1 AND account_id = $2 ' +
      'ORDER BY created_at DESC, id DESC LIMIT $3) p ORDER BY created_at, id',
    [ticketId, accountId, SESSION_PROPOSALS_LIMIT],
  );
  return r.rows.map(toProposalDto);
}

async function lockProposal(
  tx: Queryable,
  accountId: string,
  id: string,
): Promise<TicketProposalRow | undefined> {
  const r = await tx.query<TicketProposalRow>(
    'SELECT * FROM ticket_proposal WHERE id = $1 AND account_id = $2 FOR UPDATE',
    [id, accountId],
  );
  return r.rows[0];
}

/**
 * Queue a pending proposal as a new, independent ticket: the source ticket's repo, workflow,
 * required tags and machines; `kind` = edit ?? proposal ?? source ?? work; `priority` = edit ?? source.
 * One transaction (the proposal row locked, so two accepts make one ticket).
 */
export async function acceptProposal(
  deps: ProposalDeps,
  scope: AccountScope,
  id: string,
  edits: AcceptProposalRequest,
  actor: string,
  now: Date = new Date(),
): Promise<ProposalResult<{ proposal: TicketProposalDto; ticket: TicketDto }>> {
  if (!UuidSchema.safeParse(id).success) return notFound(id);
  const res = await withTransaction(
    deps.db,
    async (
      tx,
    ): Promise<
      ProposalResult<{ proposal: TicketProposalRow; ticket: TicketRow; events: BoardSseEvent[] }>
    > => {
      const row = await lockProposal(tx, scope.account_id, id);
      if (row === undefined) return notFound(id);
      if (row.status !== 'pending') return decided(row);
      const src = await tx.query<TicketRow>('SELECT * FROM ticket WHERE id = $1', [row.ticket_id]);
      const source = src.rows[0];
      if (source === undefined) return notFound(id);
      const ticket = (await insertTicketRow(tx, {
        account_id: row.account_id,
        external_ref: null,
        repo: source.repo,
        title: edits.title ?? row.title,
        body: edits.body ?? row.body,
        workflow_id: source.workflow_id,
        required_tags: source.required_tags,
        repo_allow_machines: source.repo_allow_machines,
        priority: edits.priority ?? source.priority,
        // A pre-ADR-0011 source has no kind: `work` (its rules are the stricter ones).
        kind: edits.kind ?? row.kind ?? source.kind ?? 'work',
      }))!;
      const upd = await tx.query<TicketProposalRow>(
        "UPDATE ticket_proposal SET status = 'accepted', created_ticket_id = $2, " +
          'decided_by = $3, decided_at = $4 WHERE id = $1 RETURNING *',
        [row.id, ticket.id, actor, now],
      );
      // Last write of the transaction (insertBoardEvents holds the board lock to COMMIT).
      const events = await sessionlessCardUpserted(tx, { ...ticket, agent_name: null });
      return { ok: true, proposal: upd.rows[0]!, ticket, events };
    },
  );
  if (!res.ok) return res;
  for (const ev of res.events) deps.boardBus.publish(ev);
  const dto = toTicketDto(res.ticket);
  if (!(await accountHasRepo(deps.db, scope.account_id, res.ticket.repo))) {
    dto.warnings = ['no_machine_has_repo'];
  }
  return { ok: true, proposal: toProposalDto(res.proposal), ticket: dto };
}

/** Dismiss a pending proposal. */
export async function dismissProposal(
  db: Db,
  scope: AccountScope,
  id: string,
  actor: string,
  now: Date = new Date(),
): Promise<ProposalResult<{ proposal: TicketProposalDto }>> {
  if (!UuidSchema.safeParse(id).success) return notFound(id);
  return withTransaction(
    db,
    async (tx): Promise<ProposalResult<{ proposal: TicketProposalDto }>> => {
      const row = await lockProposal(tx, scope.account_id, id);
      if (row === undefined) return notFound(id);
      if (row.status !== 'pending') return decided(row);
      const upd = await tx.query<TicketProposalRow>(
        "UPDATE ticket_proposal SET status = 'dismissed', decided_by = $2, decided_at = $3 " +
          'WHERE id = $1 RETURNING *',
        [row.id, actor, now],
      );
      return { ok: true, proposal: toProposalDto(upd.rows[0]!) };
    },
  );
}
