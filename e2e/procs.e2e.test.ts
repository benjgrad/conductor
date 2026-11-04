// matchProcesses (harness/procs.ts, MR-T16b): pure, no stack. The Windows teardown and the
// process-gone scenario rely on it to find a launcher in the temp dir and its node child.
import { describe, expect, it } from 'vitest';
import { matchProcesses, type ProcessRow } from './harness/procs.js';

const row = (
  ProcessId: number,
  ParentProcessId: number,
  CommandLine: string | null,
): ProcessRow => ({
  ProcessId,
  ParentProcessId,
  CommandLine,
});

describe('matchProcesses', () => {
  const rows = [
    row(1, 0, 'C:\\Windows\\system32\\wininit.exe'),
    row(10, 1, 'C:\\repo\\target\\release\\conductor-daemon.exe'),
    row(20, 10, '"C:\\Temp\\conductor-e2e-ab\\bin\\claude.exe" --session-id s1'),
    row(21, 20, '"C:\\node.exe" C:\\repo\\fake-claude.mjs --session-id s1'),
    row(22, 21, 'C:\\node.exe C:\\Windows\\npm-cli.js run build'),
    row(30, 10, null),
    row(99, 1, 'node vitest C:\\Temp\\conductor-e2e-ab'),
  ];

  it('a direct match and its descendants, two levels down; unrelated ones left alone', () => {
    expect(matchProcesses(rows, 'c:\\temp\\conductor-e2e-ab', 99).sort()).toEqual([20, 21, 22]);
  });

  it('matches by text anywhere in the command line (a session id)', () => {
    expect(matchProcesses(rows, 's1', 99).sort()).toEqual([20, 21, 22]);
  });

  it('never returns itself', () => {
    expect(matchProcesses(rows, 'conductor-e2e-ab', 99)).not.toContain(99);
  });

  it('a single object (one process) and null (none)', () => {
    expect(matchProcesses(row(5, 1, 'x claude.exe'), 'claude', 0)).toEqual([5]);
    expect(matchProcesses(null, 'claude', 0)).toEqual([]);
  });

  it('a null command line never matches by itself', () => {
    expect(matchProcesses([row(30, 1, null)], '', 0)).toEqual([]);
  });

  it('a self-parented row (Windows pid 0) does not loop', () => {
    const got = matchProcesses([row(0, 0, 'System Idle'), row(4, 0, null)], 'idle', -1);
    expect(got.sort()).toEqual([0, 4]);
  });
});
