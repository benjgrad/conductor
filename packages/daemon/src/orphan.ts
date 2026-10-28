import { exeName, sameExecutable, type ProcInfo } from './platform/index.js';
import { parsePsLine } from './platform/procinfo.js';
import { CLAUDE_SESSION_ID } from './claude/transcript.js';

// BUG-1b (10-contracts §Orphaned processes rule 7, ADR-0005 amendment): how the startup sweep
// decides a live pid is a Claude process this daemon started. A process is ours only if its start
// time equals the one recorded at spawn, its argv is the configured Claude binary, and that argv
// carries `--session-id <id>` / `--resume <id>` with the stored (UUID-shaped) id. Anything else is
// someone else's (a user's own `claude --resume`, a `grep <uuid>`, a reused pid) and is left alone.

export { readProcInfo, type ProcInfo } from './platform/index.js';

/** Parse the start of a `ps lstart` field (printed in UTC) to ms epoch. */
export function parseLstart(s: string): number | null {
  return parsePsLine(s)?.startedAt ?? null;
}

export type OwnCheck = { ok: true } | { ok: false; reason: string };

const INTERPRETER = /^node(\d+)?$/;

/**
 * argv[0] is the binary, or argv[1] after `node` (a `#!/usr/bin/env node` launcher such as npm's
 * `claude`, or `node.exe …\\cli.js` on win32). Names compare via `exeName` (win32: `claude.exe`
 * is `claude`, case-insensitive).
 */
function isClaudeBinary(command: string, tokens: readonly string[], claudeBin: string): boolean {
  // A configured path with spaces doesn't survive whitespace tokenising: compare the raw prefix.
  if (command === claudeBin || command.startsWith(`${claudeBin} `)) return true;
  const matches = (tok: string | undefined): boolean =>
    tok !== undefined &&
    (sameExecutable(tok, claudeBin) ||
      exeName(tok) === 'claude' ||
      exeName(tok) === exeName(claudeBin));
  if (matches(tokens[0])) return true;
  return INTERPRETER.test(exeName(tokens[0] ?? '')) && matches(tokens[1]);
}

/** Is `info` the Claude process the daemon recorded as `stored`? The reason goes into the log. */
export function checkOurs(
  info: (Pick<ProcInfo, 'startedAt' | 'command'> & { argv?: readonly string[] }) | null,
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
  // win32: argv parsed with CommandLineToArgvW rules (quoted `C:\\Program Files\\…`).
  const tokens = info.argv ?? info.command.trim().split(/\s+/);
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
