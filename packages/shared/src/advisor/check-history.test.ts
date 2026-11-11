import { describe, expect, it } from 'vitest';
import { checkRunStatus, healthHint, repoHealth, runsByCheck } from './check-history.js';
import type { CheckRunRow } from './metrics.js';

let n = 0;
function run(over: Partial<CheckRunRow> = {}): CheckRunRow {
  n++;
  return {
    session_id: `s${n}`,
    ticket_id: `t${n}`,
    repo: 'github.com/acme/app',
    machine_id: 'm1',
    state: 'implementing',
    cmd: 'npm test',
    exit_code: 0,
    timed_out: false,
    setup_failed: false,
    started_at: '2026-11-01T10:00:00.000Z',
    at: '2026-11-01T10:01:00.000Z',
    ...over,
  };
}

describe('checkRunStatus', () => {
  it('setup_failed, then timed_out, then the exit code', () => {
    expect(checkRunStatus({ exit_code: 1, timed_out: true, setup_failed: true })).toBe(
      'setup_failed',
    );
    expect(checkRunStatus({ exit_code: null, timed_out: true, setup_failed: false })).toBe(
      'timed_out',
    );
    expect(checkRunStatus({ exit_code: 2, timed_out: false, setup_failed: false })).toBe('fail');
    expect(checkRunStatus({ exit_code: null, timed_out: false, setup_failed: false })).toBe('fail');
    expect(checkRunStatus({ exit_code: 0, timed_out: false, setup_failed: false })).toBe('pass');
    expect(
      checkRunStatus({ exit_code: 0, timed_out: false, setup_failed: false, skipped: true }),
    ).toBe('skipped');
  });
});

describe('runsByCheck', () => {
  it('matches by cmd, dedupes checks (first name wins), newest first, counts the whole window', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((d) =>
      run({
        exit_code: d % 2,
        started_at: `2026-11-0${d}T10:00:00.000Z`,
        at: `2026-11-0${d}T10:00:30.000Z`,
      }),
    );
    rows.push(run({ cmd: 'other' }));
    const out = runsByCheck(
      [
        { name: 'Tests', cmd: 'npm test' },
        { name: 'Again', cmd: 'npm test' },
        { name: 'Build', cmd: 'npm run build' },
      ],
      rows,
      5,
      new Map([[rows[6]!.ticket_id, 'Newest ticket']]),
    );
    expect(out.map((c) => c.name)).toEqual(['Tests', 'Build']);
    const tests = out[0]!;
    expect(tests.runs).toHaveLength(5);
    expect(tests.runs.map((r) => r.at.slice(0, 10))).toEqual([
      '2026-11-07',
      '2026-11-06',
      '2026-11-05',
      '2026-11-04',
      '2026-11-03',
    ]);
    expect(tests.runs[0]).toMatchObject({
      status: 'fail',
      duration_ms: 30_000,
      ticket_title: 'Newest ticket',
    });
    expect(tests.runs[1]!.ticket_title).toBeNull();
    expect(tests.runs_in_window).toBe(7);
    expect(tests.failures_in_window).toBe(4);
    expect(out[1]).toMatchObject({ runs: [], runs_in_window: 0, failures_in_window: 0 });
  });

  it('clamps a negative duration to 0', () => {
    const [c] = runsByCheck(
      [{ name: 'T', cmd: 'npm test' }],
      [run({ started_at: '2026-11-01T10:05:00.000Z', at: '2026-11-01T10:00:00.000Z' })],
      5,
    );
    expect(c!.runs[0]!.duration_ms).toBe(0);
  });
});

describe('repoHealth', () => {
  it('groups by the repo key case-insensitively, newest statuses first', () => {
    const out = repoHealth([
      run({ repo: 'github.com/Acme/App', at: '2026-11-01T00:00:00.000Z' }),
      run({ repo: 'github.com/acme/app', exit_code: 1, at: '2026-11-03T00:00:00.000Z' }),
      run({ repo: 'github.com/acme/app', timed_out: true, at: '2026-11-02T00:00:00.000Z' }),
      run({ repo: 'github.com/b/c', at: '2026-11-01T00:00:00.000Z' }),
    ]);
    expect(out).toEqual([
      {
        repo: 'github.com/acme/app',
        runs: 3,
        failures: 2,
        last_run_at: '2026-11-03T00:00:00.000Z',
        last_status: 'fail',
        recent: ['fail', 'timed_out', 'pass'],
      },
      expect.objectContaining({ repo: 'github.com/b/c', runs: 1, failures: 0 }),
    ]);
  });

  it('keeps at most 5 recent statuses', () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      run({ at: `2026-11-0${i + 1}T00:00:00.000Z` }),
    );
    expect(repoHealth(rows)[0]!.recent).toHaveLength(5);
  });
});

describe('healthHint', () => {
  it('none, passing, failing, flaky', () => {
    expect(healthHint([])).toBe('none');
    expect(healthHint(['pass', 'pass'])).toBe('passing');
    expect(healthHint(['fail', 'timed_out', 'setup_failed', 'pass'])).toBe('failing');
    expect(healthHint(['fail'])).toBe('failing');
    expect(healthHint(['fail', 'pass', 'fail'])).toBe('flaky');
    expect(healthHint(['pass', 'fail'])).toBe('flaky');
  });
});

describe('skipped checks (R3)', () => {
  it('runsByCheck counts skips apart from runs and failures', () => {
    const rows = [run(), run({ exit_code: 1 }), run({ skipped: true })];
    const [c] = runsByCheck([{ name: 'Tests', cmd: 'npm test' }], rows, 5);
    expect(c).toMatchObject({ runs_in_window: 2, failures_in_window: 1, skips_in_window: 1 });
    expect(c!.runs.map((r) => r.status)).toContain('skipped');
  });

  it('repoHealth leaves skipped checks out, and healthHint ignores them', () => {
    const [h] = repoHealth([run({ at: '2026-11-01T09:00:00.000Z' }), run({ skipped: true })]);
    expect(h).toMatchObject({ runs: 1, failures: 0, recent: ['pass'] });
    expect(healthHint(['skipped', 'pass', 'skipped'])).toBe('passing');
    expect(healthHint(['skipped'])).toBe('none');
  });
});
