// Finding and killing the stack's processes on every OS (MR-T16b). POSIX uses `pgrep -f`; Windows
// has no pgrep, so it lists Win32_Process (pid, parent pid, command line) through PowerShell and
// matches here, including the descendants of each match: on Windows a fake runs as a launcher in
// the run's temp dir (crates/conductor-e2e-launcher) whose node child's command line may not
// mention the temp dir.
import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';
import { system32 } from './acl.js';

/** One row of `Get-CimInstance Win32_Process` (ConvertTo-Json). */
export interface ProcessRow {
  ProcessId: number;
  ParentProcessId: number;
  CommandLine: string | null;
}

/**
 * The pids whose command line contains `text` (case-insensitive: Windows paths), plus all their
 * descendants, never `selfPid`. `rows` is ConvertTo-Json's output: an array, or one object when
 * there is a single process. Pure.
 */
export function matchProcesses(
  rows: ProcessRow | ProcessRow[] | null,
  text: string,
  selfPid: number,
): number[] {
  const list = rows === null ? [] : Array.isArray(rows) ? rows : [rows];
  const needle = text.toLowerCase();
  const found = new Set<number>(
    list
      .filter((r) => r.ProcessId !== selfPid && r.CommandLine?.toLowerCase().includes(needle))
      .map((r) => r.ProcessId),
  );
  // Descendants: repeat until no new child joins (bounded by the number of rows).
  for (let grew = true; grew;) {
    grew = false;
    for (const r of list) {
      if (r.ProcessId === selfPid || found.has(r.ProcessId) || r.ProcessId === r.ParentProcessId) {
        continue;
      }
      if (found.has(r.ParentProcessId)) {
        found.add(r.ProcessId);
        grew = true;
      }
    }
  }
  return [...found];
}

const LIST_WIN32 =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';

/** The pids of the processes whose command line mentions `text` (and, on Windows, their children). */
export function findProcesses(text: string): number[] {
  if (process.platform === 'win32') {
    const out = execFileSync(
      win32.join(system32('WindowsPowerShell'), 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', LIST_WIN32],
      {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return matchProcesses(
      out.trim() === '' ? null : (JSON.parse(out) as ProcessRow | ProcessRow[]),
      text,
      process.pid,
    );
  }
  try {
    return execFileSync('pgrep', ['-f', text], { encoding: 'utf8' })
      .split('\n')
      .map((l) => Number(l.trim()))
      .filter((n) => n > 0 && n !== process.pid);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

/** Kill `pid` at once: POSIX SIGKILL; Windows `taskkill /T /F` (its whole tree). Gone is fine. */
export function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execFileSync(system32('taskkill.exe'), ['/T', '/F', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // already gone
  }
}
