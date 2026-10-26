/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- raw definition edits in tests */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONDUCTOR_V1,
  CONDUCTOR_V1_DEF,
  CONDUCTOR_V2,
  CONDUCTOR_V2_DEF,
  WORK_COMMIT_REVIEW_ITEM,
} from './conductor.js';
import { CONDUCTOR_WORKFLOW_ID, RETURN_TO, type TicketKind } from './schema.js';
import { transitionsOf } from './transition-rules.js';
import { validateWorkflow, type WorkflowValidationError } from './validate.js';

// ADR-0010: the shipped `conductor` v1 and validator rule 9 (entry requirements and columns).
// ADR-0011 (M1b-T09): the shipped v2, and what each ticket kind sees from each state.

const readDoc = (file: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../../docs/design/workflows/${file}`, import.meta.url), 'utf8'),
  );
const docJson = (): unknown => readDoc('conductor.v1.json');

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

  it('setup needs checks (it runs before them)', () => {
    const r = raw();
    r.states.waiting_external!.entry.setup = 'npm ci';
    expect(errorsOf(r)).toEqual([]);
    r.states.waiting_external!.entry.checks = [];
    expect(paths(r)).toContain('9:states.waiting_external.entry.setup');
  });

  it('__entry is a reserved state name', () => {
    const r = raw();
    r.states.__entry = { type: 'human' };
    r.columns = [...r.columns!, '__entry'];
    expect(paths(r)).toContain('8:states.__entry');
  });
});

/** `<actor> <name> → <goto>` for every transition out of `state` that a `kind` ticket sees. */
const seen = (state: string, kind: TicketKind | null) =>
  transitionsOf(CONDUCTOR_V2_DEF, state, { kind }).map(
    (e) => `${e.actor} ${e.name} → ${e.transition.goto}`,
  );

describe('conductor v2 (ADR-0011)', () => {
  it('the code copy equals docs/design/workflows/conductor.v2.json', () => {
    expect(CONDUCTOR_V2).toEqual(readDoc('conductor.v2.json'));
  });

  it('validates (rules 1–14)', () => {
    expect(errorsOf(CONDUCTOR_V2)).toEqual([]);
    expect(errorsOf(readDoc('conductor.v2.json'))).toEqual([]);
  });

  it('keeps v1’s states, columns and budget; is the next version; no entry requirements', () => {
    const d = CONDUCTOR_V2_DEF;
    expect(d.id).toBe(CONDUCTOR_WORKFLOW_ID);
    expect(d.version).toBe(CONDUCTOR_V1_DEF.version + 1);
    expect(d.start).toBe(CONDUCTOR_V1_DEF.start);
    expect(d.columns).toEqual(CONDUCTOR_V1_DEF.columns);
    expect(d.budget).toEqual(CONDUCTOR_V1_DEF.budget);
    expect(Object.keys(d.states)).toEqual(Object.keys(CONDUCTOR_V1_DEF.states));
    expect(Object.values(d.states).some((s) => s.entry !== undefined)).toBe(false);
  });

  it('a work ticket sees, from each state', () => {
    expect(seen('planning', 'work')).toEqual([
      'agent plan_ready → implementing',
      'agent scope_changed → needs_input',
      'agent plan_needs_approval → needs_input',
      'agent needs_product_context → needs_input',
      'agent impossible → needs_input',
      'agent ask_user → needs_input',
      'system timeout → needs_input',
    ]);
    expect(seen('implementing', 'work')).toEqual([
      'agent needs_approval_to_message → needs_input',
      'agent pr_ready_for_review → needs_input',
      'agent ready_for_testing → waiting_external',
      'agent ask_user → needs_input',
      'system timeout → needs_input',
    ]);
    expect(seen('needs_input', 'work')).toEqual([
      `human answer → ${RETURN_TO}`,
      'human waiting_on_someone → waiting_external',
      'human done → done',
    ]);
    expect(seen('waiting_external', 'work')).toEqual([
      'system ui.approve → done',
      'human back_to_implementing → implementing',
    ]);
    expect(seen('done', 'work')).toEqual([]);
  });

  it('a personal ticket sees, from each state', () => {
    expect(seen('planning', 'personal')).toEqual(seen('planning', 'work'));
    expect(seen('implementing', 'personal')).toEqual([
      'agent needs_approval_to_message → needs_input',
      'agent personal_pr_ready_for_review → needs_input',
      'agent done → done',
      'agent ask_user → needs_input',
      'system timeout → needs_input',
    ]);
    expect(seen('needs_input', 'personal')).toEqual(seen('needs_input', 'work'));
    expect(seen('waiting_external', 'personal')).toEqual(seen('waiting_external', 'work'));
    expect(seen('done', 'personal')).toEqual([]);
  });

  it('a null kind (an old ticket) matches both kinds, so it sees both review twins (U-062)', () => {
    expect(seen('implementing', null)).toEqual([
      'agent needs_approval_to_message → needs_input',
      'agent pr_ready_for_review → needs_input',
      'agent personal_pr_ready_for_review → needs_input',
      'agent ready_for_testing → waiting_external',
      'agent done → done',
      'agent ask_user → needs_input',
      'system timeout → needs_input',
    ]);
  });

  it('cancel is not a transition (U-061); every agent state keeps the ask_user fallback', () => {
    for (const [name, s] of Object.entries(CONDUCTOR_V2_DEF.states)) {
      if (s.type === 'terminal') continue;
      expect(Object.keys(s.on ?? {}), name).not.toContain('cancel');
      if (s.type === 'agent') expect(s.on?.ask_user, name).toBe('needs_input');
    }
  });

  it('the work-commit review is on every work open_pr transition, never on a personal one', () => {
    const shipping = transitionsOf(CONDUCTOR_V2_DEF, 'implementing').filter(
      (e) => e.transition.requires?.actions?.includes('open_pr') === true,
    );
    expect(shipping.map((e) => [e.name, e.transition.kinds])).toEqual([
      ['pr_ready_for_review', ['work']],
      ['personal_pr_ready_for_review', ['personal']],
      ['ready_for_testing', ['work']],
      ['done', ['personal']],
    ]);
    for (const e of shipping) {
      expect(e.transition.on_unmet, e.name).toMatchObject({
        goto: 'implementing',
        else: 'needs_input',
      });
      const reviewed = e.transition.requires?.review?.items.includes(WORK_COMMIT_REVIEW_ITEM);
      expect(reviewed ?? false, e.name).toBe(e.transition.kinds?.includes('work'));
    }
  });

  it('the review twins differ only in kind and the review item', () => {
    const of = (name: string) =>
      transitionsOf(CONDUCTOR_V2_DEF, 'implementing').find((e) => e.name === name)!.transition;
    const work = of('pr_ready_for_review');
    const personal = of('personal_pr_ready_for_review');
    const { review, ...workRequires } = work.requires ?? {};
    expect(review).toEqual({ items: [WORK_COMMIT_REVIEW_ITEM] });
    expect({ ...personal, kinds: ['work'] }).toEqual({ ...work, requires: workRequires });
  });

  it('ready_for_testing: PR conditions enabled; Jira and Azure declared but disabled (M5)', () => {
    const t = transitionsOf(CONDUCTOR_V2_DEF, 'implementing').find(
      (e) => e.name === 'ready_for_testing',
    )!.transition;
    expect(t.kinds).toEqual(['work']);
    expect(t.requires?.checks?.map((c) => c.name)).toEqual(['Build passes', 'Tests pass']);
    expect(t.requires?.conditions).toEqual([
      { type: 'pr_checks_green' },
      { type: 'pr_approvals', min: 1 },
      { type: 'jira_fields_set', fields: ['resolution'], enabled: false },
      { type: 'azure_pipeline_succeeded', pipeline: 'ci', enabled: false },
    ]);
    expect(t.requires?.condition_timeout).toBe('3d');
  });
});
