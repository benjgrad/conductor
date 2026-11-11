import { CONDUCTOR_WORKFLOW_ID, LOCAL_ACCOUNT_ID } from '@conductor/shared';
import { insertTicketRow, latestSession, sessionlessCardUpserted } from '../api/tickets.js';
import { withTransaction } from '../db/index.js';
import { seedConductorWorkflow } from '../engine/seed.js';
import { TICKET_SELECT, type TicketCardRow } from '../engine/rows.js';
import type { Db } from '../main.js';
import { cardUpserted } from '../permissions/store.js';
import { enqueueDeployFailurePush } from '../push/enqueue.js';
import {
  attemptsInBody,
  deployAttemptSection,
  deployFailureNotification,
  deployPushKey,
  deployRef,
  deployTicketBody,
  deployTicketTitle,
  type DeployFailureReport,
} from './failure-report.js';

// R14 FR-2/FR-3: one ticket per failed sha (`external_ref = deploy:<sha>`) on the server's own
// account, and one push per failed attempt. Run by `conductor-admin deploy-failed`, in another
// process than the orchestrator: the outbox row is sent by the orchestrator's push dispatcher (it
// polls), the ticket is claimed by its queue, and the card event is in the event table.

/** The deploy ticket's queue priority (0–4, lower = sooner): ahead of routine work. */
export const DEPLOY_TICKET_PRIORITY = 1;

export interface RecordedDeployFailure {
  ticketId: string;
  created: boolean;
  attempt: number;
  /** Push rows written (0 when nobody subscribed, or this attempt was already recorded). */
  pushes: number;
}

export class NoAccountError extends Error {}

export async function recordDeployFailure(
  db: Db,
  report: DeployFailureReport,
  now: Date,
  accountId: string = LOCAL_ACCOUNT_ID,
): Promise<RecordedDeployFailure> {
  // ADR-0010: seeded on start too; a bare database (tests) needs it here.
  await seedConductorWorkflow(db, { log: null });
  const ref = deployRef(report.sha);
  return withTransaction(db, async (tx) => {
    const account = await tx.query('SELECT 1 FROM account WHERE id = $1', [accountId]);
    if (account.rowCount === 0) throw new NoAccountError(`no account ${accountId}`);
    // Two reports for one sha never both insert (deploys are serialised by flock anyway).
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ref]);
    const found = await tx.query<TicketCardRow>(
      TICKET_SELECT +
        'WHERE t.account_id = $1 AND t.external_ref = $2 ORDER BY t.created_at, t.id LIMIT 1 ' +
        'FOR UPDATE OF t',
      [accountId, ref],
    );
    const existing = found.rows[0];
    let row: TicketCardRow;
    let attempt: number;
    if (existing === undefined) {
      attempt = 1;
      const inserted = (await insertTicketRow(tx, {
        account_id: accountId,
        external_ref: ref,
        repo: report.repo,
        title: deployTicketTitle(report),
        body: deployTicketBody(report),
        workflow_id: CONDUCTOR_WORKFLOW_ID,
        required_tags: [],
        repo_allow_machines: null,
        priority: DEPLOY_TICKET_PRIORITY,
        kind: 'work',
        size: 'S',
      }))!;
      row = { ...inserted, agent_name: null };
    } else {
      attempt = attemptsInBody(existing.body) + 1;
      // The same report twice (a retried CLI call) adds no second attempt.
      const already = existing.body.includes(report.attempted_at);
      if (already) attempt -= 1;
      const res = await tx.query<TicketCardRow>(
        'UPDATE ticket SET title = $2, body = body || $3, updated_at = now() WHERE id = $1 ' +
          'RETURNING *',
        [
          existing.id,
          deployTicketTitle(report),
          already ? '' : deployAttemptSection(report, attempt),
        ],
      );
      row = { ...res.rows[0]!, agent_name: existing.agent_name };
    }
    const pushes = await enqueueDeployFailurePush(tx, {
      accountId,
      ticketId: row.id,
      notification: deployFailureNotification(row.id, report),
      idempotencyKey: deployPushKey(report.sha, attempt),
      now,
    });
    // Last write of the transaction (insertBoardEvents holds the board lock to COMMIT). A ticket
    // an agent already took has its card keyed by its session.
    const session = existing === undefined ? null : await latestSession(tx, row.id);
    if (session) await cardUpserted(tx, session.id);
    else await sessionlessCardUpserted(tx, row);
    return { ticketId: row.id, created: existing === undefined, attempt, pushes };
  });
}
