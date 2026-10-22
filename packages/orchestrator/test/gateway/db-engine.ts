/**
 * A minimal DB-backed EngineService for the gateway integration tests (M1-T11), standing in for
 * the real one (M1-T04) on the paths the gateway drives: `session.assigned` (queued → assigned,
 * start_session outbox row), start_session `command.refused` (→ queued, ticket ready, token
 * bump, U-025 ignore rule), `session.started` (command_id match → running) and the fencing
 * check. Every other event is `applied` with no writes. Records every call.
 */
import { randomUUID } from 'node:crypto';
import { commandPayloadForEffect, type EngineEvent, type SessionSnapshot } from '@conductor/shared';
import {
  insertBoardEvents,
  type ApplyEventOptions,
  type ApplyEventResult,
  type EngineService,
  type Queryable,
} from '../../src/contracts.js';
import type { SessionRow, TicketRow } from '../../src/db/types.js';
import type { Db } from '../../src/main.js';

export const START_STATE = 'implement';

export class DbTestEngine implements EngineService {
  readonly calls: { sessionId: string; event: EngineEvent; opts: ApplyEventOptions }[] = [];

  constructor(private readonly db: Db) {}

  async applyEvent(
    sessionId: string,
    event: EngineEvent,
    opts: ApplyEventOptions = {},
  ): Promise<ApplyEventResult> {
    this.calls.push({ sessionId, event, opts });
    if (opts.tx) return this.run(opts.tx, sessionId, event, opts);
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const res = await this.run(client, sessionId, event, opts);
      await client.query('COMMIT');
      return res;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async run(
    tx: Queryable,
    sessionId: string,
    event: EngineEvent,
    opts: ApplyEventOptions,
  ): Promise<ApplyEventResult> {
    const s = await tx.query<SessionRow>('SELECT * FROM session WHERE id = $1 FOR UPDATE', [
      sessionId,
    ]);
    const row = s.rows[0];
    if (!row) return { status: 'rejected', reason: 'unknown_session' };
    if (opts.fencingToken !== undefined && opts.fencingToken < Number(row.fencing_token)) {
      return { status: 'rejected', reason: 'stale_fencing_token' };
    }
    const t = await tx.query<TicketRow>('SELECT * FROM ticket WHERE id = $1', [row.ticket_id]);
    const ticket = t.rows[0]!;
    const ev = await tx.query<{ id: string }>(
      'INSERT INTO event (session_id, type, payload) VALUES ($1, $2, $3) RETURNING id',
      [sessionId, event.type, JSON.stringify(event)],
    );
    const eventId = Number(ev.rows[0]!.id);
    const ignored = (reason: 'wrong_status' | 'command_id_mismatch'): ApplyEventResult => ({
      status: 'ignored',
      eventId,
      reason,
      snapshot: toSnapshot(row, ticket),
    });

    switch (event.type) {
      case 'session.assigned': {
        if (row.status !== 'queued') return ignored('wrong_status');
        const commandId = randomUUID();
        const u = await tx.query<SessionRow>(
          `UPDATE session SET status = 'assigned', machine_id = $2,
                  workflow_state = COALESCE(workflow_state, $3), agent_command_id = $4,
                  agent_process_live = false, updated_at = now()
            WHERE id = $1 RETURNING *`,
          [sessionId, event.machine_id, START_STATE, commandId],
        );
        const snapshot = toSnapshot(u.rows[0]!, ticket);
        const cmd = commandPayloadForEffect(
          {
            type: 'start_session',
            state: snapshot.workflow_state!,
            prompt: ticket.title,
            tools: ['read', 'edit'],
            resume_claude_session_id: null,
          },
          { command_id: commandId, snapshot, branch: row.branch! },
        );
        await tx.query(
          `INSERT INTO outbox (command_id, target, kind, session_id, payload, fencing_token)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            commandId,
            cmd.target,
            cmd.kind,
            sessionId,
            JSON.stringify(cmd.payload),
            row.fencing_token,
          ],
        );
        const boardEvents = await insertBoardEvents(tx, [
          {
            type: 'session.status',
            session_id: sessionId,
            from: 'queued',
            to: 'assigned',
            workflow_state: snapshot.workflow_state,
          },
        ]);
        return { status: 'applied', eventId, snapshot, effects: [], boardEvents };
      }
      case 'command.refused': {
        if (event.command_kind !== 'start_session') break;
        if (row.agent_command_id !== event.command_id || row.agent_process_live) {
          return ignored('command_id_mismatch');
        }
        const u = await tx.query<SessionRow>(
          `UPDATE session SET status = 'queued', machine_id = NULL, agent_command_id = NULL,
                  agent_process_live = false, fencing_token = nextval('fencing_seq'),
                  updated_at = now()
            WHERE id = $1 RETURNING *`,
          [sessionId],
        );
        await tx.query(`UPDATE ticket SET status = 'ready' WHERE id = $1`, [ticket.id]);
        return {
          status: 'applied',
          eventId,
          snapshot: toSnapshot(u.rows[0]!, ticket),
          effects: [],
          boardEvents: [],
        };
      }
      case 'session.started': {
        if (row.agent_command_id !== event.command_id) return ignored('command_id_mismatch');
        const u = await tx.query<SessionRow>(
          `UPDATE session SET status = 'running', agent_process_live = true WHERE id = $1
           RETURNING *`,
          [sessionId],
        );
        return {
          status: 'applied',
          eventId,
          snapshot: toSnapshot(u.rows[0]!, ticket),
          effects: [],
          boardEvents: [],
        };
      }
      default:
        break;
    }
    return {
      status: 'applied',
      eventId,
      snapshot: toSnapshot(row, ticket),
      effects: [],
      boardEvents: [],
    };
  }
}

function toSnapshot(row: SessionRow, ticket: TicketRow): SessionSnapshot {
  return {
    id: row.id,
    ticket: {
      id: ticket.id,
      title: ticket.title,
      body: ticket.body,
      repo: ticket.repo,
      external_ref: ticket.external_ref,
    },
    machine_id: row.machine_id,
    workflow_id: row.workflow_id,
    workflow_version: row.workflow_version,
    workflow_state: row.workflow_state,
    status: row.status,
    fencing_token: Number(row.fencing_token),
    claude_session_id: row.claude_session_id,
    agent_command_id: row.agent_command_id,
    agent_process_live: row.agent_process_live,
    pending_answer: row.pending_answer,
    retry_counters: row.retry_counters,
    state_visits: row.state_visits,
    state_entered_at: row.state_entered_at.toISOString(),
    state_deadline: row.state_deadline?.toISOString() ?? null,
    return_to: row.return_to,
    spend_usd: Number(row.spend_usd),
    claude_spend_totals: row.claude_spend_totals,
    wall_seconds: Number(row.wall_seconds),
    context: row.context,
  };
}
