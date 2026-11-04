import { describe, expect, it } from 'vitest';
import type { AdvisorRows, CheckRunRow, MoveRow } from './metrics.js';
import {
  compareMetrics,
  effectValue,
  ProposeChangeInputSchema,
  REVIEW_MAX_DAYS,
  reviewWindowDays,
  type ExpectedEffect,
} from './proposal.js';

// ADR-0033 P3: the proposal contract and the before/after comparison. Pure.

const META = {
  title: 'Run the build in m-one',
  rationale: 'The root has no package.json, so the default build fails every time.',
  evidence: [{ finding_id: 'failing_check:npm run build', text: '5 of 5 runs failed' }],
  expected_effect: {
    metric: 'check_failure_rate',
    scope: { check: 'npm run build' },
    direction: 'down',
    text: 'The build check stops failing.',
  },
  rollback: 'clear_repo_checks github.com/acme/app',
};
const REPO_CHANGE = {
  kind: 'repo_checks',
  repo: 'github.com/acme/app',
  checks: { checks: [{ name: 'build', cmd: 'cd m-one && npm ci && npm run build' }] },
};

describe('ProposeChangeInputSchema', () => {
  it('accepts a repo-checks change, a clear and a workflow change', () => {
    expect(ProposeChangeInputSchema.safeParse({ ...META, change: REPO_CHANGE }).success).toBe(true);
    const clear = { ...REPO_CHANGE, checks: null };
    expect(ProposeChangeInputSchema.safeParse({ ...META, change: clear }).success).toBe(true);
    const wf = { kind: 'workflow', workflow_id: 'conductor', base_version: 4, definition: {} };
    expect(ProposeChangeInputSchema.safeParse({ ...META, change: wf }).success).toBe(true);
  });

  it('rejects an unknown kind (machine settings, permissions) and extra keys', () => {
    for (const change of [
      { kind: 'machine_settings', machine_id: 'm1', permission_mode: 'bypassPermissions' },
      { ...REPO_CHANGE, permission_mode: 'bypassPermissions' },
    ]) {
      expect(ProposeChangeInputSchema.safeParse({ ...META, change }).success).toBe(false);
    }
    expect(
      ProposeChangeInputSchema.safeParse({ ...META, change: REPO_CHANGE, auto_apply: true })
        .success,
    ).toBe(false);
  });

  it('needs evidence and caps it at 8', () => {
    const bad = (evidence: unknown[]) =>
      ProposeChangeInputSchema.safeParse({ ...META, evidence, change: REPO_CHANGE }).success;
    expect(bad([])).toBe(false);
    expect(bad(Array.from({ length: 9 }, () => ({ text: 'x' })))).toBe(false);
  });
});

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const move = (ticket: string, to: string, min: number, visit = 1): MoveRow => ({
  session_id: `s-${ticket}`,
  ticket_id: ticket,
  repo: 'github.com/acme/app',
  workflow_id: 'conductor',
  machine_id: 'm1',
  from: null,
  to,
  transition: null,
  visit,
  at: at(min),
});
const run = (ticket: string, exit: number, cmd = 'npm run build'): CheckRunRow => ({
  session_id: `s-${ticket}`,
  ticket_id: ticket,
  repo: 'github.com/acme/app',
  machine_id: 'm1',
  state: 'implementing',
  cmd,
  exit_code: exit,
  timed_out: false,
  setup_failed: false,
  started_at: at(0),
  at: at(1),
});
const rows = (r: Partial<AdvisorRows>): AdvisorRows => ({
  moves: [],
  checks: [],
  inputs: [],
  permissions: [],
  ...r,
});
const effect = (e: Partial<ExpectedEffect>): ExpectedEffect => ({
  metric: 'check_failure_rate',
  scope: {},
  direction: 'down',
  text: 't',
  ...e,
});

describe('effectValue', () => {
  it('is null with no data', () => {
    for (const metric of [
      'median_stay',
      'p90_stay',
      'reentries',
      'check_failure_rate',
      'questions',
      'permission_denials',
    ] as const) {
      expect(effectValue(rows({}), { metric, scope: {} })).toEqual({ value: null, sample: 0 });
    }
  });

  it('narrows check failures to the scope', () => {
    const r = rows({ checks: [run('a', 1), run('b', 0), run('c', 1, 'npm test')] });
    expect(effectValue(r, { metric: 'check_failure_rate', scope: {} })).toEqual({
      value: 0.67,
      sample: 3,
    });
    expect(
      effectValue(r, { metric: 'check_failure_rate', scope: { check: 'npm run build' } }),
    ).toEqual({ value: 0.5, sample: 2 });
    expect(
      effectValue(r, { metric: 'check_failure_rate', scope: { repo: 'GitHub.com/acme/other' } }),
    ).toEqual({ value: null, sample: 0 });
  });

  it('median stay of one state and re-entries per ticket', () => {
    const r = rows({
      moves: [
        move('a', 'plan', 0),
        move('a', 'build', 10),
        move('a', 'plan', 30, 2),
        move('a', 'done', 40),
        move('b', 'plan', 0),
        move('b', 'done', 20),
      ],
    });
    expect(effectValue(r, { metric: 'median_stay', scope: { state: 'plan' } })).toEqual({
      value: 10,
      sample: 3,
    });
    expect(effectValue(r, { metric: 'reentries', scope: { state: 'plan' } })).toEqual({
      value: 0.5,
      sample: 2,
    });
  });
});

describe('compareMetrics', () => {
  const failing = rows({ checks: [run('a', 1), run('b', 1), run('c', 1)] });
  const passing = rows({ checks: [run('d', 0), run('e', 0), run('f', 1)] });

  it('reports the delta and whether it moved the expected way', () => {
    const c = compareMetrics(failing, passing, effect({}));
    expect(c).toMatchObject({ before: { value: 1 }, after: { value: 0.33 }, delta: -0.67 });
    expect(c.direction_met).toBe(true);
    expect(compareMetrics(failing, passing, effect({ direction: 'up' })).direction_met).toBe(false);
  });

  it('cannot tell with too few samples or no data on a side', () => {
    const few = rows({ checks: [run('a', 0)] });
    expect(compareMetrics(failing, few, effect({})).direction_met).toBeNull();
    const none = compareMetrics(failing, rows({}), effect({}));
    expect(none.delta).toBeNull();
    expect(none.direction_met).toBeNull();
  });
});

describe('reviewWindowDays', () => {
  const applied = new Date(T0);
  it('is null under a day, whole days after, capped', () => {
    expect(reviewWindowDays(applied, new Date(T0 + 3_600_000))).toBeNull();
    expect(reviewWindowDays(applied, new Date(T0 + 2.5 * 86_400_000))).toBe(2);
    expect(reviewWindowDays(applied, new Date(T0 + 90 * 86_400_000))).toBe(REVIEW_MAX_DAYS);
  });
});
