import {
  proposalTicketBody,
  type AccountScope,
  type ApiErrorCode,
  type ApproveProposalResponse,
  type BoardSseEvent,
  type TicketDto,
  type TicketProposal,
} from '@conductor/shared';
import type { AuthConfig } from '../auth/config.js';
import type { BoardBus, Queryable } from '../contracts.js';
import { withTransaction } from '../db/index.js';
import type { SessionRow, TicketRow } from '../db/types.js';
import { loadProposals } from '../engine/proposals.js';
import { TICKET_SELECT, type TicketCardRow } from '../engine/rows.js';
import type { Db } from '../main.js';
import { cardUpserted } from '../permissions/store.js';
import type { ErrorDetail } from './errors.js';
import { toTicketDto } from './queries.js';
import {
  accountHasRepo,
  insertTicketRow,
  prepareNewTicket,
  sessionlessCardUpserted,
} from './tickets.js';

// 06 §Proposed tickets: a person approves (a real ticket is created) or dismisses a follow-up
// ticket an agent proposed. Neither touches the parent's session: it keeps waiting for its own
// answer or transition. Both are idempotent on the proposal id (`ticket_proposal_decision`'s
// primary key), decided under the parent's latest session row lock.

type Failure = {
  ok: false;
  status: number;
  code: ApiErrorCode;
  message: string;
  details?: ErrorDetail[];
};

export type ApproveProposalResult =
  { ok: true; status: 200 | 201; response: ApproveProposalResponse } | Failure;

export type DismissProposalResult = { ok: true; proposal: TicketProposal } | Failure;

interface ProposalDeps {
  db: Db;
  boardBus: BoardBus;
  auth: AuthConfig;
}

const notFound = (message: string): Failure => ({
  ok: false,
  status: 404,
  code: 'not_found',
  message,
});

/** The account's ticket (null when it is another account's or missing). */
async function readParent(
  q: Queryable,
  ticketId: string,
  accountId: string,
): Promise<TicketCardRow | null> {
  const r = await q.query<TicketCardRow>(TICKET_SELECT + 'WHERE t.id = $1 AND t.account_id = $2', [
    ticketId,
    accountId,
  ]);
  return r.rows[0] ?? null;
}

/** The ticket's latest session, locked (every decision on the ticket's proposals takes it). */
async function lockLatestSession(q: Queryable, ticketId: string): Promise<SessionRow | null> {
  const r = await q.query<SessionRow>(
    'SELECT * FROM session WHERE id = (SELECT id FROM session WHERE ticket_id = $1 ' +
      'ORDER BY created_at DESC LIMIT 1) FOR UPDATE',
    [ticketId],
  );
  return r.rows[0] ?? null;
}

/** The proposal (with its decision) of the ticket's latest session, read without locks. */
async function findProposal(
  q: Queryable,
  ticketId: string,
  proposalId: string,
): Promise<TicketProposal | null> {
  const r = await q.query<SessionRow>(
    'SELECT * FROM session WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 1',
    [ticketId],
  );
  const proposals = await loadProposals(q, ticketId, r.rows[0] ?? null);
  return proposals.find((p) => p.id === proposalId) ?? null;
}

export async function approveProposal(
  deps: ProposalDeps,
  scope: AccountScope,
  ticketId: string,
  req: { proposal_id: string; title?: string | undefined; body?: string | undefined },
): Promise<ApproveProposalResult> {
  const { db, boardBus } = deps;
  const parent = await readParent(db, ticketId, scope.account_id);
  if (!parent) return notFound('no such ticket');
  const proposal = await findProposal(db, ticketId, req.proposal_id);
  if (!proposal) return notFound('no such proposal on this ticket');
  // Already approved: the same answer again, before checking a repo that may since have changed.
  if (proposal.status === 'approved') {
    const created = await approvedResponse(db, proposal);
    if (created) return created;
  }
  // The repo and workflow checks of POST /api/tickets (nothing is written when they fail).
  const prepared = await prepareNewTicket(deps, {
    repo: proposal.repo,
    workflow_id: parent.workflow_id,
  });
  if (!prepared.ok) return prepared;

  const outcome = await withTransaction(db, async (tx) => {
    const session = await lockLatestSession(tx, ticketId);
    // Re-read under the lock: a concurrent approve or dismiss, or a newer session, wins.
    const current = (await loadProposals(tx, ticketId, session)).find(
      (p) => p.id === req.proposal_id,
    );
    if (!session || !current) return { kind: 'gone' as const };
    if (current.status === 'dismissed') return { kind: 'dismissed' as const };
    if (current.status === 'approved') return { kind: 'approved' as const, proposal: current };
    const row = (await insertTicketRow(tx, {
      account_id: scope.account_id,
      external_ref: null,
      repo: prepared.repo,
      title: req.title ?? current.title,
      body: req.body ?? proposalTicketBody(current, parent),
      workflow_id: parent.workflow_id,
      required_tags: [],
      repo_allow_machines: null,
      priority: 0,
      // A ticket from before M1b has no kind (matches both); the follow-up stays the same.
      kind: parent.kind ?? 'work',
    }))!;
    await tx.query(
      'INSERT INTO ticket_proposal_decision ' +
        '(ticket_id, proposal_id, account_id, status, created_ticket_id) ' +
        "VALUES ($1, $2, $3, 'approved', $4)",
      [ticketId, current.id, scope.account_id, row.id],
    );
    // Last writes of the transaction (insertBoardEvents holds the board lock to COMMIT).
    const events: BoardSseEvent[] = [
      ...(await sessionlessCardUpserted(tx, { ...row, agent_name: null })),
      ...(await cardUpserted(tx, session.id)),
    ];
    return {
      kind: 'created' as const,
      row,
      events,
      proposal: { ...current, status: 'approved' as const, created_ticket_id: row.id },
    };
  });

  switch (outcome.kind) {
    case 'gone':
      return notFound('no such proposal on this ticket');
    case 'dismissed':
      return {
        ok: false,
        status: 409,
        code: 'conflict',
        message: 'the proposal was dismissed',
      };
    case 'approved':
      return (
        (await approvedResponse(db, outcome.proposal)) ?? {
          ok: false,
          status: 409,
          code: 'conflict',
          message: 'the proposal was approved, but its ticket no longer exists',
        }
      );
    case 'created': {
      for (const ev of outcome.events) boardBus.publish(ev);
      const ticket: TicketDto = toTicketDto(outcome.row);
      if (!(await accountHasRepo(db, scope.account_id, outcome.row.repo))) {
        ticket.warnings = ['no_machine_has_repo'];
      }
      return { ok: true, status: 201, response: { proposal: outcome.proposal, ticket } };
    }
  }
}

/** 200 with the ticket an earlier approval created; null when that ticket was deleted. */
async function approvedResponse(
  q: Queryable,
  proposal: TicketProposal,
): Promise<ApproveProposalResult | null> {
  if (proposal.created_ticket_id === null) return null;
  const r = await q.query<TicketRow & { schedule_name: string | null; agent_name: string | null }>(
    TICKET_SELECT + 'WHERE t.id = $1',
    [proposal.created_ticket_id],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    ok: true,
    status: 200,
    response: { proposal, ticket: toTicketDto(row, row.agent_name) },
  };
}

export async function dismissProposal(
  deps: ProposalDeps,
  scope: AccountScope,
  ticketId: string,
  proposalId: string,
): Promise<DismissProposalResult> {
  const { db, boardBus } = deps;
  const parent = await readParent(db, ticketId, scope.account_id);
  if (!parent) return notFound('no such ticket');
  const outcome = await withTransaction(db, async (tx) => {
    const session = await lockLatestSession(tx, ticketId);
    const current = (await loadProposals(tx, ticketId, session)).find((p) => p.id === proposalId);
    if (!session || !current) return { kind: 'gone' as const };
    if (current.status === 'approved') return { kind: 'approved' as const };
    if (current.status === 'dismissed')
      return { kind: 'done' as const, proposal: current, events: [] };
    await tx.query(
      'INSERT INTO ticket_proposal_decision (ticket_id, proposal_id, account_id, status) ' +
        "VALUES ($1, $2, $3, 'dismissed') ON CONFLICT (ticket_id, proposal_id) DO NOTHING",
      [ticketId, current.id, scope.account_id],
    );
    // Last write of the transaction: the parent's card loses one from its count.
    const events = await cardUpserted(tx, session.id);
    return {
      kind: 'done' as const,
      proposal: { ...current, status: 'dismissed' as const },
      events,
    };
  });
  switch (outcome.kind) {
    case 'gone':
      return notFound('no such proposal on this ticket');
    case 'approved':
      return { ok: false, status: 409, code: 'conflict', message: 'the proposal was approved' };
    case 'done':
      for (const ev of outcome.events) boardBus.publish(ev);
      return { ok: true, proposal: outcome.proposal };
  }
}
