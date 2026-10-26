/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- raw definition edits in tests */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V1, CONDUCTOR_V1_DEF } from './conductor.js';
import { CONDUCTOR_WORKFLOW_ID } from './schema.js';
import { validateWorkflow, type WorkflowValidationError } from './validate.js';

// ADR-0010: the shipped `conductor` v1 and validator rule 9 (entry requirements and columns).

const docJson = (): unknown =>
  JSON.parse(
    readFileSync(
      new URL('../../../../docs/design/workflows/conductor.v1.json', import.meta.url),
      'utf8',
    ),
  );

type Raw = {
  id: string;
  start: string;
  columns?: string[];
  states: Record<string, Record<string, any>>;
};
const raw = (): Raw => structuredClone(CONDUCTOR_V1) as unknown as Raw;

const errorsOf = (input: unknown): WorkflowValidationError[] => {
  const r = validateWorkflow(input);
  return r.ok ? [] : r.errors;
};
const paths = (input: unknown) => errorsOf(input).map((e) => `${e.rule}:${e.path.join('.')}`);

describe('conductor v1 (ADR-0010)', () => {
  it('the code copy equals docs/design/workflows/conductor.v1.json', () => {
    expect(CONDUCTOR_V1).toEqual(docJson());
  });

  it('is valid, and matches the ADR table', () => {
    expect(errorsOf(CONDUCTOR_V1)).toEqual([]);
    const d = CONDUCTOR_V1_DEF;
    expect(d.id).toBe(CONDUCTOR_WORKFLOW_ID);
    expect(d.start).toBe('planning');
    expect(d.columns).toEqual([
      'planning',
      'implementing',
      'needs_input',
      'waiting_external',
      'done',
    ]);
    expect(Object.fromEntries(Object.entries(d.states).map(([n, s]) => [n, s.type]))).toEqual({
      planning: 'agent',
      implementing: 'agent',
      needs_input: 'human',
      waiting_external: 'event',
      done: 'terminal',
    });
    const we = d.states.waiting_external;
    expect(we?.type === 'event' && we.wait_for).toEqual(['ui.approve']);
    expect(we?.entry).toMatchObject({
      checks: [
        { name: 'Build passes', cmd: 'npm run build' },
        { name: 'Tests pass', cmd: 'npm test' },
      ],
      actions: ['open_pr'],
      on_unmet: { goto: 'implementing', retries: 3, else: 'needs_input' },
    });
  });
});

describe('validator rule 9: entry requirements and columns', () => {
  it('columns name existing states, once each', () => {
    const r = raw();
    r.columns = [
      'planning',
      'nope',
      'planning',
      'implementing',
      'needs_input',
      'waiting_external',
      'done',
    ];
    expect(paths(r)).toEqual(expect.arrayContaining(['9:columns.1', '9:columns.2']));
  });

  it('the conductor workflow needs columns listing every state', () => {
    const r = raw();
    r.columns = ['planning', 'implementing', 'done'];
    const e = errorsOf(r).find((x) => x.path.join('.') === 'columns')!;
    expect(e.rule).toBe(9);
    expect(e.message).toContain('"needs_input", "waiting_external"');
    const none = raw();
    delete none.columns;
    expect(paths(none)).toContain('9:columns');
    // Another workflow may omit columns.
    const other = raw();
    other.id = 'other';
    delete other.columns;
    expect(errorsOf(other)).toEqual([]);
  });

  it('no entry on the start state (the start column is entered by a claim)', () => {
    const r = raw();
    r.states.planning!.entry = {
      checks: [{ name: 'x', cmd: 'true' }],
      on_unmet: { goto: 'implementing' },
    };
    const e = errorsOf(r).find((x) => x.path.join('.') === 'states.planning.entry')!;
    expect(e.message).toContain('entered by a claim, not an outcome');
  });

  it('entry on the terminal state is allowed; on a human state it is not', () => {
    const r = raw();
    r.states.done!.entry = {
      checks: [{ name: 'x', cmd: 'true' }],
      on_unmet: { goto: 'implementing' },
    };
    expect(errorsOf(r)).toEqual([]);
    const h = raw();
    h.states.needs_input!.entry = {
      checks: [{ name: 'x', cmd: 'true' }],
      on_unmet: { goto: 'implementing' },
    };
    expect(paths(h)).toContain('9:states.needs_input.entry');
  });

  it('on_unmet.goto / else exist; else is human; goto has no entry of its own', () => {
    const missing = raw();
    missing.states.waiting_external!.entry.on_unmet.goto = 'nowhere';
    expect(paths(missing)).toContain('1:states.waiting_external.entry.on_unmet.goto');
    const notHuman = raw();
    notHuman.states.waiting_external!.entry.on_unmet.else = 'done';
    expect(paths(notHuman)).toContain('9:states.waiting_external.entry.on_unmet.else');
    const self = raw();
    self.states.waiting_external!.entry.on_unmet.goto = 'waiting_external';
    expect(paths(self)).toContain('9:states.waiting_external.entry.on_unmet.goto');
  });

  it('retries are bounded (0–10)', () => {
    const r = raw();
    r.states.waiting_external!.entry.on_unmet.retries = 11;
    expect(paths(r)).toContain('1:states.waiting_external.entry.on_unmet.retries');
  });

  it('check commands are not blank; names and actions are unique', () => {
    const r = raw();
    r.states.waiting_external!.entry.checks = [
      { name: 'Build passes', cmd: '   ' },
      { name: 'Build passes', cmd: 'npm test' },
    ];
    r.states.waiting_external!.entry.actions = ['open_pr', 'open_pr'];
    expect(paths(r)).toEqual(
      expect.arrayContaining([
        '9:states.waiting_external.entry.checks.0.cmd',
        '9:states.waiting_external.entry.checks.1.name',
        '9:states.waiting_external.entry.actions.1',
      ]),
    );
  });

  it('__entry is a reserved state name', () => {
    const r = raw();
    r.states.__entry = { type: 'human' };
    r.columns = [...r.columns!, '__entry'];
    expect(paths(r)).toContain('8:states.__entry');
  });
});
