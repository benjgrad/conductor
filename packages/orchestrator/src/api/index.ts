import {
  API_PATHS,
  AnswerInputRequestSchema,
  CONDUCTOR_WORKFLOW_ID,
  ApproveSessionRequestSchema,
  CancelSessionRequestSchema,
  CreateTicketRequestSchema,
  ReopenSessionRequestSchema,
  SaveWorkflowRequestSchema,
  SendMessageRequestSchema,
  TransitionSessionRequestSchema,
  UuidSchema,
  httpForApplyResult,
  toBoardCard,
  validateWorkflow,
  type EngineEvent,
  type EngineRoute,
  type OkResponse,
  type ReopenSessionResponse,
  type TranscriptResponse,
} from '@conductor/shared';
import Fastify, { type FastifyReply } from 'fastify';
import { insertBoardEvents, type ApplyEventOptions } from '../contracts.js';
import { withTransaction } from '../db/index.js';
import type { TicketRow } from '../db/types.js';
import { cardView } from '../engine/board-view.js';
import { reopenSession } from '../engine/reopen.js';
import { conductorDefaultAvailable, seedConductorWorkflow } from '../engine/seed.js';
import type { CreateApi } from '../main.js';
import { parseLastEventId, serveBoardStream } from '../stream/board.js';
import { serveOutputStream } from '../stream/output.js';
import { SseHub } from '../stream/sse.js';
import { parseBody, pathString, sendError } from './errors.js';
import {
  listMachines,
  listWorkflows,
  loadBoard,
  loadWorkflowDetail,
  toTicketDto,
} from './queries.js';
import {
  HttpGuard,
  httpSecurityFromEnv,
  securityHook,
  type HttpSecurityOptions,
} from './security.js';
import { loadSessionDetail, sessionExists } from './sessions.js';

// M1-T08: REST + SSE for the UI (03 §UI ↔ orchestrator), as the `CreateApi` factory (main.ts).

/** Recorded as `input_request.answered_by` for answers from the web UI (no auth in M1, 09). */
export const UI_ACTOR = 'ui';

const OK: OkResponse = { ok: true };
const PG_UNIQUE_VIOLATION = '23505';

type IdParams = { Params: { id: string } };

export {
  HttpGuard,
  httpSecurityFromEnv,
  securityHook,
  type HttpSecurityOptions,
} from './security.js';

export interface ApiOptions {
  /** Host / Origin allow-lists (M1-T14). Default: httpSecurityFromEnv(process.env). */
  security?: HttpSecurityOptions;
}

type ApiDeps = Parameters<CreateApi>[0] & ApiOptions;

export const createApi = (({ db, engine, boardBus, outputBus, transcripts, security }: ApiDeps) => {
  const app = Fastify({ logger: false });
  // M1-T14: Host / Origin / content-type guard before routing (09 §M1 local hardening).
  app.addHook('onRequest', securityHook(new HttpGuard(security ?? httpSecurityFromEnv())));
  const hub = new SseHub();
  const logError = (err: unknown) => app.log.error(err);

  // JSON bodies; an empty body (POST /cancel with no payload) is `{}`.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(text) as unknown);
    } catch {
      const err = new Error('body is not valid JSON') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.setNotFoundHandler((req, reply) =>
    sendError(reply, 404, 'not_found', `no route ${req.method} ${req.url}`),
  );
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) return sendError(reply, status, 'bad_request', err.message);
    logError(err);
    return sendError(reply, 500, 'internal', 'internal error');
  });

  /** A valid uuid or a 404 sent (ids are uuid columns; anything else can't exist). */
  const sessionId = (id: string, reply: FastifyReply): string | undefined => {
    if (UuidSchema.safeParse(id).success) return id;
    void sendError(reply, 404, 'not_found', `session ${id} not found`);
    return undefined;
  };

  // ---------------------------------------------------------------- board

  app.get(API_PATHS.board, () => loadBoard(db));

  // ---------------------------------------------------------------- sessions

  app.get<IdParams>('/api/sessions/:id', async (req, reply) => {
    const id = sessionId(req.params.id, reply);
    if (id === undefined) return reply;
    const detail = await loadSessionDetail(db, outputBus, id);
    if (!detail) return sendError(reply, 404, 'not_found', `session ${id} not found`);
    return detail;
  });

  /** Apply one engine event for a REST route and map the result (10-contracts §REST error map). */
  const applyFromRoute = async (
    reply: FastifyReply,
    route: EngineRoute,
    id: string,
    event: EngineEvent,
    opts: ApplyEventOptions = {},
  ) => {
    const result = await engine.applyEvent(id, event, opts);
    if (result.status === 'applied') return reply.code(202).send(OK);
    const { status, code } = httpForApplyResult(route, result);
    return sendError(reply, status, code, `${event.type}: ${result.reason}`);
  };

  app.post<IdParams>('/api/sessions/:id/input', async (req, reply) => {
    const id = sessionId(req.params.id, reply);
    if (id === undefined) return reply;
    const body = parseBody(AnswerInputRequestSchema, req.body, reply);
    if (!body) return reply;
    const event: EngineEvent = {
      type: 'input.provided',
      input_request_id: body.input_request_id,
      answer: body.answer,
      ...(body.goto !== undefined ? { goto: body.goto } : {}),
    };
    return applyFromRoute(reply, 'input', id, event, { actor: UI_ACTOR });
  });

  /**
   * ADR-0011: a human takes a transition (a card button) → `human.transition {name, text, actor:
   * 'ui'}`. The open input_request (if any) rides along so apply can answer a parked agent with
   * `send_input` (10-contracts §Pending answer); the wrapper closes it either way.
   */
  app.post<IdParams>(API_PATHS.sessionTransition(':id'), async (req, reply) => {
    const id = sessionId(req.params.id, reply);
    if (id === undefined) return reply;
    const body = parseBody(TransitionSessionRequestSchema, req.body, reply);
    if (!body) return reply;
    const open = await db.query<{ id: string }>(
      'SELECT id FROM input_request WHERE session_id = $1 AND answer IS NULL ' +
        'ORDER BY created_at DESC LIMIT 1',
      [id],
    );
    const event: EngineEvent = {
      type: 'human.transition',
      name: body.name,
      text: body.text ?? null,
      actor: UI_ACTOR,
      input_request_id: open.rows[0]?.id ?? null,
    };
    return applyFromRoute(reply, 'transition', id, event);
  });

  app.post<IdParams>('/api/sessions/:id/approve', async (req, reply) => {
    const id = sessionId(req.params.id, reply);
    if (id === undefined) return reply;
    const body = parseBody(ApproveSessionRequestSchema, req.body, reply);
    if (!body) return reply;
    const event: EngineEvent = {
      type: 'external.event',
      name: 'ui.approve',
      ...(body.comment !== undefined ? { data: { comment: body.comment } } : {}),
    };
    return applyFromRoute(reply, 'approve', id, event);
  });

  app.post<IdParams>('/api/sessions/:id/cancel', async (req, reply) => {
    const id = sessionId(req.params.id, reply);
    if (id === undefined) return reply;
    const body = parseBody(CancelSessionRequestSchema, req.body, reply);
    if (!body) return reply;
    const event: EngineEvent = {
      type: 'operator.cancel',
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
    };
    return applyFromRoute(reply, 'cancel', id, event);
  });

  /**
   * ADR-0007: a message to the running agent. `operator.message` → one send_message command; the
   * text is appended to the output ring as a `user` chunk once the apply has committed (Claude
   * does not echo user messages, so this is how the board shows what the human said).
   */
  app.post<IdParams>('/api/sessions/:id/messages', async (req, reply) => {
    const id = sessionId(req.params.id, reply);
    if (id === undefined) return reply;
    const body = parseBody(SendMessageRequestSchema, req.body, reply);
    if (!body) return reply;
    const result = await engine.applyEvent(id, { type: 'operator.message', text: body.text });
    if (result.status !== 'applied') {
      const { status, code } = httpForApplyResult('message', result);
      return sendError(reply, status, code, `operator.message: ${result.reason}`);
    }
    outputBus.append(id, 'user', body.text);
    return reply.code(202).send(OK);
  });

  /**
   * ADR-0008: the session's history from Claude's own transcript on the machine that ran it.
   * A read-only WS request/response through the gateway; nothing is read from Postgres but the
   * session's machine.
   */
  app.get<IdParams>('/api/sessions/:id/transcript', async (req, reply) => {
    const id = sessionId(req.params.id, reply);
    if (id === undefined) return reply;
    const r = await db.query<{ machine_id: string | null }>(
      'SELECT machine_id FROM session WHERE id = $1',
      [id],
    );
    const row = r.rows[0];
    if (!row) return sendError(reply, 404, 'not_found', `session ${id} not found`);
    const machine = row.machine_id;
    if (machine === null || !transcripts) {
      return sendError(reply, 503, 'machine_offline', `session ${id} is not on a machine`);
    }
    const res = await transcripts.fetchTranscript(machine, id);
    switch (res.status) {
      case 'ok': {
        // seq = position in this response (not an output-ring seq); ts = the transcript's own.
        const body: TranscriptResponse = {
          machine_id: machine,
          chunks: res.chunks.map((c, i) => ({ session_id: id, seq: i, ...c })),
          truncated: res.truncated,
        };
        return body;
      }
      case 'offline':
        return sendError(reply, 503, 'machine_offline', `machine ${machine} is offline`);
      case 'timeout':
        return sendError(reply, 504, 'timeout', `machine ${machine} did not answer in time`);
      case 'error':
        if (res.error === 'read_failed') {
          return sendError(reply, 502, 'internal', `machine ${machine} could not read it`);
        }
        return sendError(reply, 404, 'no_transcript', `machine ${machine} has no transcript`);
    }
  });

  /**
   * ADR-0008: reopen the ticket of a finished session (its latest, `done` or `failed`) with a new
   * session that resumes the same Claude conversation on the same branch and machine.
   */
  app.post<IdParams>('/api/sessions/:id/reopen', async (req, reply) => {
    const id = sessionId(req.params.id, reply);
    if (id === undefined) return reply;
    const body = parseBody(ReopenSessionRequestSchema, req.body, reply);
    if (!body) return reply;
    const res = await reopenSession(db, id, body.text, UI_ACTOR);
    if (res.status === 'not_found') {
      return sendError(reply, 404, 'not_found', `session ${id} not found`);
    }
    if (res.status === 'conflict') return sendError(reply, 409, 'conflict', res.reason);
    for (const ev of res.boardEvents) boardBus.publish(ev);
    // Claude does not echo user messages: show what the human asked, as for /messages.
    outputBus.append(res.sessionId, 'user', body.text);
    const out: ReopenSessionResponse = { session_id: res.sessionId };
    return reply.code(202).send(out);
  });

  // ---------------------------------------------------------------- tickets

  app.post(API_PATHS.tickets, async (req, reply) => {
    const body = parseBody(CreateTicketRequestSchema, req.body, reply);
    if (!body) return reply;
    // ADR-0010: `conductor` is seeded on startup; seeding here too keeps a bare database (tests,
    // a start that raced a migration) working. Idempotent.
    // Silent: the "newer default" notice is the start's (M1b-T09).
    if (body.workflow_id === CONDUCTOR_WORKFLOW_ID) await seedConductorWorkflow(db, { log: null });
    const known = await db.query('SELECT 1 FROM workflow_definition WHERE id = $1 LIMIT 1', [
      body.workflow_id,
    ]);
    if (known.rowCount === 0) {
      return sendError(reply, 400, 'bad_request', `unknown workflow ${body.workflow_id}`, [
        { path: 'workflow_id', message: 'no workflow with this id' },
      ]);
    }
    const { ticket, events } = await withTransaction(db, async (tx) => {
      const res = await tx.query<TicketRow>(
        'INSERT INTO ticket (external_ref, repo, title, body, workflow_id, required_tags, ' +
          'repo_allow_machines, priority, kind) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ' +
          'RETURNING *',
        [
          body.external_ref,
          body.repo,
          body.title,
          body.body,
          body.workflow_id,
          body.required_tags,
          body.repo_allow_machines,
          body.priority,
          body.kind,
        ],
      );
      const row = res.rows[0]!;
      // Last write of the transaction (insertBoardEvents holds the board lock to COMMIT).
      const evs = await insertBoardEvents(tx, [
        {
          type: 'card.upserted',
          session_id: null,
          ticket_id: row.id,
          card: toBoardCard(row, null, null, await cardView(tx, row.workflow_id, null)),
        },
      ]);
      return { ticket: row, events: evs };
    });
    for (const ev of events) boardBus.publish(ev);
    return reply.code(201).send(toTicketDto(ticket));
  });

  // ---------------------------------------------------------------- workflows

  // ADR-0010: the one workflow; `?all=1` also lists the older ones (kept for their tickets).
  app.get<{ Querystring: { all?: string } }>(API_PATHS.workflows, (req) =>
    listWorkflows(db, req.query.all === '1' || req.query.all === 'true'),
  );

  // ADR-0009: one workflow's definition, the latest version or `?version=N`.
  app.get<IdParams & { Querystring: { version?: string } }>(
    API_PATHS.workflow(':id'),
    async (req, reply) => {
      const raw = req.query.version;
      let version: number | null = null;
      if (raw !== undefined) {
        version = /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : NaN;
        if (Number.isNaN(version)) {
          return sendError(reply, 400, 'bad_request', 'version must be a positive integer', [
            { path: 'version', message: 'expected a positive integer' },
          ]);
        }
      }
      const detail = await loadWorkflowDetail(db, req.params.id, version);
      if (!detail) {
        const what = version === null ? '' : ` version ${version}`;
        return sendError(reply, 404, 'not_found', `no workflow ${req.params.id}${what}`);
      }
      // ADR-0011 (M1b-T09): the shipped default the user's edits kept the seed from inserting.
      return { ...detail, default_available: await conductorDefaultAvailable(db, detail.id) };
    },
  );

  app.post(API_PATHS.workflows, async (req, reply) => {
    const body = parseBody(SaveWorkflowRequestSchema, req.body, reply);
    if (!body) return reply;
    const result = validateWorkflow(body.definition);
    if (!result.ok) {
      return sendError(
        reply,
        400,
        'invalid_workflow',
        'workflow definition is invalid',
        result.errors.map((e) => ({
          path: pathString(e.path),
          message: `rule ${e.rule}: ${e.message}`,
        })),
      );
    }
    const def = result.def;
    // The server assigns the version (max + 1); a concurrent save of the same id loses the
    // primary-key race and retries.
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await db.query<{ version: number }>(
          'INSERT INTO workflow_definition (id, version, definition) ' +
            'SELECT $1::text, coalesce(max(version), 0) + 1, ' +
            "jsonb_set($2::jsonb, '{version}', to_jsonb(coalesce(max(version), 0) + 1)) " +
            'FROM workflow_definition WHERE id = $1::text RETURNING version',
          [def.id, JSON.stringify(def)],
        );
        return await reply.code(201).send({ id: def.id, version: res.rows[0]!.version });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== PG_UNIQUE_VIOLATION || attempt >= 4) throw err;
      }
    }
  });

  // ---------------------------------------------------------------- machines

  app.get(API_PATHS.machines, () => listMachines(db));

  // ---------------------------------------------------------------- SSE

  app.get(API_PATHS.boardStream, async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const lastEventId =
      parseLastEventId(req.headers['last-event-id']) ?? parseLastEventId(query.last_event_id);
    const conn = hub.start(req, reply);
    await serveBoardStream(conn, { db, boardBus, onError: logError }, lastEventId);
  });

  app.get<IdParams>('/api/stream/sessions/:id/output', async (req, reply) => {
    const id = sessionId(req.params.id, reply);
    if (id === undefined) return reply;
    if (!(await sessionExists(db, id))) {
      return sendError(reply, 404, 'not_found', `session ${id} not found`);
    }
    const conn = hub.start(req, reply);
    serveOutputStream(conn, outputBus, id);
  });

  // Open SSE responses are never idle, so end them before the server waits for connections.
  app.addHook('preClose', (done) => {
    hub.closeAll();
    done();
  });

  return {
    server: app.server,
    async listen(port, host = '127.0.0.1') {
      await app.listen({ port, host });
    },
    async close() {
      await app.close();
    },
  };
}) satisfies CreateApi;
