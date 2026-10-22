// Public REST + SSE client for the E2E (M1-T10). Everything the scenarios observe goes through
// the orchestrator's HTTP API: POST /api/workflows, POST /api/tickets, GET /api/sessions/:id,
// POST /api/sessions/:id/input, GET /api/machines, and the board / output SSE streams.
import type {
  BoardCard,
  BoardSseEvent,
  MachineDto,
  OutputChunk,
  SessionDetail,
  TicketDto,
} from '../../packages/shared/src/index.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    what: string,
  ) {
    super(`${what} → HTTP ${status}: ${body.slice(0, 500)}`);
  }
}

export class Api {
  constructor(readonly baseUrl: string) {}

  private async call<T>(method: string, path: string, body?: unknown, expect = 200): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    const text = await res.text();
    if (res.status !== expect) throw new ApiError(res.status, text, `${method} ${path}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  saveWorkflow(definition: unknown) {
    return this.call<{ id: string; version: number }>(
      'POST',
      '/api/workflows',
      { definition },
      201,
    );
  }

  createTicket(t: { title: string; body: string; repo: string; workflow_id: string }) {
    return this.call<TicketDto>('POST', '/api/tickets', { ...t, required_tags: ['e2e'] }, 201);
  }

  session(id: string) {
    return this.call<SessionDetail>('GET', `/api/sessions/${id}`);
  }

  answer(sessionId: string, inputRequestId: string, answer: string) {
    return this.call<{ ok: true }>(
      'POST',
      `/api/sessions/${sessionId}/input`,
      { input_request_id: inputRequestId, answer },
      202,
    );
  }

  machines() {
    return this.call<MachineDto[]>('GET', '/api/machines');
  }
}

interface SseFrame {
  event: string;
  id?: number;
  data: unknown;
}

/** A fetch-based SSE reader (Node has no EventSource). */
class SseStream {
  readonly frames: SseFrame[] = [];
  private readonly abort = new AbortController();
  private waiters: (() => void)[] = [];
  closed = false;
  error: unknown = null;

  constructor(url: string) {
    void this.run(url);
  }

  private async run(url: string) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'text/event-stream' },
        signal: this.abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`SSE ${url} → HTTP ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) !== -1) {
          const frame = parseFrame(buf.slice(0, cut));
          buf = buf.slice(cut + 2);
          if (frame) this.frames.push(frame);
        }
        this.wake();
      }
    } catch (err) {
      if (!this.abort.signal.aborted) this.error = err;
    } finally {
      this.closed = true;
      this.wake();
    }
  }

  private wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  /** Resolve with the first value `pick` returns for the frames so far (re-run on new frames). */
  async until<T>(what: string, pick: () => T | undefined, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = pick();
      if (v !== undefined) return v;
      if (this.closed)
        throw new Error(`SSE closed while waiting for ${what}: ${String(this.error)}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 1000));
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  close() {
    this.abort.abort();
  }
}

function parseFrame(block: string): SseFrame | null {
  let id: number | undefined;
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'id') id = Number(value);
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  return { ...(id !== undefined ? { id } : {}), event, data: JSON.parse(data.join('\n')) };
}

/**
 * GET /api/stream/board from event 0 (full replay, then live), kept open for the whole run. The
 * cards are rebuilt from `card.upserted` exactly as the web client does (one card per ticket).
 */
export class BoardWatcher {
  private readonly sse: SseStream;

  constructor(baseUrl: string) {
    this.sse = new SseStream(`${baseUrl}/api/stream/board?last_event_id=0`);
  }

  get events(): BoardSseEvent[] {
    return this.sse.frames.map((f) => f.data as BoardSseEvent);
  }

  /** Every card.upserted for the ticket, oldest first. */
  cards(ticketId: string): BoardCard[] {
    return this.events.flatMap((e) =>
      e.type === 'card.upserted' && e.ticket_id === ticketId ? [e.card] : [],
    );
  }

  /** The workflow states the ticket's card went through (consecutive repeats collapsed). */
  states(ticketId: string): string[] {
    const out: string[] = [];
    for (const c of this.cards(ticketId)) {
      if (c.workflow_state !== null && out.at(-1) !== c.workflow_state) out.push(c.workflow_state);
    }
    return out;
  }

  /** Wait until the ticket's latest card satisfies `pred`; returns that card. */
  card(
    ticketId: string,
    what: string,
    pred: (c: BoardCard) => boolean,
    timeoutMs = 30_000,
  ): Promise<BoardCard> {
    return this.sse.until(
      `${what} (ticket ${ticketId})`,
      () => {
        const last = this.cards(ticketId).at(-1);
        return last && pred(last) ? last : undefined;
      },
      timeoutMs,
    );
  }

  close() {
    this.sse.close();
  }
}

/** GET /api/stream/sessions/:id/output: the ring snapshot, then live chunks. */
export class OutputWatcher {
  private readonly sse: SseStream;

  constructor(baseUrl: string, sessionId: string) {
    this.sse = new SseStream(`${baseUrl}/api/stream/sessions/${sessionId}/output`);
  }

  get chunks(): OutputChunk[] {
    return this.sse.frames.filter((f) => f.event === 'output').map((f) => f.data as OutputChunk);
  }

  text(): string {
    return this.chunks.map((c) => c.text).join('\n');
  }

  waitForText(needle: string, timeoutMs = 10_000): Promise<OutputChunk[]> {
    return this.sse.until(
      `output containing ${JSON.stringify(needle)}`,
      () => (this.text().includes(needle) ? this.chunks : undefined),
      timeoutMs,
    );
  }

  close() {
    this.sse.close();
  }
}
