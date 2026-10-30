import {
  CONDUCTOR_WORKFLOW_ID,
  canonicalRepo,
  toBoardCard,
  type AccountScope,
  type ApiErrorCode,
  type CreateTicketRequestSchema,
  type TicketDto,
} from '@conductor/shared';
import type { z } from 'zod';
import type { AuthConfig } from '../auth/config.js';
import { insertBoardEvents, type BoardBus } from '../contracts.js';
import { withTransaction } from '../db/index.js';
import type { TicketRow } from '../db/types.js';
import { cardView, withMachineFields } from '../engine/board-view.js';
import { seedConductorWorkflow } from '../engine/seed.js';
import type { Db } from '../main.js';
import type { ErrorDetail } from './errors.js';
import { toTicketDto } from './queries.js';

// POST /api/tickets, as a function the REST route and the MCP `create_ticket` tool share
// (ADR-0028; ADR-0014 §1: tools add no rules of their own).

export type CreateTicketResult =
  | { ok: true; dto: TicketDto }
  | {
      ok: false;
      status: number;
      code: ApiErrorCode;
      message: string;
      details?: ErrorDetail[];
    };

export async function createTicket(
  deps: { db: Db; boardBus: BoardBus; auth: AuthConfig },
  scope: AccountScope,
  body: z.output<typeof CreateTicketRequestSchema>,
): Promise<CreateTicketResult> {
  const { db, boardBus, auth } = deps;
  // M2-T17 (U-048, ADR-0013 §Routing): in `password` mode the repo must be host/org/repo and is
  // stored canonical; `local` mode keeps M1's rule (the e2e's local fixture repos).
  let repo = body.repo;
  if (auth.mode === 'password') {
    const canonical = canonicalRepo(body.repo);
    if (canonical === null) {
      return {
        ok: false,
        status: 400,
        code: 'bad_request',
        message: 'repo must be host/org/repo',
        details: [
          { path: 'repo', message: 'expected host/org/repo (or an https / ssh git URL of one)' },
        ],
      };
    }
    repo = canonical;
  }
  // ADR-0010: `conductor` is seeded on startup; seeding here too keeps a bare database (tests,
  // a start that raced a migration) working. Idempotent.
  // Silent: the "newer default" notice is the start's (M1b-T09).
  if (body.workflow_id === CONDUCTOR_WORKFLOW_ID) await seedConductorWorkflow(db, { log: null });
  const known = await db.query('SELECT 1 FROM workflow_definition WHERE id = $1 LIMIT 1', [
    body.workflow_id,
  ]);
  if (known.rowCount === 0) {
    return {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: `unknown workflow ${body.workflow_id}`,
      details: [{ path: 'workflow_id', message: 'no workflow with this id' }],
    };
  }
  const { ticket, events } = await withTransaction(db, async (tx) => {
    const res = await tx.query<TicketRow>(
      'INSERT INTO ticket (external_ref, repo, title, body, workflow_id, required_tags, ' +
        'repo_allow_machines, priority, kind, account_id) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
      [
        body.external_ref,
        repo,
        body.title,
        body.body,
        body.workflow_id,
        body.required_tags,
        body.repo_allow_machines,
        body.priority,
        body.kind,
        scope.account_id,
      ],
    );
    const row = res.rows[0]!;
    // Last write of the transaction (insertBoardEvents holds the board lock to COMMIT).
    const evs = await insertBoardEvents(tx, [
      {
        type: 'card.upserted',
        session_id: null,
        ticket_id: row.id,
        // UX-13a: a new ticket holds no agent until a claim starts it.
        card: await withMachineFields(
          tx,
          toBoardCard(
            { ...row, agent_name: null },
            null,
            null,
            await cardView(tx, row.workflow_id, null),
          ),
          row,
        ),
      },
    ]);
    return { ticket: row, events: evs };
  });
  for (const ev of events) boardBus.publish(ev);
  // U-048: a ticket for a repo no machine of the account has is created, and flagged. Offline
  // machines count (routing per online machine is the card's, M2-T16); revoked ones don't.
  // github.com org/repo compares case-insensitively; `r.repo` keeps M1 local-mode rows matching.
  const has = await db.query(
    'SELECT 1 FROM machine_repo r JOIN machine m ON m.id = r.machine_id ' +
      'WHERE r.account_id = $1 AND m.revoked_at IS NULL ' +
      'AND (lower(r.remote) = lower($2) OR r.repo = $3) LIMIT 1',
    [scope.account_id, canonicalRepo(ticket.repo) ?? ticket.repo, ticket.repo],
  );
  const dto: TicketDto = toTicketDto(ticket);
  if (has.rowCount === 0) dto.warnings = ['no_machine_has_repo'];
  return { ok: true, dto };
}
