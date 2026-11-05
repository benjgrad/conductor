import type { ChecksGate, RepoChecksDto, WorkflowDefinition } from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { compareRows, gateCountText, gateTitle, repoRows } from './repo-checks-model.js';

const dto = (repo: string): RepoChecksDto => ({
  repo,
  setup: null,
  checks: [{ name: 'Build', cmd: 'make' }],
  updated_at: '2026-10-22T12:00:00.000Z',
  updated_by: null,
});
const sug = (repo: string) => ({ repo, ticket_count: 0, last_used_at: null });

describe('repoRows', () => {
  it('merges the known repos with the overrides, one row per repo, the override’s spelling', () => {
    const { own, workflow } = repoRows(
      [sug('GitHub.com/Acme/Shop'), sug('github.com/z/app'), sug('github.com/a/lib')],
      [dto('github.com/acme/shop'), dto('github.com/b/only-override')],
      '',
    );
    expect(own.map((r) => r.repo)).toEqual(['github.com/acme/shop', 'github.com/b/only-override']);
    // listRepos order (frecency), not by name.
    expect(workflow.map((r) => r.repo)).toEqual(['github.com/z/app', 'github.com/a/lib']);
    expect(workflow.every((r) => r.override === null)).toBe(true);
  });

  it('filters both groups, any case', () => {
    const { own, workflow } = repoRows(
      [sug('github.com/z/app'), sug('github.com/a/lib')],
      [dto('github.com/acme/shop')],
      'SHO',
    );
    expect(own.map((r) => r.repo)).toEqual(['github.com/acme/shop']);
    expect(workflow).toEqual([]);
  });
});

const def = {
  states: {
    implementing: {
      type: 'agent',
      title: 'Implementing',
      on: {
        pr_ready_for_review: { goto: 'needs_input', title: 'PR ready for review' },
        'plain.name': 'needs_input',
      },
    },
    needs_input: { type: 'human', title: 'Needs input' },
  },
} as unknown as Pick<WorkflowDefinition, 'states'>;

describe('gateTitle', () => {
  it('reads a transition gate as from → to (title)', () => {
    expect(gateTitle(def, 'implementing.pr_ready_for_review')).toBe(
      'Implementing → Needs input (PR ready for review)',
    );
  });
  it('splits on the first dot and words an untitled transition', () => {
    expect(gateTitle(def, 'implementing.plain.name')).toBe(
      'Implementing → Needs input (Plain name)',
    );
  });
  it('reads an entry gate as Entering <state>', () => {
    expect(gateTitle(def, 'implementing')).toBe('Entering Implementing');
  });
  it('keeps an unknown id, or any id without a definition', () => {
    expect(gateTitle(def, 'nowhere.x')).toBe('nowhere.x');
    expect(gateTitle(def, 'implementing.nope')).toBe('implementing.nope');
    expect(gateTitle(null, 'implementing.pr_ready_for_review')).toBe(
      'implementing.pr_ready_for_review',
    );
  });
});

const wf = { setup: null, checks: [{ name: 'Build', cmd: 'npm run build' }] };
const gates = (n: number, spec = wf): ChecksGate[] =>
  Array.from({ length: n }, (_, i) => ({ at: `s.g${i}`, ...spec }));
const title = (at: string) => `T(${at})`;

describe('compareRows', () => {
  it('collapses identical gates into one "All N gates" row, the workflow’s checks', () => {
    const rows = compareRows({
      workflowGates: gates(3),
      savedOverride: null,
      draft: { checks: wf.checks, setup: undefined },
      dirty: false,
      title,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'All 3 gates', repo: null, changed: false });
  });

  it('previews a dirty draft as changed', () => {
    const rows = compareRows({
      workflowGates: gates(3),
      savedOverride: null,
      draft: { checks: [{ name: 'Build', cmd: 'make' }], setup: '' },
      dirty: true,
      title,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.changed).toBe(true);
    expect(rows[0]!.repo).toEqual({ setup: '', checks: [{ name: 'Build', cmd: 'make' }] });
  });

  it('an override with the draft unchanged runs the override, not changed', () => {
    const saved = { setup: '', checks: [{ name: 'Build', cmd: 'make' }] };
    const rows = compareRows({
      workflowGates: gates(2),
      savedOverride: saved,
      draft: { checks: saved.checks, setup: '' },
      dirty: false,
      title,
    });
    expect(rows).toEqual([
      { label: 'All 2 gates', gates: ['s.g0', 's.g1'], workflow: wf, repo: saved, changed: false },
    ]);
  });

  it('gates that differ get their own rows, by title', () => {
    const other = { setup: '', checks: [{ name: 'Lint', cmd: 'npm run lint' }] };
    const rows = compareRows({
      workflowGates: [...gates(2), { at: 's.lint', ...other }],
      savedOverride: null,
      draft: { checks: wf.checks, setup: undefined },
      dirty: false,
      title,
    });
    expect(rows.map((r) => r.label)).toEqual(['T(s.g0), T(s.g1)', 'T(s.lint)']);
  });
});

it('gateCountText', () => {
  expect(gateCountText(3)).toBe('Runs at all 3 check gates');
  expect(gateCountText(1)).toBe('Runs at the one check gate');
  expect(gateCountText(0)).toMatch(/no gate/);
});
