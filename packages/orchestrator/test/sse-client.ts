// Minimal SSE client for API tests (fetch + stream reader; Node has no EventSource).

export interface SseFrame {
  id?: number;
  event: string;
  data: unknown;
}

export interface SseClient {
  status: number;
  headers: Headers;
  frames: SseFrame[];
  /** Resolve once at least `n` frames have arrived in total. */
  waitFor(n: number, timeoutMs?: number): Promise<SseFrame[]>;
  close(): void;
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

export async function openSse(
  url: string,
  headers: Record<string, string> = {},
): Promise<SseClient> {
  const abort = new AbortController();
  const res = await fetch(url, { headers, signal: abort.signal });
  const frames: SseFrame[] = [];
  const waiters: (() => void)[] = [];
  let done = false;
  if (res.body) {
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          buf += value;
          let cut: number;
          while ((cut = buf.indexOf('\n\n')) !== -1) {
            const frame = parseFrame(buf.slice(0, cut));
            buf = buf.slice(cut + 2);
            if (frame) frames.push(frame);
          }
          for (const w of waiters.splice(0)) w();
        }
      } catch {
        // aborted
      } finally {
        done = true;
        for (const w of waiters.splice(0)) w();
      }
    })();
  }
  return {
    status: res.status,
    headers: res.headers,
    frames,
    async waitFor(n, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (frames.length < n) {
        if (done) throw new Error(`stream ended with ${frames.length}/${n} frames`);
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`timed out with ${frames.length}/${n} frames`);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, left);
          waiters.push(() => {
            clearTimeout(t);
            resolve();
          });
        });
      }
      return frames;
    },
    close() {
      abort.abort();
    },
  };
}
