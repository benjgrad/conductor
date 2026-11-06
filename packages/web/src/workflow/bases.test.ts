import {
  AVAILABLE_WORKFLOW_FEATURES,
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import {
  addBase,
  baseNameProblem,
  basesIssues,
  basesOf,
  removeBase,
  renameBase,
  setBaseDefault,
  setBaseField,
  setBaseMode,
} from './bases.js';
import { validateColumns } from './columns.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read at run time, not imported: the deploy image has no docs/ (.dockerignore) and its
// `tsc -b` typechecks tests, so a static import of a docs/ file breaks `pnpm build`.
const V7_DRAFT: unknown = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../../../docs/design/workflows/conductor.v7.draft.json'),
    'utf8',
  ),
);

// ADR-0039 (B3): the Bases section's pure edits and problems, on the v7 draft.

const V7 = WorkflowDefinitionSchema.parse(V7_DRAFT);
const ON = [...AVAILABLE_WORKFLOW_FEATURES, 'bases' as const];
const v7 = (): WorkflowDefinition => structuredClone(V7);
const bare = (): WorkflowDefinition => {
  const d = v7();
  delete d.bases;
  delete d.base_default;
  delete d.instructions;
  return d;
};

describe('bases edits (ADR-0039, B3)', () => {
  it('add names a new base uniquely, on the default branch', () => {
    const a = addBase(bare());
    expect(a.name).toBe('base');
    expect(a.definition.bases).toEqual({ base: { ref: '$default_branch' } });
    expect(addBase(a.definition).name).toBe('base-2');
  });

  it('rename keeps the order and the defaults follow', () => {
    const d = renameBase(v7(), 'sprint', 'sprint-branch');
    expect(basesOf(d).map(([n]) => n)).toEqual(['default', 'sprint-branch', 'master', 'hotfix']);
    expect(d.base_default).toEqual({ work: 'sprint-branch', personal: 'default' });
    expect(baseNameProblem(v7(), 'sprint', 'master')).toMatch(/already exists/);
    expect(baseNameProblem(v7(), 'sprint', 'Sprint')).toMatch(/lower-case/);
    expect(renameBase(v7(), 'sprint', 'Bad Name')).toEqual(v7());
  });

  it('switching ref ↔ command, and setting and clearing fields', () => {
    let d = setBaseMode(v7(), 'hotfix', 'ref');
    expect(d.bases!.hotfix).toEqual({ ref: '$default_branch' });
    d = setBaseMode(v7(), 'master', 'cmd');
    expect(d.bases!.master).toEqual({ cmd: '' });
    d = setBaseField(d, 'master', 'cmd', 'git rev-parse origin/master');
    d = setBaseField(d, 'master', 'pr_into', 'master');
    d = setBaseField(d, 'master', 'timeout', '2m');
    expect(d.bases!.master).toEqual({
      cmd: 'git rev-parse origin/master',
      pr_into: 'master',
      timeout: '2m',
    });
    d = setBaseField(d, 'master', 'timeout', '');
    expect(d.bases!.master).not.toHaveProperty('timeout');
    // pr_into is kept going to a command.
    expect(setBaseMode(setBaseMode(v7(), 'hotfix', 'cmd'), 'hotfix', 'cmd').bases!.hotfix).toEqual(
      V7.bases!.hotfix,
    );
    expect(setBaseField(v7(), 'master', 'ref', 'main').bases!.master).toEqual({ ref: 'main' });
    expect(setBaseField(v7(), 'master', 'cmd', 'x').bases!.master).toEqual({ ref: 'master' });
  });

  it('the per-kind default: set, clear, and none left drops base_default', () => {
    let d = setBaseDefault(v7(), 'work', 'master');
    expect(d.base_default).toEqual({ work: 'master', personal: 'default' });
    d = setBaseDefault(d, 'work', null);
    d = setBaseDefault(d, 'personal', null);
    expect(d).not.toHaveProperty('base_default');
  });

  it('delete is refused while a default or a queued ticket names the base', () => {
    const r = removeBase(v7(), 'sprint', 2);
    expect(r).toEqual({
      ok: false,
      reasons: ['it is the default for work tickets', '2 queued tickets use it'],
    });
    expect(removeBase(v7(), 'master', 1)).toEqual({
      ok: false,
      reasons: ['1 queued ticket uses it'],
    });
    const ok = removeBase(v7(), 'master');
    expect(ok.ok && Object.keys(ok.definition.bases!)).toEqual(['default', 'sprint', 'hotfix']);
    const last = removeBase(addBase(bare()).definition, 'base');
    expect(last.ok && last.definition).not.toHaveProperty('bases');
  });
});

describe('basesIssues (ADR-0039, B3)', () => {
  it('the v7 draft: only the warning for a command without pr_into once bases are on', () => {
    expect(basesIssues(v7(), ON)).toEqual([
      {
        path: 'bases.sprint.pr_into',
        message: expect.stringMatching(/refused at run time without pr_into/) as string,
        warning: true,
      },
    ]);
  });

  it('rule 14 while bases are not available, at bases, base_default and each $base', () => {
    const paths = basesIssues(v7(), AVAILABLE_WORKFLOW_FEATURES)
      .filter((i) => i.warning !== true)
      .map((i) => i.path);
    expect(paths).toContain('bases');
    expect(paths).toContain('base_default');
    expect(paths).toContain('instructions.resync_main');
  });

  it('rule 26 (a default naming no base), rule 27 ($base without bases), a spec’s shape', () => {
    const d = setBaseDefault(v7(), 'work', 'nope');
    expect(basesIssues(d, ON)).toContainEqual({
      path: 'base_default.work',
      message: 'rule 26: base "nope" is not in bases',
    });
    const noBases = v7();
    delete noBases.bases;
    delete noBases.base_default;
    expect(basesIssues(noBases, ON).map((i) => i.path)).toContain('instructions.resync_main');
    const empty = setBaseMode(v7(), 'master', 'cmd');
    expect(basesIssues(empty, ON)).toContainEqual(
      expect.objectContaining({ path: 'bases.master.cmd' }),
    );
  });

  it('validateColumns blocks Save on the errors, never on the warning', () => {
    expect(validateColumns(v7(), ON).filter((i) => i.path.startsWith('bases'))).toEqual([]);
    expect(validateColumns(v7(), AVAILABLE_WORKFLOW_FEATURES).map((i) => i.path)).toContain(
      'bases',
    );
  });
});
