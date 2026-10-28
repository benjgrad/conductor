import { randomUUID } from 'node:crypto';
import {
  apply as sharedApply,
  commandPayloadForEffect,
  sessionBranch,
  toBoardCard,
  type ApplyFn,
  type BoardCard,
  type BoardSseEventDraft,
  type EngineEvent,
  type JsonObject,
  type MachineCommandEffect,
  type SessionSnapshot,
} from '@conductor/shared';
import {
  insertBoardEvents,
  type ApplyEventOptions,
  type ApplyEventResult,
  type BoardBus,
  type EngineService,
  type Queryable,
} from '../contracts.js';
import { withTransaction } from '../db/index.js';
import type { InputRequestRow } from '../db/types.js';
import type { Db } from '../main.js';
import { expireOnApply, readCardPermission, withPermission } from '../permissions/store.js';
import { CardViews } from './board-view.js';
import {
  DefinitionCache,
  lockSession,
  readOpenInput,
  readSession,
  readTicket,
  toSnapshot,
  writeSession,
} from './rows.js';

/** Session statuses after which apply ignores every event. */
const TERMINAL: ReadonlySet<string> = new Set(['done', 'failed', 'lost']);

// The transactional shell around the pure apply() (M1-T04b; 05 §Execution, 10-contracts
// §EngineService wrapper, §Board events). One transaction:
//   lock session → fencing check → input.provided checks → apply → engine event row →
//   wrapper writes (ids, outbox, input_request, ticket, started columns, token bump) →
//   UPDATE session → board rows (insertBoardEvents, last) → COMMIT → BoardBus.publish.

export interface EngineServiceCoreDeps {
  db: Db;
  boardBus: BoardBus;
  now: () => Date;
  /** The pure FSM step; defaults to the shared export (M1-T04a). */
  apply?: ApplyFn;
  /** Called after a wrapper-owned COMMIT that wrote outbox rows (wakes the dispatcher). */
  onOutboxWritten?: () => void;
}

/**
 * The engine event row's payload: the event minus `type` (+ the ignore reason, if any).
 * Raw command output never goes in an event row (02-data-model §event, ADR-0003):
 * `command.exited.output_tail` is replaced by its UTF-8 byte length, `output_tail_bytes`, and
 * `agent.exited.stderr_tail` by `stderr_tail_bytes` (stderr may carry secrets; only apply's
 * clipped last line reaches the failure question).
 */
function eventPayload(event: EngineEvent, ignored: string | null): JsonObject {
  const payload = JSON.parse(JSON.stringify(event)) as JsonObject;
  delete payload.type;
  if (event.type === 'command.exited') {
    delete payload.output_tail;
    payload.output_tail_bytes = Buffer.byteLength(event.output_tail, 'utf8');
  }
  if (event.type === 'agent.exited' && event.stderr_tail !== undefined) {
    delete payload.stderr_tail;
    payload.stderr_tail_bytes = Buffer.byteLength(event.stderr_tail, 'utf8');
  }
  if (ignored !== null) payload.ignored = ignored;
  return payload;
}

/** BoardCard minus `updated_at` (which moves on every applied event), for change detection. */
function cardKey(card: BoardCard): string {
  return JSON.stringify({ ...card, updated_at: null });
}

export class EngineServiceImpl implements EngineService {
  private readonly defs = new DefinitionCache();
  private readonly applyFn: ApplyFn;

  constructor(private readonly deps: EngineServiceCoreDeps) {
    this.applyFn = deps.apply ?? sharedApply;
  }

  async applyEvent(
    sessionId: string,
    event: EngineEvent,
    opts: ApplyEventOptions = {},
  ): Promise<ApplyEventResult> {
    if (opts.tx) {
      const { result } = await this.applyInTx(opts.tx, sessionId, event, opts);
      return result; // caller publishes result.boardEvents after its COMMIT
    }
    const { result, wroteOutbox } = await withTransaction(this.deps.db, (tx) =>
      this.applyInTx(tx, sessionId, event, opts),
    );
    if (result.status === 'applied') {
      for (const ev of result.boardEvents) this.deps.boardBus.publish(ev);
    }
    if (wroteOutbox) this.deps.onOutboxWritten?.();
    return result;
  }

  private async applyInTx(
    tx: Queryable,
    sessionId: string,
    event: EngineEvent,
    opts: ApplyEventOptions,
  ): Promise<{ result: ApplyEventResult; wroteOutbox: boolean }> {
    const rejected = (reason: Extract<ApplyEventResult, { status: 'rejected' }>['reason']) => ({
      result: { status: 'rejected' as const, reason },
      wroteOutbox: false,
    });

    const locked = await lockSession(tx, sessionId);
    if (!locked) return rejected('unknown_session');
    const { session, ticket } = locked;
    if (opts.fencingToken !== undefined && opts.fencingToken < Number(session.fencing_token)) {
      return rejected('stale_fencing_token');
    }
    const def = await this.defs.get(tx, session.workflow_id, session.workflow_version);

    let inputRow: InputRequestRow | null = null;
    if (event.type === 'input.provided') {
      const r = await tx.query<InputRequestRow>(
        'SELECT * FROM input_request WHERE id = $1 AND session_id = $2 FOR UPDATE',
        [event.input_request_id, sessionId],
      );
      inputRow = r.rows[0] ?? null;
      if (!inputRow) return rejected('input_request_not_found');
      if (inputRow.answer !== null) return rejected('input_already_answered');
      if (event.goto !== undefined && !(event.goto in def.states)) return rejected('invalid_goto');
    }

    const now = this.deps.now();
    const before = toSnapshot(session, ticket);
    // ADR-0010: the card's column comes from the board's columns and the pinned definition.
    const view = await new CardViews(tx, this.defs).view(
      session.workflow_id,
      session.workflow_version,
    );
    const cardBefore = withPermission(
      toBoardCard(ticket, session, await readOpenInput(tx, sessionId), view),
      await readCardPermission(tx, sessionId),
    );
    const res = this.applyFn(def, before, event, now);

    const ev = await tx.query<{ id: string }>(
      'INSERT INTO event (session_id, type, payload, fencing_token) VALUES ($1, $2, $3, $4) ' +
        'RETURNING id',
      [
        sessionId,
        event.type,
        JSON.stringify(eventPayload(event, res.ignored)),
        opts.fencingToken ?? null,
      ],
    );
    const eventId = Number(ev.rows[0]!.id);
    if (res.ignored !== null) {
      return {
        result: { status: 'ignored', eventId, reason: res.ignored, snapshot: before },
        wroteOutbox: false,
      };
    }

    // ---- wrapper-owned writes (10-contracts §EngineService wrapper)
    const s1: SessionSnapshot = structuredClone(res.snapshot);
    let token = session.fencing_token;
    // Gate steps (ADR-0009 review, ADR-0010 entry) are fenced: entering, leaving or switching a
    // step bumps the token, so the worker process (between its complete_state and its exit) can
    // never report into the step (e.g. supply the reviewer's verdict), and a finished reviewer
    // can never report into the worker's next visit. Their late events are stale_fencing_token
    // (the gateway kills them); every command of this apply carries the new token.
    const stepFenced =
      (before.step !== null || s1.step !== null) &&
      (before.step === null || s1.step === null || before.workflow_state !== s1.workflow_state);
    // BUG-1: a session that becomes terminal is fenced, so a process still running for it is
    // stale and the heartbeat backstop kills it (10-contracts §Orphaned processes rules 4, 6).
    // M2-T20 owns this fencing list.
    const becameTerminal = !TERMINAL.has(before.status) && TERMINAL.has(s1.status);
    if (
      (event.type === 'command.refused' && event.command_kind === 'start_session') ||
      // A fresh conversation replaces the parked agent: its old process (killed by apply) is
      // stale, so nothing it still sends can reach the new visit (10-contracts §Fresh conversation).
      event.type === 'human.fresh_conversation' ||
      stepFenced ||
      becameTerminal
    ) {
      const r = await tx.query<{ t: string }>("SELECT nextval('fencing_seq')::text AS t");
      token = r.rows[0]!.t;
    }
    s1.fencing_token = Number(token);

    const drafts: BoardSseEventDraft[] = [];
    const commands: { effect: MachineCommandEffect; commandId: string }[] = [];
    for (const effect of res.effects) {
      switch (effect.type) {
        case 'start_session': {
          const commandId = randomUUID();
          s1.agent_command_id = commandId;
          s1.agent_process_live = false;
          commands.push({ effect, commandId });
          break;
        }
        case 'send_input':
        case 'send_message':
        case 'run_cmd':
        case 'run_action':
        case 'kill':
          commands.push({ effect, commandId: randomUUID() });
          break;
        case 'connector_call':
          // TD: connectors are not in M1 (10-contracts); the row is written for the record and
          // never dispatched (the dispatcher only sends `machine:` targets).
          await tx.query(
            'INSERT INTO outbox (command_id, target, kind, session_id, payload, idempotency_key) ' +
              "VALUES ($1, $2, 'connector_call', $3, $4, $5)",
            [
              randomUUID(),
              `connector:${effect.actions[0]!.split('.')[0]!}`,
              sessionId,
              JSON.stringify({ state: effect.state, actions: effect.actions, args: effect.args }),
              effect.idempotency_key,
            ],
          );
          break;
        case 'create_input_request': {
          const r = await tx.query<InputRequestRow>(
            'INSERT INTO input_request (id, session_id, kind, question, return_to, created_at) ' +
              'VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [randomUUID(), sessionId, effect.kind, effect.question, effect.return_to, now],
          );
          const row = r.rows[0]!;
          drafts.push({
            type: 'input.requested',
            session_id: sessionId,
            input_request_id: row.id,
            kind: row.kind,
            question: row.question,
            created_at: row.created_at.toISOString(),
          });
          break;
        }
        case 'set_deadline':
          if (effect.state === s1.workflow_state) s1.state_deadline = effect.deadline;
          break;
        case 'state_entered':
          await tx.query(
            "INSERT INTO event (session_id, type, payload) VALUES ($1, 'state.entered', $2)",
            [
              sessionId,
              // ADR-0011: the move's transition, reason and actor when apply set them
              // (StateEnteredPayload; the detail panel's `moves`, absent ≡ null).
              JSON.stringify({
                from: effect.from,
                to: effect.to,
                visit: effect.visit,
                ...(effect.transition !== undefined ? { transition: effect.transition } : {}),
                ...(effect.reason !== undefined ? { reason: effect.reason } : {}),
                ...(effect.actor !== undefined ? { actor: effect.actor } : {}),
              }),
            ],
          );
          break;
        case 'conversation_reset':
          // Audit only (ConversationResetPayload): a start refused `no_conversation`, or a human's
          // "Start fresh conversation…", made apply forget the Claude conversation; the next start
          // is a fresh one.
          await tx.query(
            "INSERT INTO event (session_id, type, payload) VALUES ($1, 'conversation.reset', $2)",
            [
              sessionId,
              JSON.stringify({
                claude_session_id: effect.claude_session_id,
                reason: effect.reason,
              }),
            ],
          );
          break;
        case 'session_status':
          drafts.push({
            type: 'session.status',
            session_id: sessionId,
            from: effect.from,
            to: effect.to,
            workflow_state: s1.workflow_state,
          });
          break;
        case 'ticket_status':
          await tx.query('UPDATE ticket SET status = $2, updated_at = $3 WHERE id = $1', [
            ticket.id,
            effect.to,
            now,
          ]);
          break;
      }
    }

    if (event.type === 'session.started') {
      const { base, count } = event.port_range;
      await tx.query(
        'UPDATE session SET worktree_path = $2, branch = $3, ' +
          "port_range = int4range($4, $5, '[)') WHERE id = $1",
        [sessionId, event.worktree_path, event.branch, base, base + count],
      );
    }
    if (event.type === 'input.provided' && inputRow) {
      await tx.query(
        'UPDATE input_request SET answer = $2, answered_by = $3, answered_at = $4 WHERE id = $1',
        [inputRow.id, event.answer, opts.actor ?? null, now],
      );
      drafts.push({
        type: 'input.answered',
        session_id: sessionId,
        input_request_id: inputRow.id,
        answered_by: opts.actor ?? null,
      });
    }
    // ADR-0011: a human transition taken from a human state answers its open input_request
    // (answer = the text, else "[<name>]"; answered_by = the event's actor), like input.provided.
    // "Start fresh conversation…" answers it the same way (answer = the text).
    if (event.type === 'human.transition' || event.type === 'human.fresh_conversation') {
      const answerText =
        event.type === 'human.transition' ? (event.text ?? `[${event.name}]`) : event.text;
      const r = await tx.query<InputRequestRow>(
        'UPDATE input_request SET answer = $2, answered_by = $3, answered_at = $4 ' +
          'WHERE session_id = $1 AND answer IS NULL RETURNING *',
        [sessionId, answerText, event.actor, now],
      );
      for (const row of r.rows) {
        drafts.push({
          type: 'input.answered',
          session_id: sessionId,
          input_request_id: row.id,
          answered_by: event.actor,
        });
      }
    }

    await writeSession(tx, s1, token, now);
    // ADR-0023: a session that no longer holds its agent process expires its pending permission
    // requests here, so the card never shows a prompt nobody can answer (10-contracts §Permission
    // prompts, Expiry).
    await expireOnApply(tx, sessionId, event.type, before, s1, now);

    // Outbox rows after the session row is final: the payload sees the post-apply snapshot (and
    // the started branch), the row carries the post-apply token (10-contracts §Effect → WS).
    const branch =
      event.type === 'session.started'
        ? event.branch
        : (session.branch ?? sessionBranch(ticket.id, sessionId));
    // The start_session prompt is apply's, rendered by shared `renderPrompt` (U-040: the one
    // renderer); the wrapper never re-renders it.
    for (const { effect, commandId } of commands) {
      const cmd = commandPayloadForEffect(effect, {
        command_id: commandId,
        snapshot: s1,
        branch,
      });
      // ADR-0010: an entry action carries its idempotency key (session + state + visit).
      const idem = effect.type === 'run_action' ? effect.idempotency_key : null;
      await tx.query(
        'INSERT INTO outbox (command_id, target, kind, session_id, payload, fencing_token, ' +
          'next_attempt_at, created_at, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)',
        [commandId, cmd.target, cmd.kind, sessionId, JSON.stringify(cmd.payload), token, now, idem],
      );
    }

    // card.upserted last, if any card field changed.
    const cardAfter = withPermission(
      toBoardCard(
        await readTicket(tx, ticket.id),
        await readSession(tx, sessionId),
        await readOpenInput(tx, sessionId),
        view,
      ),
      await readCardPermission(tx, sessionId),
    );
    // ADR-0010: card.moved when the card's column (a state, or Queued / Done) changed.
    if (cardAfter.column !== cardBefore.column) {
      drafts.push({
        type: 'card.moved',
        session_id: sessionId,
        ticket_id: ticket.id,
        from: cardBefore.column,
        to: cardAfter.column,
      });
    }
    if (cardKey(cardAfter) !== cardKey(cardBefore)) {
      drafts.push({
        type: 'card.upserted',
        session_id: sessionId,
        ticket_id: ticket.id,
        card: cardAfter,
      });
    }
    const boardEvents = await insertBoardEvents(tx, drafts);

    return {
      result: { status: 'applied', eventId, snapshot: s1, effects: res.effects, boardEvents },
      wroteOutbox: commands.length > 0,
    };
  }
}
