import type { WorkflowDefinition, WorkflowDefinitionInput } from '@conductor/shared';
import { WorkflowDefinitionSchema } from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { affectedOf, diffRepoChecks, diffVersions } from './version-diff.js';

// UXR-70 / UXR-73: the readable diff, on small mock versions.

const BASE: WorkflowDefinitionInput = {
  id: 'wf',
  version: 1,
  start: 'planning',
  budget: { usd: 1, minutes: 10, max_loop_retries: 1 },
  columns: ['planning', 'implementing', 'needs_input', 'done'],
  states: {
    planning: {
      type: 'agent',
      title: 'Planning',
      prompt: 'plan_template',
      on: { plan_ready: 'implementing', ask_user: 'needs_input' },
    },
    implementing: {
      type: 'agent',
      title: 'Implementing',
      prompt: 'implement_template',
      on: {
        done: {
          goto: 'done',
          requires: {
            checks: [
              { name: 'test', cmd: 'npm test' },
              { name: 'lint', cmd: 'npm run lint' },
            ],
          },
        },
        ask_user: 'needs_input',
      },
    },
    needs_input: { type: 'human', title: 'Needs input', on: { 'input.provided': 'implementing' } },
    done: { type: 'terminal', title: 'Done' },
  },
};

const v1 = (): WorkflowDefinition => WorkflowDefinitionSchema.parse(structuredClone(BASE));

/** v1 edited by `edit`, as version 2. */
function v2(edit: (d: WorkflowDefinition) => void): WorkflowDefinition {
  const d = v1();
  d.version = 2;
  edit(d);
  return d;
}

/** A transition object of `d` (fixture edits). */
function t(d: WorkflowDefinition, from: string, name: string) {
  const s = d.states[from]!;
  if (s.type === 'terminal') throw new Error('terminal');
  const on = s.on!;
  const cur = on[name]!;
  if (typeof cur === 'string') on[name] = { goto: cur };
  return on[name] as Exclude<typeof cur, string>;
}

const lines = (before: WorkflowDefinition, after: WorkflowDefinition) =>
  diffVersions(before, after).flatMap((c) => c.lines);

describe('diffVersions', () => {
  it('nothing changed (the version is ignored)', () => {
    expect(
      diffVersions(
        v1(),
        v2(() => {}),
      ),
    ).toEqual([]);
  });

  it('a column added, removed, retitled or moved', () => {
    const added = diffVersions(
      v1(),
      v2((d) => {
        d.states.review = { type: 'human', title: 'Review', on: { approve: 'done' } };
        d.columns = ['planning', 'implementing', 'review', 'needs_input', 'done'];
      }),
    );
    expect(added[0]).toMatchObject({
      scope: 'column',
      op: 'added',
      state: 'review',
      title: 'Column Review',
    });
    expect(added[1]).toMatchObject({
      scope: 'transition',
      op: 'added',
      state: 'review',
      transition: 'approve',
      edges: ['review/done'],
    });
    expect(added[1]!.after).toMatch(/When a person picks \*\*Approve\*\*/);

    const removed = diffVersions(
      v1(),
      v2((d) => {
        delete d.states.needs_input;
        d.columns = ['planning', 'implementing', 'done'];
      }),
    );
    expect(removed.find((c) => c.scope === 'column')).toMatchObject({
      op: 'removed',
      title: 'Column Needs input',
    });

    expect(
      lines(
        v1(),
        v2((d) => {
          d.states.planning!.title = 'Plan';
          d.columns = ['implementing', 'planning', 'needs_input', 'done'];
        }),
      ),
    ).toEqual([
      // Implementing first: the new column order.
      'Moved from 2nd to 1st column',
      'Title: Planning → Plan',
      'Moved from 1st to 2nd column',
    ]);
  });

  it('a transition added or removed, with its sentence', () => {
    const [c] = diffVersions(
      v1(),
      v2((d) => {
        const s = d.states.planning;
        if (s?.type === 'agent') delete s.on!.ask_user;
      }),
    );
    expect(c).toMatchObject({
      scope: 'transition',
      op: 'removed',
      title: 'Planning → Needs input: Ask user',
      edges: ['planning/needs_input'],
    });
    expect(c!.before).toMatch(/→ \*\*Needs input\*\*\./);
  });

  it('goto changed: column titles in the words, both arrows', () => {
    const [c] = diffVersions(
      v1(),
      v2((d) => {
        t(d, 'planning', 'plan_ready').goto = 'done';
      }),
    );
    expect(c!.lines).toEqual(['Goes to **Done** instead of **Implementing**']);
    expect(c!.edges).toEqual(['planning/implementing', 'planning/done']);
    expect(c!.before).not.toBe(c!.after);
  });

  it('check rows: added, removed, command, time limit and moves', () => {
    const after = v2((d) => {
      t(d, 'implementing', 'done').requires = {
        checks: [
          { name: 'lint', cmd: 'npm run lint' },
          { name: 'test', cmd: 'pnpm test', timeout: '10m' },
          { name: 'build', cmd: 'pnpm build' },
        ],
      };
    });
    expect(lines(v1(), after)).toEqual([
      'Check **lint** moved from 2nd to 1st',
      'Check **test**: `npm test` → `pnpm test`',
      'Check **test** time limit: default → 10 minutes',
      'Check **test** moved from 1st to 2nd',
      'Check **build** added: `pnpm build`',
    ]);
    const fewer = v2((d) => {
      t(d, 'implementing', 'done').requires = { checks: [{ name: 'test', cmd: 'npm test' }] };
    });
    expect(lines(v1(), fewer)).toEqual(['Check **lint** removed']);
  });

  it('setup: auto-detect → none', () => {
    const after = v2((d) => {
      t(d, 'implementing', 'done').requires!.setup = '';
    });
    expect(lines(v1(), after)).toEqual(['Setup: auto-detect → none']);
  });

  it('conditions in their sentence words, and the wait', () => {
    const after = v2((d) => {
      t(d, 'implementing', 'done').requires!.conditions = [
        { type: 'pr_checks_green' },
        { type: 'pr_approvals', min: 2, enabled: false },
      ];
      t(d, 'implementing', 'done').requires!.condition_timeout = '3d';
    });
    expect(lines(v1(), after)).toEqual([
      'Waits for **PR checks**',
      'Waits for **2 approvals** (added, off)',
      'Waits up to: no limit → 3 days',
    ]);
    const toggled = structuredClone(after);
    toggled.version = 3;
    t(toggled, 'implementing', 'done').requires!.conditions![1]!.enabled = true;
    expect(lines(after, toggled)).toEqual(['Condition **2 approvals**: off → on']);
  });

  it('on_unmet: where it goes and the instruction', () => {
    const after = v2((d) => {
      t(d, 'implementing', 'done').on_unmet = {
        goto: 'implementing',
        retries: 2,
        else: 'needs_input',
        instruction: 'Fix the tests',
      };
    });
    expect(lines(v1(), after)).toEqual([
      'If not met: nothing set → back to **Implementing** up to 2 times, then **Needs input**',
      'Instruction on the way back added',
    ]);
  });

  it('a string shorthand that becomes an object reads as its real change only', () => {
    const after = v2((d) => {
      t(d, 'planning', 'plan_ready').title = 'Plan is ready';
    });
    expect(lines(v1(), after)).toEqual(['Title: Plan ready → Plan is ready']);
  });

  it('a field without words still shows', () => {
    const after = v2((d) => {
      t(d, 'planning', 'plan_ready').attach = 'result';
      d.mcp = { allow: ['x'] } as unknown as WorkflowDefinition['mcp'];
    });
    expect(lines(v1(), after)).toEqual([
      'Other setting changed: `attach`',
      'Other setting changed: `mcp`',
    ]);
  });

  it('workflow-wide settings', () => {
    const after = v2((d) => {
      d.start = 'implementing';
      d.queued_ticket_editable = false;
    });
    const changes = diffVersions(v1(), after);
    expect(changes).toEqual([
      {
        scope: 'workflow',
        op: 'changed',
        edges: [],
        title: 'Workflow settings',
        lines: [
          'Tickets start in: Planning → Implementing',
          'People can edit tickets in Queued: on → off',
        ],
      },
    ]);
  });

  it('a version without columns (pre ADR-0010) uses state names', () => {
    const old = v1();
    delete old.columns;
    delete old.states.planning!.title;
    const after = structuredClone(old);
    after.version = 2;
    t(after, 'planning', 'plan_ready').goto = 'done';
    expect(lines(old, after)).toEqual(['Goes to **Done** instead of **Implementing**']);
    expect(diffVersions(old, after)[0]!.title).toBe('planning → Done: Plan ready');
  });

  it('prompt changes: short as code, long as "changed"', () => {
    const after = v2((d) => {
      const s = d.states.planning;
      if (s?.type === 'agent') s.prompt = 'line one\nline two';
    });
    expect(lines(v1(), after)).toEqual(['Prompt changed']);
  });

  it('affectedOf: changed columns, added transitions’ columns and every touched arrow', () => {
    const changes = diffVersions(
      v1(),
      v2((d) => {
        d.states.needs_input!.title = 'Waiting';
        t(d, 'planning', 'plan_ready').goto = 'done';
        const s = d.states.implementing;
        if (s?.type === 'agent') s.on!.skip = 'done';
      }),
    );
    const { states, edges } = affectedOf(changes);
    expect([...states].sort()).toEqual(['implementing', 'needs_input']);
    expect([...edges].sort()).toEqual([
      'implementing/done',
      'planning/done',
      'planning/implementing',
    ]);
  });
});

describe('diffRepoChecks', () => {
  const checks = { checks: [{ name: 'build', cmd: 'make' }] };

  it('an override added or removed', () => {
    expect(diffRepoChecks(null, null)).toEqual([]);
    expect(diffRepoChecks(null, checks)).toEqual([
      {
        scope: 'checks',
        op: 'added',
        edges: [],
        title: 'This repo gets its own checks',
        lines: ['Setup: auto-detect', 'Check **build**: `make`'],
      },
    ]);
    expect(diffRepoChecks(checks, null)[0]).toMatchObject({
      op: 'removed',
      title: 'Back to the workflow’s checks',
    });
  });

  it('check rows and setup', () => {
    expect(
      diffRepoChecks(checks, {
        setup: 'cd m-one && npm ci',
        checks: [{ name: 'build', cmd: 'make all' }],
      })[0]!.lines,
    ).toEqual([
      'Setup: auto-detect → `cd m-one && npm ci`',
      'Check **build**: `make` → `make all`',
    ]);
    expect(diffRepoChecks(checks, structuredClone(checks))).toEqual([]);
  });
});
