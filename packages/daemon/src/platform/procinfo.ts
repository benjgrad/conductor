import { execFileSync } from 'node:child_process';
import { system32 } from './spawn.js';
import { posix as posixPath, win32 as win32Path } from 'node:path';

// ADR-0024 §1 (procinfo.ts): the start time and command line of a live pid, for the orphan sweep
// (BUG-1b, 10-contracts §Orphaned processes rule 7). The start time defeats pid reuse, which is
// fast on Windows, so it must be read in the same call as the command line.
//
// POSIX: `ps -ww -o lstart= -o command=` (LC_ALL=C, TZ=UTC). `argv` is the command line split
// on whitespace, the same lossy view `checkOurs` used before it took argv.
// win32: `Get-CimInstance Win32_Process` through Windows PowerShell. CreationDate is formatted in
// PowerShell as ISO-8601 UTC (ConvertTo-Json's own DateTime shape differs between 5.1 and 7);
// the parser still accepts the other shapes. CommandLine is split with CommandLineToArgvW rules.

export interface ProcInfo {
  /** Process start, ms since the epoch (POSIX: 1 s precision; win32: 1 ms). */
  startedAt: number;
  /** The raw command line. */
  command: string;
  /** The command line split into arguments (see the header for how exact that is per OS). */
  argv: string[];
  /** win32 only: the image path from CIM. */
  executablePath?: string;
}

// ---------------------------------------------------------------- POSIX (copied from orphan.ts)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// `ps -o lstart` (LC_ALL=C): `Tue Oct 27 10:11:12 2026`, day space-padded. Some locales put the
// day before the month (`Tue 27 Oct …`); both are accepted.
const LSTART =
  /^\s*[A-Za-z]{3}\s+(?:([A-Za-z]{3})\s+(\d{1,2})|(\d{1,2})\s+([A-Za-z]{3}))\s+(\d{1,2}):(\d\d):(\d\d)\s+(\d{4})/;

/** Parse one `ps -o lstart= -o command=` line (lstart printed in UTC). Pure. */
export function parsePsLine(line: string): ProcInfo | null {
  const m = LSTART.exec(line);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1] ?? m[4] ?? '');
  if (month < 0) return null;
  const day = Number(m[2] ?? m[3]);
  const startedAt = Date.UTC(Number(m[8]), month, day, Number(m[5]), Number(m[6]), Number(m[7]));
  const command = line.slice(m[0].length).trim();
  return { startedAt, command, argv: command === '' ? [] : command.split(/\s+/) };
}

function readPosix(pid: number): ProcInfo | null {
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
  return parsePsLine(out.trim());
}

// ---------------------------------------------------------------- win32

/**
 * Split a Windows command line the way `CommandLineToArgvW` does (Wine's implementation of it,
 * which matches Windows):
 * - argv[0] is special: if it starts with `"` it runs to the next `"` (no escapes), otherwise to
 *   the first space or tab;
 * - later arguments are separated by spaces/tabs outside quotes;
 * - 2n backslashes + `"` → n backslashes and the quote toggles quoting; 2n+1 backslashes + `"` →
 *   n backslashes and a literal `"`; other backslashes are literal;
 * - a run of quotes counts towards 3: every third quote is a literal `"` and the run ends
 *   quoting if the count is then 0 or 2 (so `""` inside quotes is a literal `"` and ends them).
 * Pure.
 */
export function parseWindowsCommandLine(cmdline: string): string[] {
  const s = cmdline;
  const out: string[] = [];
  let i = 0;
  let arg0 = '';
  if (s[0] === '"') {
    i = 1;
    while (i < s.length && s[i] !== '"') arg0 += s[i++];
    if (i < s.length) i++;
  } else {
    while (i < s.length && s[i] !== ' ' && s[i] !== '\t') arg0 += s[i++];
  }
  out.push(arg0);
  while (s[i] === ' ' || s[i] === '\t') i++;

  let cur = '';
  let inArg = false;
  let qcount = 0;
  let bcount = 0;
  while (i < s.length) {
    const c = s[i] ?? '';
    if ((c === ' ' || c === '\t') && qcount === 0) {
      if (inArg) out.push(cur);
      cur = '';
      inArg = false;
      bcount = 0;
      i++;
      continue;
    }
    inArg = true;
    if (c === '\\') {
      cur += c;
      bcount++;
      i++;
      continue;
    }
    if (c === '"') {
      if (bcount % 2 === 0) {
        cur = cur.slice(0, cur.length - bcount / 2);
        qcount++;
      } else {
        cur = cur.slice(0, cur.length - (bcount + 1) / 2) + '"';
      }
      i++;
      bcount = 0;
      while (s[i] === '"') {
        if (++qcount === 3) {
          cur += '"';
          qcount = 0;
        }
        i++;
      }
      if (qcount === 2) qcount = 0;
      continue;
    }
    cur += c;
    bcount = 0;
    i++;
  }
  if (inArg) out.push(cur);
  return out;
}

const DMTF = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\.(\d{6})([+-])(\d{3})$/;
const MS_DATE = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/;

/**
 * Parse a CIM CreationDate in any shape PowerShell can hand us, to ms epoch (truncated to whole
 * ms, so two reads of one process agree):
 * - ISO-8601 with an offset or `Z` (what our script prints; PowerShell 7's ConvertTo-Json);
 * - `/Date(ms)/` (Windows PowerShell 5.1's ConvertTo-Json), the offset suffix being display-only;
 * - `{ value: '/Date(ms)/', DateTime: … }` (5.1 with ETS properties);
 * - DMTF `yyyymmddHHMMSS.ffffff+UUU` (raw WMI; UUU = minutes east of UTC);
 * - a number (ms epoch).
 * Null for anything else. Pure.
 */
export function parseCimDate(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (v !== null && typeof v === 'object' && 'value' in v) return parseCimDate(v.value);
  if (typeof v !== 'string') return null;
  const ms = MS_DATE.exec(v);
  if (ms) return Number(ms[1]);
  const d = DMTF.exec(v);
  if (d) {
    const [, y, mo, da, h, mi, se, us, sign, off] = d;
    const utc = Date.UTC(+y!, +mo! - 1, +da!, +h!, +mi!, +se!, Math.trunc(+us! / 1000));
    return utc - (sign === '-' ? -1 : 1) * +off! * 60_000;
  }
  // ISO: only with an explicit zone, so the daemon's own time zone never leaks in.
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v)) return null;
  // Date.parse keeps ms; extra fractional digits (.1234567) are truncated by it.
  const t = Date.parse(v.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(t) ? null : t;
}

/** Turn our PowerShell script's JSON output into a ProcInfo. Null when absent/unreadable. Pure. */
export function parseCimProcessJson(json: string): ProcInfo | null {
  const text = json.trim();
  if (text === '') return null; // no such process
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(raw)) raw = raw[0];
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const startedAt = parseCimDate(r.CreationDate);
  // CommandLine is null for another user's process without admin rights: unreadable.
  if (startedAt === null || typeof r.CommandLine !== 'string') return null;
  const info: ProcInfo = {
    startedAt,
    command: r.CommandLine,
    argv: parseWindowsCommandLine(r.CommandLine),
  };
  if (typeof r.ExecutablePath === 'string') info.executablePath = r.ExecutablePath;
  return info;
}

/** The PowerShell script for one pid. `pid` is an integer, so the filter can't be injected. */
export function cimScript(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new RangeError(`bad pid ${pid}`);
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ProcessId,ExecutablePath,CommandLine,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress`,
  ].join('; ');
}

function readWin32(pid: number): ProcInfo | null {
  let out: string;
  try {
    out = execFileSync(
      system32('WindowsPowerShell\\v1.0\\powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', cimScript(pid)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30_000 },
    );
  } catch {
    return null;
  }
  return parseCimProcessJson(out);
}

/**
 * The start time and command line of a pid, from one OS call (so both describe the same
 * process), or null when it is gone or unreadable.
 */
export function readProcInfo(pid: number): ProcInfo | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return process.platform === 'win32' ? readWin32(pid) : readPosix(pid);
}

/**
 * The comparable name of an executable: its basename, and on win32 also lower-cased without an
 * `.exe`/`.cmd`/`.bat`/`.com` extension (`C:\\…\\Claude.EXE` → `claude`). Paths are compared the
 * same way by `sameExecutable`.
 */
export function exeName(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return posixPath.basename(path);
  return win32Path
    .basename(path)
    .replace(/\.(?:exe|cmd|bat|com)$/i, '')
    .toLowerCase();
}

/** Same executable path: exact on POSIX; case- and extension-insensitive on win32. */
export function sameExecutable(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return a === b;
  const norm = (p: string) =>
    win32Path
      .normalize(p)
      .replace(/\.(?:exe|cmd|bat|com)$/i, '')
      .toLowerCase();
  return norm(a) === norm(b);
}
