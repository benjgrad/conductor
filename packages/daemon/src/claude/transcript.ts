// Read a session's history from Claude Code's own transcript (ADR-0008). Claude Code writes every
// conversation to `<config dir>/projects/<cwd-slug>/<claude_session_id>.jsonl`, where the slug is
// the realpath of the cwd with every non-alphanumeric character replaced by `-`. The daemon maps
// its lines to the same output streams the live stream parser produces (stream-parser.ts), so the
// web renders history and live output the same way. Read-only; nothing here writes.
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  TRANSCRIPT_MAX_BYTES,
  TRANSCRIPT_RESULT_CHARS,
  type OutputStream,
  type TranscriptChunk,
} from '@conductor/shared';

/** Cap on any non-tool-result chunk (a tool_use with a large Write input, a long message). */
export const TRANSCRIPT_TEXT_CHARS = 64 * 1024;
/** Only the last this many bytes of a transcript file are read (the reply keeps the recent end). */
export const TRANSCRIPT_READ_BYTES = 32 * 1024 * 1024;

const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Claude Code's project dir name for a cwd: the realpath with non-alphanumerics → `-`. */
export function claudeProjectSlug(realCwd: string): string {
  return realCwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The realpath Claude saw as its cwd. The worktree may be gone (removed after the session); its
 * parent (`<root>/wt`) normally still exists, so resolve that and re-append the name, which
 * keeps symlinked roots right (`/tmp` → `/private/tmp` on macOS).
 */
export function realCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    try {
      return join(realpathSync(dirname(cwd)), basename(cwd));
    } catch {
      return cwd;
    }
  }
}

/**
 * The transcript file for a Claude session that ran in `cwd`, or null. First the exact path;
 * then any project dir holding `<id>.jsonl` (a `--resume` from another cwd), newest first. The
 * id comes from the daemon's own store and must be a uuid, so it can't escape `projects/`.
 */
export function findTranscript(
  configDir: string,
  cwd: string,
  claudeSessionId: string,
): string | null {
  if (!CLAUDE_SESSION_ID.test(claudeSessionId)) return null;
  const projects = join(configDir, 'projects');
  const file = `${claudeSessionId}.jsonl`;
  const exact = join(projects, claudeProjectSlug(realCwd(cwd)), file);
  if (existsSync(exact)) return exact;
  let best: { path: string; mtime: number } | null = null;
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = join(projects, d, file);
    try {
      const st = statSync(p);
      if (st.isFile() && (best === null || st.mtimeMs > best.mtime)) {
        best = { path: p, mtime: st.mtimeMs };
      }
    } catch {
      // not in this project dir
    }
  }
  return best?.path ?? null;
}

/** The last TRANSCRIPT_READ_BYTES of the file, cut at a line start; `cut` if anything was skipped. */
export function readTranscriptTail(path: string): { text: string; cut: boolean } {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - TRANSCRIPT_READ_BYTES);
    const buf = Buffer.alloc(size - start);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, start + off);
      if (n === 0) break;
      off += n;
    }
    let text = buf.subarray(0, off).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, cut: start > 0 };
  } finally {
    closeSync(fd);
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Same rendering as the live parser: string as is, text blocks joined, anything else as JSON. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : JSON.stringify(c)))
      .join('\n');
  }
  return content === undefined ? '' : JSON.stringify(content);
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated: ${text.length - max} more characters]`;
}

/**
 * Map transcript JSONL to output chunks (ADR-0008):
 * - `assistant` `text` → `assistant`; `tool_use` → `tool_use` as `Name {json input}`, exactly
 *   like the live parser; `thinking` and other blocks are skipped;
 * - `user` string prompt or `text` blocks → `user`; `tool_result` → `tool_result`, each cut at
 *   TRANSCRIPT_RESULT_CHARS with a marker;
 * - everything else (attachments, queue operations, api requests, system lines, meta and
 *   sidechain lines, unparseable lines) is skipped.
 * Then the most recent chunks whose JSON fits TRANSCRIPT_MAX_BYTES are kept (`truncated` if any
 * were dropped). `ts` is the line's timestamp, else the previous one, else the epoch.
 */
export function transcriptChunks(jsonl: string): { chunks: TranscriptChunk[]; truncated: boolean } {
  const all: TranscriptChunk[] = [];
  let lastTs = new Date(0).toISOString();
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(m) || (m.type !== 'user' && m.type !== 'assistant')) continue;
    if (m.isSidechain === true || m.isMeta === true) continue;
    if (typeof m.timestamp === 'string' && !Number.isNaN(Date.parse(m.timestamp))) {
      lastTs = new Date(m.timestamp).toISOString();
    }
    const ts = lastTs;
    const push = (stream: OutputStream, text: string, max = TRANSCRIPT_TEXT_CHARS) =>
      all.push({ stream, text: cap(text, max), ts });
    const message = isObj(m.message) ? m.message : {};
    const content = message.content;
    if (m.type === 'user' && typeof content === 'string') {
      if (content.trim() !== '') push('user', content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    const userText: string[] = [];
    for (const c of content) {
      if (!isObj(c)) continue;
      if (m.type === 'assistant') {
        if (c.type === 'text' && typeof c.text === 'string' && c.text.trim() !== '') {
          push('assistant', c.text);
        } else if (c.type === 'tool_use') {
          const name = typeof c.name === 'string' ? c.name : '?';
          push('tool_use', `${name} ${JSON.stringify(c.input ?? {})}`);
        }
      } else if (c.type === 'tool_result') {
        push('tool_result', toolResultText(c.content), TRANSCRIPT_RESULT_CHARS);
      } else if (c.type === 'text' && typeof c.text === 'string') {
        userText.push(c.text);
      }
    }
    const prompt = userText.join('\n');
    if (prompt.trim() !== '') push('user', prompt);
  }
  // Keep the most recent chunks that fit the byte cap.
  let bytes = 0;
  let first = all.length;
  while (first > 0) {
    const size = Buffer.byteLength(JSON.stringify(all[first - 1]), 'utf8') + 1;
    if (bytes + size > TRANSCRIPT_MAX_BYTES) break;
    bytes += size;
    first -= 1;
  }
  return { chunks: all.slice(first), truncated: first > 0 };
}
