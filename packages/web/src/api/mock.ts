import {
  AnswerInputRequestSchema,
  BOARD_COLUMNS,
  columnFor,
  CreateTicketRequestSchema,
  ReopenSessionRequestSchema,
  SendMessageRequestSchema,
  type BoardCard,
  type BoardResponse,
  type BoardSseEvent,
  type BoardSseEventDraft,
  type InputRequestKind,
  type MachineDto,
  type OkResponse,
  type OutputChunk,
  type OutputStream,
  type ReopenSessionResponse,
  type SessionDetail,
  type SessionStatus,
  type TicketDto,
  type TranscriptResponse,
  type WorkflowSummary,
} from '@conductor/shared';
import {
  ApiRequestError,
  type ApiClient,
  type StreamHandlers,
  type Unsubscribe,
} from './client.js';
import { MOCK_WORKFLOWS, mockSeeds, type MockSession } from './mock-data.js';

// In-memory ApiClient for T09 (and tests). It mimics the orchestrator's observable behaviour:
// every change is an id-ordered board event (card.upserted last, carrying the full card), the
// board stream replays from Last-Event-ID, answers are idempotent per input_request_id, and
// errors use the 10-contracts REST error map codes. It does NOT run the workflow engine: an
// answer simply moves the session to `goto` (or `return_to`) and marks it running.

export interface MockApiOptions {
  /** Clock for seeds and new rows. Default: real time. */
  now?: () => Date;
  /** Artificial latency on every request, ms. Default 0. */
  latencyMs?: number;
  /** Delay before the fake agent replies to a sendMessage, ms. Default 700. */
  replyDelayMs?: number;
}

export interface MockApi extends ApiClient {
  /** Test/dev hooks: drive the board like a daemon would. */
  pushOutput(sessionId: string, text: string, stream?: OutputStream): void;
  requestInput(sessionId: string, kind: InputRequestKind, question: string): string;
  /** Appends fake output to every running session every `ms`; returns a stop function. */
  simulate(ms: number): Unsubscribe;
}

const TERMINAL: ReadonlySet<SessionStatus> = new Set(['done', 'failed', 'lost']);

export function createMockApi(opts: MockApiOptions = {}): MockApi {
  const now = opts.now ?? (() => new Date());
  const latency = opts.latencyMs ?? 0;
  const replyDelay = opts.replyDelayMs ?? 700;
  const cards = new Map<string, BoardCard>();
  const sessions = new Map<string, MockSession>();
  const answered = new Set<string>();
  const log: BoardSseEvent[] = [];
  const boardSubs = new Set<StreamHandlers<BoardSseEvent>>();
  const outputSubs = new Map<string, Set<StreamHandlers<OutputChunk>>>();
  let nextEventId = 1;

  for (const s of mockSeeds(now())) {
    cards.set(s.card.ticket_id, { ...s.card, column: columnFor(s.card.status) });
    if (s.session && s.card.session_id) sessions.set(s.card.session_id, s.session);
  }

  const reply = <T>(fn: () => T): Promise<T> =>
    new Promise((resolve, reject) => {
      const run = () => {
        try {
          resolve(fn());
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      if (latency > 0) setTimeout(run, latency);
      else queueMicrotask(run);
    });

  const clone = <T>(v: T): T => structuredClone(v);

  function emit(drafts: BoardSseEventDraft[]) {
    const ts = now().toISOString();
    const events = drafts.map((d) => ({ ...d, id: nextEventId++, ts }));
    log.push(...events);
    // Snapshot the subscribers: one that subscribes later gets these from its replay backlog.
    const subs = [...boardSubs];
    queueMicrotask(() => {
      for (const ev of events)
        for (const sub of subs) if (boardSubs.has(sub)) sub.onEvent(clone(ev));
    });
  }

  function cardForSession(sessionId: string): BoardCard {
    for (const card of cards.values()) if (card.session_id === sessionId) return card;
    throw new ApiRequestError(404, 'not_found', `session ${sessionId} not found`);
  }

  /** Apply a card change and emit the events EngineService would. */
  function update(card: BoardCard, next: Partial<BoardCard>, extra: BoardSseEventDraft[] = []) {
    const sessionId = card.session_id;
    if (sessionId === null) throw new Error('update() needs a session card');
    const updated: BoardCard = { ...card, ...next, updated_at: now().toISOString() };
    updated.column = columnFor(updated.status);
    cards.set(card.ticket_id, updated);
    const drafts: BoardSseEventDraft[] = [...extra];
    if (card.status !== null && updated.status !== null && card.status !== updated.status) {
      drafts.push({
        type: 'session.status',
        session_id: sessionId,
        from: card.status,
        to: updated.status,
        workflow_state: updated.workflow_state,
      });
    }
    if (card.column !== updated.column) {
      drafts.push({
        type: 'card.moved',
        session_id: sessionId,
        ticket_id: card.ticket_id,
        from: card.column,
        to: updated.column,
      });
    }
    drafts.push({
      type: 'card.upserted',
      session_id: sessionId,
      ticket_id: card.ticket_id,
      card: updated,
    });
    emit(drafts);
  }

  function sessionOf(sessionId: string): MockSession {
    const s = sessions.get(sessionId);
    if (!s) throw new ApiRequestError(404, 'not_found', `session ${sessionId} not found`);
    return s;
  }

  function enterState(session: MockSession, state: string) {
    session.state_entered_at = now().toISOString();
    return session.workflow.states[state]?.type === 'terminal' ? 'done' : 'running';
  }

  const api: MockApi = {
    getBoard: () =>
      reply((): BoardResponse => {
        const columns = Object.fromEntries(BOARD_COLUMNS.map((c) => [c, [] as BoardCard[]]));
        for (const card of cards.values()) columns[card.column]?.push(clone(card));
        // The client re-sorts; the server pre-sorts (06). Order here is insertion order.
        return { columns: columns as BoardResponse['columns'], last_event_id: nextEventId - 1 };
      }),

    streamBoard(lastEventId, handlers) {
      let open = true;
      boardSubs.add(handlers);
      const backlog = log.filter((e) => e.id > lastEventId);
      queueMicrotask(() => {
        if (open) for (const ev of backlog) handlers.onEvent(clone(ev));
      });
      return () => {
        open = false;
        boardSubs.delete(handlers);
      };
    },

    getSession: (sessionId) =>
      reply((): SessionDetail => {
        const card = cardForSession(sessionId);
        const s = sessionOf(sessionId);
        return clone({
          card,
          workflow: s.workflow,
          workflow_version: s.workflow.version,
          context: s.context,
          retry_counters: {},
          state_visits: {},
          return_to: s.return_to,
          state_entered_at: s.state_entered_at,
          state_deadline: null,
          spend_usd: card.spend_usd,
          wall_seconds: s.wall_seconds,
          budget: { usd: s.workflow.budget.usd, minutes: s.workflow.budget.minutes },
          branch: s.branch,
          worktree_path: null,
          pending_input: card.input_request,
          recent_output: s.output,
        });
      }),

    streamOutput(sessionId, handlers) {
      let subs = outputSubs.get(sessionId);
      if (!subs) outputSubs.set(sessionId, (subs = new Set()));
      subs.add(handlers);
      return () => {
        subs.delete(handlers);
      };
    },

    answer: (sessionId, raw) =>
      reply((): OkResponse => {
        const parsed = AnswerInputRequestSchema.safeParse(raw);
        if (!parsed.success) throw new ApiRequestError(400, 'bad_request', parsed.error.message);
        const req = parsed.data;
        const card = cardForSession(sessionId);
        const s = sessionOf(sessionId);
        if (answered.has(req.input_request_id)) {
          throw new ApiRequestError(409, 'input_already_answered', 'already answered');
        }
        if (card.input_request?.id !== req.input_request_id) {
          throw new ApiRequestError(409, 'input_not_pending', 'no such pending input request');
        }
        const target = req.goto ?? s.return_to ?? s.workflow.start;
        if (!(target in s.workflow.states)) {
          throw new ApiRequestError(400, 'bad_request', `unknown state "${target}"`);
        }
        answered.add(req.input_request_id);
        const status = enterState(s, target);
        s.return_to = null;
        update(card, { status, workflow_state: target, input_request: null }, [
          {
            type: 'input.answered',
            session_id: sessionId,
            input_request_id: req.input_request_id,
            answered_by: 'ben',
          },
        ]);
        return { ok: true };
      }),

    createTicket: (raw) =>
      reply((): TicketDto => {
        const parsed = CreateTicketRequestSchema.safeParse(raw);
        if (!parsed.success) throw new ApiRequestError(400, 'bad_request', parsed.error.message);
        const req = parsed.data;
        if (!MOCK_WORKFLOWS.some((w) => w.id === req.workflow_id)) {
          throw new ApiRequestError(400, 'bad_request', `unknown workflow "${req.workflow_id}"`);
        }
        const created_at = now().toISOString();
        const ticket: TicketDto = {
          id: crypto.randomUUID(),
          external_ref: req.external_ref,
          repo: req.repo,
          title: req.title,
          body: req.body,
          workflow_id: req.workflow_id,
          workflow_version: null,
          required_tags: req.required_tags,
          repo_allow_machines: req.repo_allow_machines,
          status: 'ready',
          priority: req.priority,
          created_at,
        };
        const card: BoardCard = {
          ticket_id: ticket.id,
          session_id: null,
          title: ticket.title,
          external_ref: ticket.external_ref,
          repo: ticket.repo,
          priority: ticket.priority,
          workflow_id: ticket.workflow_id,
          workflow_state: null,
          status: null,
          column: 'queued',
          badges: [],
          machine_id: null,
          spend_usd: 0,
          input_request: null,
          created_at,
          updated_at: created_at,
        };
        cards.set(card.ticket_id, card);
        emit([{ type: 'card.upserted', session_id: null, ticket_id: card.ticket_id, card }]);
        return clone(ticket);
      }),

    listWorkflows: () =>
      reply((): WorkflowSummary[] =>
        MOCK_WORKFLOWS.map((w) => ({
          id: w.id,
          version: w.version,
          start: w.start,
          state_count: Object.keys(w.states).length,
          created_at: '2026-10-01T00:00:00.000Z',
        })),
      ),

    approve: (sessionId) =>
      reply((): OkResponse => {
        const card = cardForSession(sessionId);
        const s = sessionOf(sessionId);
        const state = card.workflow_state ? s.workflow.states[card.workflow_state] : undefined;
        const next = state?.type === 'event' ? state.on?.['ui.approve'] : undefined;
        if (card.status !== 'waiting_external' || next === undefined) {
          throw new ApiRequestError(409, 'conflict', 'session is not waiting for ui.approve');
        }
        const target = typeof next === 'string' ? next : next.goto;
        update(card, { status: enterState(s, target), workflow_state: target });
        return { ok: true };
      }),

    cancel: (sessionId) =>
      reply((): OkResponse => {
        const card = cardForSession(sessionId);
        if (card.status === null || TERMINAL.has(card.status)) {
          throw new ApiRequestError(409, 'conflict', 'session already finished');
        }
        const extra: BoardSseEventDraft[] = card.input_request
          ? [
              {
                type: 'input.answered',
                session_id: sessionId,
                input_request_id: card.input_request.id,
                answered_by: null,
              },
            ]
          : [];
        update(card, { status: 'failed', input_request: null }, extra);
        return { ok: true };
      }),

    sendMessage: (sessionId, raw) =>
      reply((): OkResponse => {
        const parsed = SendMessageRequestSchema.safeParse(raw);
        if (!parsed.success) throw new ApiRequestError(400, 'bad_request', parsed.error.message);
        const card = cardForSession(sessionId);
        const s = sessionOf(sessionId);
        const state = card.workflow_state ? s.workflow.states[card.workflow_state] : undefined;
        if (card.status !== 'running' || state?.type !== 'agent') {
          throw new ApiRequestError(409, 'conflict', 'session has no live agent process');
        }
        const text = parsed.data.text;
        api.pushOutput(sessionId, text, 'user');
        // A pretend agent, so `pnpm dev` with the mock answers back.
        setTimeout(() => {
          if (sessions.has(sessionId)) api.pushOutput(sessionId, fakeReply(text));
        }, replyDelay);
        return { ok: true };
      }),

    listMachines: () =>
      reply((): MachineDto[] => [
        {
          id: 'mbp-ben',
          hostname: 'bens-macbook-pro.local',
          status: 'online',
          tags: ['macos', 'arm64'],
          last_heartbeat_at: now().toISOString(),
          max_sessions: 3,
          running_sessions: [...cards.values()].filter(
            (c) => c.machine_id === 'mbp-ben' && c.status === 'running',
          ).length,
          cpu_free: 0.62,
          mem_free_mb: 9_400,
        },
      ]),

    getTranscript: (sessionId) =>
      reply((): TranscriptResponse => {
        const s = sessionOf(sessionId);
        if (!s.transcript) {
          throw new ApiRequestError(404, 'no_transcript', 'machine mbp-ben has no transcript');
        }
        return clone({ machine_id: 'mbp-ben', chunks: s.transcript, truncated: false });
      }),

    reopen: (sessionId, raw) =>
      reply((): ReopenSessionResponse => {
        const parsed = ReopenSessionRequestSchema.safeParse(raw);
        if (!parsed.success) throw new ApiRequestError(400, 'bad_request', parsed.error.message);
        const s = sessionOf(sessionId);
        const card = [...cards.values()].find((c) => c.session_id === sessionId);
        if (!card) throw new ApiRequestError(409, 'conflict', 'not the ticket’s latest session');
        if (card.status !== 'done' && card.status !== 'failed') {
          throw new ApiRequestError(409, 'conflict', `the session is ${card.status ?? 'queued'}`);
        }
        // Like the orchestrator after the claim: a new running session for the same ticket, at
        // the workflow's start state, with the same branch and context (ADR-0008).
        const id = crypto.randomUUID();
        const start = s.workflow.start;
        sessions.set(id, {
          ...clone(s),
          return_to: null,
          state_entered_at: now().toISOString(),
          wall_seconds: 0,
          output: [],
        });
        const next: BoardCard = {
          ...card,
          session_id: id,
          status: 'running',
          workflow_state: start,
          column: columnFor('running'),
          input_request: null,
          spend_usd: 0,
          updated_at: now().toISOString(),
        };
        cards.set(card.ticket_id, next);
        emit([
          {
            type: 'card.moved',
            session_id: id,
            ticket_id: card.ticket_id,
            from: card.column,
            to: next.column,
          },
          { type: 'card.upserted', session_id: id, ticket_id: card.ticket_id, card: next },
        ]);
        const text = parsed.data.text;
        api.pushOutput(id, text, 'user');
        setTimeout(() => {
          if (sessions.has(id)) api.pushOutput(id, fakeReply(text));
        }, replyDelay);
        return { session_id: id };
      }),

    pushOutput(sessionId, text, stream = 'assistant') {
      const s = sessionOf(sessionId);
      const chunk: OutputChunk = {
        session_id: sessionId,
        seq: (s.output.at(-1)?.seq ?? -1) + 1,
        stream,
        text,
        ts: now().toISOString(),
      };
      s.output.push(chunk);
      for (const sub of outputSubs.get(sessionId) ?? []) sub.onEvent(clone(chunk));
    },

    requestInput(sessionId, kind, question) {
      const card = cardForSession(sessionId);
      const s = sessionOf(sessionId);
      const id = crypto.randomUUID();
      const created_at = now().toISOString();
      s.return_to = card.workflow_state;
      update(
        card,
        {
          status: 'needs_input',
          workflow_state: 'needs_input',
          input_request: {
            id,
            session_id: sessionId,
            kind,
            question,
            created_at,
            answer: null,
            answered_by: null,
            answered_at: null,
          },
        },
        [
          {
            type: 'input.requested',
            session_id: sessionId,
            input_request_id: id,
            kind,
            question,
            created_at,
          },
        ],
      );
      return id;
    },

    simulate(ms) {
      let n = 0;
      const timer = setInterval(() => {
        for (const card of cards.values()) {
          if (card.status === 'running' && card.session_id) {
            api.pushOutput(card.session_id, `[${card.workflow_state ?? '?'}] step ${++n}\n`);
          }
        }
      }, ms);
      return () => clearInterval(timer);
    },
  };
  return api;
}

function fakeReply(text: string): string {
  const cmd = /^\/(\S+)/.exec(text)?.[1];
  if (cmd === 'context') {
    return '**Context usage** · 41k / 200k tokens (21%)\n\n- System prompt: 3.1k\n- Tools: 11.8k\n- Messages: 26.4k';
  }
  if (cmd === 'compact') return 'Compacted the conversation. Carrying on with the summary.';
  if (cmd) return `Unknown command \`/${cmd}\`.`;
  return "Got it. I'll take that into account and keep going.";
}
