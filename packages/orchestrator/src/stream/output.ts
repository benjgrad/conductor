import { encodeSseFrame } from '@conductor/shared';
import type { OutputBus } from '../contracts.js';
import type { SseConnection } from './sse.js';

// GET /api/stream/sessions/:id/output (03 §SSE): the ring buffer, then live chunks. Frames carry
// no id: output is not replayable beyond the ring, so a reconnect simply starts over from it.

/**
 * Write the ring snapshot, then subscribe. Both happen in the same synchronous turn and
 * OutputBus.append notifies synchronously, so no chunk can fall between them or appear twice.
 */
export function serveOutputStream(conn: SseConnection, outputBus: OutputBus, sessionId: string) {
  for (const chunk of outputBus.snapshot(sessionId)) {
    conn.write(encodeSseFrame('output', chunk));
  }
  const unsubscribe = outputBus.subscribe(sessionId, (chunk) => {
    conn.write(encodeSseFrame('output', chunk));
  });
  conn.onClose(unsubscribe);
}
