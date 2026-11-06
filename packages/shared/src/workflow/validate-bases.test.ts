/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- raw definition edits in tests */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_WORKFLOW_FEATURES,
  WORKFLOW_FEATURES,
  WorkflowDefinitionSchema,
} from './schema.js';
import { validateWorkflow } from './validate.js';
import { planBaseProblems, ticketBaseProblems } from './validate-bases.js';

// ADR-0039 (B1): rules 26–27, the `cmd`-base warning, rule 14's refusals and the ticket / plan
// base checks. The base is the v7 draft (conductor.v7-draft.test.ts).

type Raw = { states: Record<string, any> } & Record<string, any>;
const DRAFT = JSON.parse(
  readFileSync(
    new URL('../../../../docs/design/workflows/conductor.v7.draft.json', import.meta.url),
    'utf8',
  ),
) as Raw;
const v7 = (): Raw => structuredClone(DRAFT);
const V6 = JSON.parse(
  readFileSync(
    new URL('../../../../docs/design/workflows/conductor.v6.draft.json', import.meta.url),
    'utf8',
  ),
) as Raw;
const v6 = (): Raw => structuredClone(V6);

const found = (input: unknown) => {
  const r = validateWorkflow(input, { allowUnavailable: true });
  return r.ok ? [] : r.errors.map((e) => `${e.rule} ${e.path.join('.')}`);
};
const ON = 'states.implementing.on';

describe('rule 26: base names', () => {
  it('passes the draft', () => {
    expect(found(v7())).toEqual([]);
  });

  it('a base_default value must name a key of bases', () => {
    const raw = v7();
    raw.base_default.personal = 'nope';
    expect(found(raw)).toEqual(['26 base_default.personal']);
  });

  it('base_default needs bases', () => {
    const raw = v6();
    raw.base_default = { work: 'sprint' };
    expect(found(raw)).toEqual(['26 base_default']);
  });
});

describe('rule 27: $base needs bases', () => {
  const sites: [string, (raw: Raw) => void, string][] = [
    [
      'a check cmd',
      (r) =>
        r.states.implementing.on.ready_for_testing.requires.checks.push({
          name: 'm',
          cmd: 'git merge origin/$base',
        }),
      `${ON}.ready_for_testing.requires.checks.2.cmd`,
    ],
    [
      'a condition cmd',
      (r) =>
        r.states.implementing.on.ready_for_testing.requires.conditions.push({
          type: 'cmd',
          name: 'm',
          cmd: 'test $base_sha',
        }),
      `${ON}.ready_for_testing.requires.conditions.4.cmd`,
    ],
    [
      'a watch condition cmd',
      (r) =>
        r.states.in_review.watch.conditions.push({ type: 'cmd', name: 'm', cmd: 'echo $base' }),
      'states.in_review.watch.conditions.1.cmd',
    ],
    [
      'an instructions text',
      (r) => (r.instructions.resync_main = 'git merge origin/$base'),
      'instructions.resync_main',
    ],
    [
      'a literal on_unmet instruction',
      (r) =>
        (r.states.implementing.on.ready_for_testing.on_unmet.instruction = 'merge $base first'),
      `${ON}.ready_for_testing.on_unmet.instruction`,
    ],
  ];
  for (const [what, edit, path] of sites) {
    it(`refuses $base in ${what} without bases, accepts it with bases`, () => {
      const raw = v6();
      edit(raw);
      expect(found(raw)).toEqual([`27 ${path}`]);
      raw.bases = { default: { ref: '$default_branch' } };
      expect(found(raw)).toEqual([]);
    });
  }

  it('${base} and $basement are not uses', () => {
    const raw = v6();
    raw.instructions.resync_main = 'echo ${base} $basement';
    expect(found(raw)).toEqual([]);
  });
});

describe('warnings', () => {
  it('a cmd base without pr_into warns, and the save is still ok', () => {
    const r = validateWorkflow(v7(), { allowUnavailable: true });
    expect(r.ok).toBe(true);
    expect(r.warnings?.map((w) => w.path.join('.'))).toEqual(['bases.sprint.pr_into']);
  });

  it('none without cmd bases (and no warnings key)', () => {
    const r = validateWorkflow(v6(), { allowUnavailable: true });
    expect('warnings' in r).toBe(false);
  });
});

describe('rule 14: bases are not available yet', () => {
  it('bases is a feature that is not available', () => {
    expect(WORKFLOW_FEATURES).toContain('bases');
    expect(AVAILABLE_WORKFLOW_FEATURES).not.toContain('bases');
  });

  it('refuses bases, base_default and each $base use', () => {
    const r = validateWorkflow(v7());
    const paths = r.ok ? [] : r.errors.filter((e) => e.rule === 14).map((e) => e.path.join('.'));
    expect(paths).toEqual(
      expect.arrayContaining([
        'bases',
        'base_default',
        'instructions.resync_main',
        `${ON}.ready_for_testing.requires.checks.2.cmd`,
      ]),
    );
  });
});

describe('ticket and planning base', () => {
  const def = WorkflowDefinitionSchema.parse(v7());
  const on = [...AVAILABLE_WORKFLOW_FEATURES, 'bases' as const];

  it('is not available yet', () => {
    expect(ticketBaseProblems(def, 'master')).toEqual([
      { path: ['base'], message: 'a ticket base is not available yet' },
    ]);
    expect(planBaseProblems(def, { name: 'master', reason: 'r' })[0]?.message).toMatch(
      /not available yet/,
    );
  });

  it('a name must be in the workflow bases', () => {
    expect(ticketBaseProblems(def, 'master', on)).toEqual([]);
    expect(ticketBaseProblems(def, 'nope', on)[0]?.message).toMatch(/not in the workflow's bases/);
    expect(
      ticketBaseProblems(WorkflowDefinitionSchema.parse(v6()), 'master', on)[0]?.message,
    ).toMatch(/no bases/);
    expect(ticketBaseProblems(null, 'master', on)).toHaveLength(1);
    expect(ticketBaseProblems(def, { ref: 'release/1' }, on)).toEqual([]);
    expect(planBaseProblems(def, { name: 'hotfix', reason: 'r' }, on)).toEqual([]);
    expect(planBaseProblems(def, { name: 'nope', reason: 'r' }, on)[0]?.path).toEqual([
      'base',
      'name',
    ]);
    expect(planBaseProblems(def, { ref: 'main', reason: 'r' }, on)).toEqual([]);
  });
});
