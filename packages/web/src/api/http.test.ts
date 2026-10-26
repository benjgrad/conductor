import {
  API_PATHS,
  BOARD_SSE_FIXTURES,
  OUTPUT_CHUNK_FIXTURE,
  TRANSITION_REQUEST_FIXTURES,
  type BoardSseEvent,
  type OutputChunk,
} from '@conductor/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from './client.js';
import {
  backoffDelay,
  createHttpApi,
  StreamDisconnectedError,
  type EventSourceLike,
} from './http.js';
import { SEED_IDS } from './mock-data.js';
import { createMockApi } from './mock.js';

// Unit tests with a recorded fetch and a scripted EventSource (no network). The real-HTTP
// round trip is in http.server.test.ts.

const now = () => new Date('2026-10-22T12:00:00.000Z');
const SESSION = '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f';
const INPUT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

interface Call {
  url: string;
  method: string;
  body: unknown;
  contentType: string | undefined;
}

function recordingFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      contentType: headers['content-type'],
    };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  return { calls, fetch: fn };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

class FakeEventSource implements EventSourceLike {
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((ev: MessageEvent<string>) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.(new Event('open'));
  }
  fail() {
    this.onerror?.(new Event('error'));
  }
  emit(type: string, data: unknown) {
    const ev = new MessageEvent<string>(type, { data: JSON.stringify(data) });
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

function sources() {
  const all: FakeEventSource[] = [];
  return {
    all,
    factory: (url: string) => {
      const es = new FakeEventSource(url);
      all.push(es);
      return es;
    },
    last: () => all.at(-1)!,
  };
}

const ev = <T extends BoardSseEvent['type']>(type: T, id: number) => ({
  ...BOARD_SSE_FIXTURES[type],
  id,
});

describe('createHttpApi workflows (ADR-0009)', () => {
  it('GET /api/workflows/:id[?version=N] and POST /api/workflows {definition}', async () => {
    const detail = await createMockApi({ now }).getWorkflow('m1_basic');
    const { calls, fetch } = recordingFetch(({ method }) =>
      method === 'GET' ? json(200, detail) : json(201, { id: 'm1_basic', version: 3 }),
    );
    const api = createHttpApi({ fetch });
    // `versions` is optional and survives the parse only once the shared schema has it.
    const { id, version, created_at, definition } = detail;
    expect(await api.getWorkflow('m1_basic')).toMatchObject({
      id,
      version,
      created_at,
      definition,
    });
    await api.getWorkflow('m1_basic', 1);
    expect(await api.saveWorkflow(detail.definition)).toEqual({ id: 'm1_basic', version: 3 });
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['GET', '/api/workflows/m1_basic', undefined],
      ['GET', '/api/workflows/m1_basic?version=1', undefined],
      ['POST', '/api/workflows', { definition: detail.definition }],
    ]);
  });

  it('carries 400 invalid_workflow details on the ApiRequestError', async () => {
    const details = [{ path: 'states.build.on.fail.goto', message: 'rule 1: unknown state' }];
    const { fetch } = recordingFetch(() =>
      json(400, { error: { code: 'invalid_workflow', message: 'invalid', details } }),
    );
    const def = (await createMockApi({ now }).getWorkflow('m1_basic')).definition;
    const err = await createHttpApi({ fetch })
      .saveWorkflow(def)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 400, code: 'invalid_workflow', details });
  });
});

describe('createHttpApi REST', () => {
  it('maps every method to its API_PATHS route, method and JSON body', async () => {
    const mock = createMockApi({ now });
    const board = await mock.getBoard();
    const detail = await mock.getSession(SEED_IDS.askOlder.session);
    const workflows = await mock.listWorkflows();
    const ticket = {
      id: '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2',
      external_ref: null,
      repo: 'r',
      title: 't',
      body: '',
      workflow_id: 'm1_basic',
      workflow_version: null,
      required_tags: [],
      repo_allow_machines: null,
      status: 'ready',
      priority: 0,
      created_at: '2026-10-22T12:00:00.000Z',
    };
    const { calls, fetch } = recordingFetch(({ url, method }) => {
      if (method === 'GET' && url.endsWith(API_PATHS.board)) return json(200, board);
      if (method === 'GET' && url.endsWith(API_PATHS.workflows)) return json(200, workflows);
      if (method === 'GET') return json(200, detail);
      if (url.endsWith(API_PATHS.tickets)) return json(201, ticket);
      return json(202, { ok: true });
    });
    const api = createHttpApi({ baseUrl: 'http://orch:7400/', fetch });

    expect(await api.getBoard()).toEqual(board);
    expect(await api.getSession(SESSION)).toEqual(detail);
    expect(await api.listWorkflows()).toEqual(workflows);
    expect(await api.answer(SESSION, { input_request_id: INPUT, answer: 'retry' })).toEqual({
      ok: true,
    });
    await api.answer(SESSION, { input_request_id: INPUT, answer: 'skip to done', goto: 'done' });
    await api.approve(SESSION, { comment: 'lgtm' });
    await api.approve(SESSION);
    await api.cancel(SESSION, { reason: 'aborted from UI' });
    await api.cancel(SESSION);
    expect(
      await api.createTicket({ title: 't', body: '', repo: 'r', workflow_id: 'm1_basic' }),
    ).toEqual(ticket);

    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['GET', 'http://orch:7400/api/board', undefined],
      ['GET', `http://orch:7400/api/sessions/${SESSION}`, undefined],
      ['GET', 'http://orch:7400/api/workflows', undefined],
      [
        'POST',
        `http://orch:7400/api/sessions/${SESSION}/input`,
        { input_request_id: INPUT, answer: 'retry' },
      ],
      [
        'POST',
        `http://orch:7400/api/sessions/${SESSION}/input`,
        { input_request_id: INPUT, answer: 'skip to done', goto: 'done' },
      ],
      ['POST', `http://orch:7400/api/sessions/${SESSION}/approve`, { comment: 'lgtm' }],
      ['POST', `http://orch:7400/api/sessions/${SESSION}/approve`, {}],
      ['POST', `http://orch:7400/api/sessions/${SESSION}/cancel`, { reason: 'aborted from UI' }],
      ['POST', `http://orch:7400/api/sessions/${SESSION}/cancel`, {}],
      [
        'POST',
        'http://orch:7400/api/tickets',
        { title: 't', body: '', repo: 'r', workflow_id: 'm1_basic' },
      ],
    ]);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.contentType)).toEqual(
      Array(7).fill('application/json'),
    );
  });

  it('getTranscript and reopen (ADR-0008) use their API_PATHS routes', async () => {
    const transcript = {
      machine_id: 'mbp-ben',
      truncated: false,
      chunks: [{ ...OUTPUT_CHUNK_FIXTURE, seq: 0, stream: 'user', text: 'hi' }],
    };
    const NEW = '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2';
    const { calls, fetch } = recordingFetch(({ method }) =>
      method === 'GET' ? json(200, transcript) : json(202, { session_id: NEW }),
    );
    const api = createHttpApi({ baseUrl: 'http://orch:7400', fetch });
    expect(await api.getTranscript(SESSION)).toEqual(transcript);
    expect(await api.reopen(SESSION, { text: 'Make it blue' })).toEqual({ session_id: NEW });
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['GET', `http://orch:7400${API_PATHS.sessionTranscript(SESSION)}`, undefined],
      ['POST', `http://orch:7400${API_PATHS.sessionReopen(SESSION)}`, { text: 'Make it blue' }],
    ]);
  });

  it('transition (ADR-0011) posts {name, text} to its API_PATHS route', async () => {
    const { calls, fetch } = recordingFetch(() => json(202, { ok: true }));
    const api = createHttpApi({ baseUrl: 'http://orch:7400', fetch });
    const { waiting_on_someone, done } = TRANSITION_REQUEST_FIXTURES;
    expect(await api.transition(SESSION, waiting_on_someone!)).toEqual({ ok: true });
    await api.transition(SESSION, done!);
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', `http://orch:7400${API_PATHS.sessionTransition(SESSION)}`, waiting_on_someone],
      ['POST', `http://orch:7400${API_PATHS.sessionTransition(SESSION)}`, { name: 'done' }],
    ]);
  });

  it('defaults to same-origin paths (the Vite dev proxy)', async () => {
    const { calls, fetch } = recordingFetch(() => json(200, []));
    await createHttpApi({ fetch }).listWorkflows();
    expect(calls[0]!.url).toBe('/api/workflows');
  });

  it('throws ApiRequestError with the ApiError code and message', async () => {
    const { fetch } = recordingFetch(() =>
      json(409, { error: { code: 'input_already_answered', message: 'already answered' } }),
    );
    const err = await createHttpApi({ fetch })
      .answer(SESSION, { input_request_id: INPUT, answer: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 409, code: 'input_already_answered' });
    expect((err as Error).message).toBe('already answered');
  });

  it('maps a non-ApiError failure (proxy down) to an ApiRequestError by status', async () => {
    const { fetch } = recordingFetch(
      () => new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    const err = await createHttpApi({ fetch })
      .getBoard()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: 'internal' });
    expect((err as Error).message).toMatch(/GET \/api\/board failed: HTTP 502/);
  });

  it('rejects a 2xx body that does not match the frozen DTO', async () => {
    const { fetch } = recordingFetch(() => json(200, { columns: {} }));
    await expect(createHttpApi({ fetch }).getBoard()).rejects.toThrow(/API contract/);
  });
});

describe('createHttpApi board stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resumes from last_event_id, reconnects with backoff from the last delivered id', async () => {
    const es = sources();
    const api = createHttpApi({
      baseUrl: 'http://orch',
      eventSource: es.factory,
      backoff: { initialMs: 100, maxMs: 350, factor: 2 },
    });
    const got: number[] = [];
    const errors: unknown[] = [];
    let opens = 0;
    const stop = api.streamBoard(41, {
      onEvent: (e) => got.push(e.id),
      onError: (e) => errors.push(e),
      onOpen: () => opens++,
    });
    expect(es.all).toHaveLength(1);
    expect(es.last().url).toBe('http://orch/api/stream/board?last_event_id=41');

    es.last().open();
    es.last().emit('card.upserted', ev('card.upserted', 42));
    es.last().emit('session.status', ev('session.status', 43));
    es.last().emit('card.badge', ev('card.badge', 44));
    expect(got).toEqual([42, 43, 44]);

    // Drop: closed at once (no browser auto-retry), reopened after 100ms from id 44.
    const first = es.last();
    first.fail();
    expect(first.closed).toBe(true);
    expect(errors.at(-1)).toBeInstanceOf(StreamDisconnectedError);
    await vi.advanceTimersByTimeAsync(99);
    expect(es.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(es.all).toHaveLength(2);
    expect(es.last().url).toBe('http://orch/api/stream/board?last_event_id=44');

    // Failing again before open: 200ms, then 350 (cap), then 350.
    es.last().fail();
    await vi.advanceTimersByTimeAsync(199);
    expect(es.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(es.all).toHaveLength(3);
    es.last().fail();
    await vi.advanceTimersByTimeAsync(350);
    expect(es.all).toHaveLength(4);

    // Connected: the replay overlaps what was delivered; duplicates are dropped.
    es.last().open();
    expect(opens).toBe(2);
    es.last().emit('session.status', ev('session.status', 43));
    es.last().emit('card.badge', ev('card.badge', 44));
    es.last().emit('input.requested', ev('input.requested', 45));
    expect(got).toEqual([42, 43, 44, 45]);

    // Backoff reset by the successful open.
    es.last().fail();
    await vi.advanceTimersByTimeAsync(100);
    expect(es.all).toHaveLength(5);
    expect(es.last().url).toBe('http://orch/api/stream/board?last_event_id=45');

    // Late events from a closed source are ignored; stop cancels everything.
    es.all[0]!.emit('card.badge', ev('card.badge', 99));
    expect(got).toEqual([42, 43, 44, 45]);
    stop();
    expect(es.last().closed).toBe(true);
    es.last().fail();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(es.all).toHaveLength(5);
  });

  it('stop() during a pending reconnect cancels it', async () => {
    const es = sources();
    const api = createHttpApi({ eventSource: es.factory, backoff: { initialMs: 50 } });
    const stop = api.streamBoard(0, { onEvent: () => undefined });
    es.last().fail();
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(es.all).toHaveLength(1);
  });

  it('reports a malformed event instead of delivering it', () => {
    const es = sources();
    const api = createHttpApi({ eventSource: es.factory });
    const got: BoardSseEvent[] = [];
    const errors: unknown[] = [];
    api.streamBoard(0, { onEvent: (e) => got.push(e), onError: (e) => errors.push(e) });
    es.last().emit('card.moved', { type: 'card.moved', id: 1 });
    expect(got).toEqual([]);
    expect(String(errors[0])).toMatch(/malformed card.moved/);
  });
});

describe('createHttpApi output stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens one stream per session and drops the ring replay on reconnect', async () => {
    const es = sources();
    const api = createHttpApi({ eventSource: es.factory, backoff: { initialMs: 10 } });
    const a: OutputChunk[] = [];
    const b: OutputChunk[] = [];
    const stopA = api.streamOutput(SESSION, { onEvent: (c) => a.push(c) });
    const other = '11111111-2222-4333-8444-555555555555';
    const stopB = api.streamOutput(other, { onEvent: (c) => b.push(c) });
    expect(es.all.map((s) => s.url)).toEqual([
      `/api/stream/sessions/${SESSION}/output`,
      `/api/stream/sessions/${other}/output`,
    ]);
    const chunk = (seq: number) => ({ ...OUTPUT_CHUNK_FIXTURE, seq, text: `line ${seq}\n` });
    const srcA = es.all[0]!;
    srcA.emit('output', chunk(0));
    srcA.emit('output', chunk(1));
    srcA.fail();
    await vi.advanceTimersByTimeAsync(10);
    const srcA2 = es.last();
    expect(srcA2.url).toBe(`/api/stream/sessions/${SESSION}/output`);
    // The new connection starts with the ring snapshot (0, 1) again.
    srcA2.emit('output', chunk(0));
    srcA2.emit('output', chunk(1));
    srcA2.emit('output', chunk(2));
    expect(a.map((c) => c.seq)).toEqual([0, 1, 2]);
    expect(b).toEqual([]);
    stopA();
    stopB();
    expect(es.all.every((s) => s.closed)).toBe(true);
  });
});

describe('backoffDelay', () => {
  it('grows exponentially to the cap', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n))).toEqual([
      500, 1000, 2000, 4000, 8000, 15000, 15000,
    ]);
  });
});
