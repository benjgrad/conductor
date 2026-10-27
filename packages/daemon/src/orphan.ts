import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { CLAUDE_SESSION_ID } from './claude/transcript.js';

// BUG-1b (10-contracts §Orphaned processes rule 7, ADR-0005 amendment): how the startup sweep
// decides a live pid is a Claude process this daemon started. A process is ours only if its start
// time equals the one recorded at spawn, its argv is the configured Claude binary, and that argv
// carries `--session-id <id>` / `--resume <id>` with the stored (UUID-shaped) id. Anything else is
// someone else's (a user's own `claude --resume`, a `grep <uuid>`, a reused pid) and is left alone.

/** What `ps` says about a pid: its start time (ms epoch, 1 s precision) and its command line. */
export interface ProcInfo {
  startedAt: number;
  command: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// `ps -o lstart` (LC_ALL=C): `Tue Oct 27 10:11:12 2026`, day space-padded. Some locales put the
// day before the month (`Tue 27 Oct …`); both are accepted.
const LSTART =
  /^\s*[A-Za-z]{3}\s+(?:([A-Za-z]{3})\s+(\d{1,2})|(\d{1,2})\s+([A-Za-z]{3}))\s+(\d{1,2}):(\d\d):(\d\d)\s+(\d{4})/;

/** Parse the start of a `ps lstart` field (printed in UTC, see readProcInfo) to ms epoch. */
export function parseLstart(s: string): number | null {
  return splitPsLine(s)?.startedAt ?? null;
}

function splitPsLine(line: string): ProcInfo | null {
  const m = LSTART.exec(line);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1] ?? m[4] ?? '');
  if (month < 0) return null;
  const day = Number(m[2] ?? m[3]);
  const startedAt = Date.UTC(Number(m[8]), month, day, Number(m[5]), Number(m[6]), Number(m[7]));
  return { startedAt, command: line.slice(m[0].length).trim() };
}

/**
 * The start time and command line of a pid, from one `ps` call (so both describe the same
 * process), or null when it is gone or unreadable. `TZ=UTC` keeps the value independent of the
 * daemon's time zone and DST; `-ww` keeps Linux from truncating the command line.
 */
export function readProcInfo(pid: number): ProcInfo | null {
  let out: string;
  try {
    out = execFileSync('ps', ['-ww', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
  } catch {
    return null;
  }
  return splitPsLine(out.trim());
}

export type OwnCheck = { ok: true } | { ok: false; reason: string };

const INTERPRETER = /^node(\d+)?$/;

/** argv[0] is the binary, or argv[1] after `node` (a `#!/usr/bin/env node` launcher such as npm's `claude`). */
function isClaudeBinary(command: string, tokens: readonly string[], claudeBin: string): boolean {
  // A configured path with spaces doesn't survive tokenising: compare the raw prefix.
  if (command === claudeBin || command.startsWith(`${claudeBin} `)) return true;
  const matches = (tok: string | undefined): boolean =>
    tok !== undefined &&
    (tok === claudeBin || basename(tok) === 'claude' || basename(tok) === basename(claudeBin));
  if (matches(tokens[0])) return true;
  return INTERPRETER.test(basename(tokens[0] ?? '')) && matches(tokens[1]);
}

/** Is `info` the Claude process the daemon recorded as `stored`? The reason goes into the log. */
export function checkOurs(
  info: ProcInfo | null,
  stored: { startedAt?: number | undefined; claudeSessionId?: string | undefined },
  claudeBin: string,
): OwnCheck {
  const id = stored.claudeSessionId;
  if (id === undefined || !CLAUDE_SESSION_ID.test(id)) {
    return { ok: false, reason: 'invalid stored claude session id' };
  }
  if (stored.startedAt === undefined) return { ok: false, reason: 'no recorded start time' };
  if (info === null) return { ok: false, reason: 'cannot read process info' };
  if (info.startedAt !== stored.startedAt) {
    return { ok: false, reason: 'start time differs (pid reused)' };
  }
  const tokens = info.command.trim().split(/\s+/);
  if (!isClaudeBinary(info.command.trim(), tokens, claudeBin)) {
    return { ok: false, reason: 'not the claude binary' };
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    if ((tokens[i] === '--session-id' || tokens[i] === '--resume') && tokens[i + 1] === id) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'argv lacks --session-id/--resume <id>' };
}
