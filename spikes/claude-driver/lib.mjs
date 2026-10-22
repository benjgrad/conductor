// Shared helpers for the M1-T00 spike scripts. Throwaway code: not shipped.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });

export const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
export const MODEL = process.env.SPIKE_MODEL ?? 'haiku';

/** A scratch git repo standing in for a session worktree. */
export function scratchRepo(tag) {
  const dir = mkdtempSync(join(tmpdir(), `conductor-spike-${tag}-`));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=spike@example.com', '-c', 'user.name=spike', 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

/**
 * Flags every spike run uses. These are the isolation flags the daemon would
 * pass too: no user/project settings (no hooks, plugins, or the user's MCP
 * servers), only our MCP config, nobody to answer permission prompts, and a
 * hard spend cap.
 */
export function baseArgs({ maxTurns = 4, budgetUsd = 0.3 } = {}) {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', MODEL,
    '--max-turns', String(maxTurns),
    '--max-budget-usd', String(budgetUsd),
    '--setting-sources', '',
    '--strict-mcp-config',
    '--permission-prompts', 'none',
  ];
}

/** User message in the stream-json input format. */
export function userMsg(text, sessionId = '') {
  return JSON.stringify({
    type: 'user',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  }) + '\n';
}

/**
 * Spawn the CLI and expose its NDJSON stdout as parsed messages.
 * Every raw line is appended to out/<name>.ndjson so the run is inspectable.
 */
export function spawnClaude(name, args, { cwd, env } = {}) {
  const raw = createWriteStream(join(OUT, `${name}.ndjson`));
  const errLog = createWriteStream(join(OUT, `${name}.stderr.log`));
  const t0 = Date.now();
  const child = spawn(CLAUDE_BIN, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.pipe(errLog);
  const listeners = new Set();
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    raw.write(line + '\n');
    let msg;
    try { msg = JSON.parse(line); } catch { msg = { type: '_unparsed', line }; }
    msg._t = Date.now() - t0;
    for (const l of listeners) l(msg);
  });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => {
    raw.end(); errLog.end();
    resolve({ code, signal, ms: Date.now() - t0 });
  }));
  return {
    child,
    onMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Resolve with the next message matching pred. */
    next(pred, timeoutMs = 120_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error(`timeout waiting in ${name}`)); }, timeoutMs);
        const off = this.onMessage((m) => { if (pred(m)) { clearTimeout(timer); off(); resolve(m); } });
      });
    },
    send(text, sessionId) { child.stdin.write(userMsg(text, sessionId)); },
    writeRaw(obj) { child.stdin.write(JSON.stringify(obj) + '\n'); },
    endInput() { child.stdin.end(); },
    exited,
  };
}

/** Compact one-line summary of a stream-json message for the human-readable log. */
export function summarize(m) {
  switch (m.type) {
    case 'system':
      if (m.subtype === 'init') return `system/init session_id=${m.session_id} model=${m.model} permissionMode=${m.permissionMode} tools=[${m.tools?.join(',')}] mcp=${JSON.stringify(m.mcp_servers)}`;
      return `system/${m.subtype} ${JSON.stringify(m).slice(0, 200)}`;
    case 'assistant': {
      const parts = (m.message?.content ?? []).map((c) =>
        c.type === 'text' ? `text:${JSON.stringify(c.text)}` :
        c.type === 'tool_use' ? `tool_use:${c.name}(${JSON.stringify(c.input)}) id=${c.id}` :
        c.type);
      return `assistant ${parts.join(' | ')}`;
    }
    case 'user': {
      const parts = (m.message?.content ?? []).map((c) =>
        c.type === 'tool_result' ? `tool_result(${c.tool_use_id}${c.is_error ? ',ERROR' : ''}):${JSON.stringify(typeof c.content === 'string' ? c.content : c.content?.map?.((x) => x.text).join(''))}`.slice(0, 300) :
        c.type === 'text' ? `text:${JSON.stringify(c.text)}` : c.type);
      return `user ${parts.join(' | ')}`;
    }
    case 'result':
      return `result/${m.subtype} is_error=${m.is_error} session_id=${m.session_id} num_turns=${m.num_turns} total_cost_usd=${m.total_cost_usd} usage=${JSON.stringify({ in: m.usage?.input_tokens, out: m.usage?.output_tokens, cache_read: m.usage?.cache_read_input_tokens, cache_create: m.usage?.cache_creation_input_tokens })} denials=${JSON.stringify(m.permission_denials ?? [])} result=${JSON.stringify(m.result)?.slice(0, 200)}`;
    default:
      return `${m.type} ${JSON.stringify(m).slice(0, 200)}`;
  }
}

/** Line logger that writes to stdout and out/<name>.log. */
export function logger(name) {
  const f = createWriteStream(join(OUT, `${name}.log`));
  const t0 = Date.now();
  const log = (...a) => {
    const line = `[+${String(Date.now() - t0).padStart(6)}ms] ${a.join(' ')}`;
    console.log(line);
    f.write(line + '\n');
  };
  log.close = () => new Promise((r) => f.end(r));
  return log;
}
