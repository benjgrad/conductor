import type { FastifyReply, FastifyRequest } from 'fastify';

// SSE plumbing shared by the board and output streams (03 §SSE, M1-T08).

/** Comment frame sent periodically so proxies and the browser keep the connection open. */
export const SSE_HEARTBEAT_MS = 15_000;

export interface SseConnection {
  /** Write a pre-encoded frame (`encodeSseFrame`). No-op once closed. */
  write(frame: string): void;
  /** End the response and run the close callbacks. Idempotent. */
  close(): void;
  readonly closed: boolean;
  /** Run `fn` once when the connection closes (client gone, server closing, or close()). */
  onClose(fn: () => void): void;
}

/**
 * Tracks every open SSE response so the API can end them on shutdown: a hijacked streaming
 * response is never idle, so `server.close()` would otherwise wait for it forever.
 */
export class SseHub {
  private readonly open = new Set<SseConnection>();

  constructor(private readonly heartbeatMs: number = SSE_HEARTBEAT_MS) {}

  get size(): number {
    return this.open.size;
  }

  /** Take over the response (Fastify `hijack`) and send the SSE headers. */
  start(request: FastifyRequest, reply: FastifyReply): SseConnection {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // Flush the headers at once so the client's EventSource reports `open`.
    raw.write(': connected\n\n');

    const callbacks: (() => void)[] = [];
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      this.open.delete(conn);
      for (const fn of callbacks.splice(0)) {
        try {
          fn();
        } catch {
          // A failing cleanup must not stop the others.
        }
      }
    };
    const conn: SseConnection = {
      write(frame) {
        // TD: no backpressure handling; a slow client buffers in memory until it disconnects.
        if (!closed && !raw.destroyed) raw.write(frame);
      },
      close() {
        if (closed) return;
        finish();
        raw.end();
      },
      get closed() {
        return closed;
      },
      onClose(fn) {
        if (closed) fn();
        else callbacks.push(fn);
      },
    };
    const heartbeat = setInterval(() => conn.write(': ping\n\n'), this.heartbeatMs);
    heartbeat.unref();
    request.raw.on('close', finish);
    raw.on('close', finish);
    this.open.add(conn);
    return conn;
  }

  closeAll(): void {
    for (const conn of [...this.open]) conn.close();
  }
}
