/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- raw definition edits in tests */
import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V2_DRAFT } from './fixtures.js';
import { RETURN_TO } from './schema.js';
import { validateWorkflow } from './validate.js';

// M2r-T02 (ADR-0020): validator rules 15 (Done only through a merge) and 16 (the review-and-merge
// fields), and rule 4's reading of `on_unmet.routes`.

type Raw = { start: string; columns: string[]; states: Record<string, Record<string, any>> };
const v2 = (): Raw => structuredClone(CONDUCTOR_V2_DRAFT) as Raw;
const on = (raw: Raw, state: string) => raw.states[state]!.on as Record<string, any>;
const paths = (input: unknown) => {
  const r = validateWorkflow(input);
  return r.ok ? [] : r.errors.map((e) => `${e.rule} ${e.path.join('.')}`);
};

const migration = { id: 'migration', label: 'Approve migration', paths: ['**/migrations/**'] };

/** The v2 draft reshaped as the ADR-0020 §10 sketch: a valid merge-aware definition. */
function v3(): Raw {
  const r = v2();
  r.columns = [
    'planning',
    'implementing',
    'in_qa',
    'ready_to_merge',
    'needs_input',
    'waiting_external',
    'done',
  ];
  const impl = on(r, 'implementing');
  delete impl.done;
  impl.pr_ready_for_review.goto = 'in_qa';
  delete impl.pr_ready_for_review.question;
  r.states.in_qa = {
    type: 'agent',
    role: 'qa',
    title: 'In QA',
    prompt: 'qa_template',
    tools: ['qa'],
    timeout: '40m',
    checkout: { setup: null },
    result: ['verdict', 'summary'],
    on: {
      qa_pass: {
        goto: 'ready_to_merge',
        requires: { actions: ['inspect_pr'] },
        on_unmet: { goto: 'in_qa', retries: 2, else: 'needs_input' },
      },
      qa_fail: { goto: 'implementing', attach: 'result', retries: 3, else: 'needs_input' },
      qa_needs_human: { goto: 'needs_input', question: true },
      ask_user: 'needs_input',
      timeout: 'needs_input',
    },
  };
  r.states.ready_to_merge = {
    type: 'human',
    title: 'Ready to merge',
    on: {
      merge: {
        goto: 'done',
        actor: 'human',
        requires: { approvals: [migration], actions: ['merge_pr'] },
        on_unmet: {
          goto: 'implementing',
          retries: 2,
          else: 'needs_input',
          routes: { head_moved: 'in_qa' },
        },
      },
      request_changes: { goto: 'implementing', actor: 'human', text: 'required' },
    },
  };
  const ni = on(r, 'needs_input');
  delete ni.done;
  ni.close_without_merging = {
    goto: 'done',
    actor: 'human',
    text: 'required',
    requires: { actions: ['close_pr'] },
    on_unmet: { goto: 'ready_to_merge', retries: 0, else: 'needs_input' },
  };
  on(r, 'waiting_external')['ui.approve'].goto = 'ready_to_merge';
  return r;
}

const QA = 'states.in_qa';
const RTM = 'states.ready_to_merge.on';
const MERGE = `${RTM}.merge`;

describe('the ADR-0020 v3 shape', () => {
  it('validates (the PR actions are available)', () => {
    expect(paths(v3())).toEqual([]);
  });
});

describe('rule 15', () => {
  it('rule 15: a terminal transition without merge_pr/close_pr in a merge-aware definition is refused; v2 is unaffected', () => {
    const object = v3();
    on(object, 'needs_input').done = { goto: 'done', actor: 'human' };
    expect(paths(object)).toEqual(['15 states.needs_input.on.done.requires.actions']);

    const string = v3();
    on(string, 'waiting_external')['ui.approve'] = 'done';
    expect(paths(string)).toEqual(['15 states.waiting_external.on.ui.approve']);

    const counted = v3();
    on(counted, 'in_qa').qa_fail.else = 'done';
    expect(paths(counted)).toEqual([`15 ${QA}.on.qa_fail.else`]);

    // v2 has the same plain moves into Done, but names no merge_pr.
    expect(paths(v2())).toEqual([]);
  });

  it('close_pr also satisfies it, and the fallbacks are exempt', () => {
    const r = v3();
    on(r, 'ready_to_merge').merge.requires.actions = ['close_pr'];
    // No longer merge-aware: the approvals now lack merge_pr (rule 16), nothing for rule 15.
    expect(paths(r)).toEqual([`16 ${MERGE}.requires.approvals`]);
  });
});

// One row per rule 16 sub-rule: a mutation of v3 and the exact errors it yields.
const CASES: [string, (raw: Raw) => void, string[]][] = [
  [
    'role qa on the start state',
    (r) => {
      r.states.planning!.role = 'qa';
      r.states.planning!.tools = ['qa'];
    },
    ['16 states.planning.role'],
  ],
  [
    'role on a human state (schema: agent states only)',
    (r) => {
      r.states.needs_input!.role = 'qa';
    },
    ['1 states.needs_input'],
  ],
  [
    'qa state with an edit tool',
    (r) => (r.states.in_qa!.tools = ['qa', 'edit']),
    [`16 ${QA}.tools`],
  ],
  ['qa state without tools', (r) => delete r.states.in_qa!.tools, [`16 ${QA}.tools`]],
  [
    'checkout on a non-qa agent state',
    (r) => (r.states.implementing!.checkout = {}),
    ['16 states.implementing.checkout'],
  ],
  [
    'attach result out of a human state',
    (r) => {
      on(r, 'ready_to_merge').request_changes.attach = 'result';
    },
    [`16 ${RTM}.request_changes.attach`],
  ],
  [
    'text on an agent transition',
    (r) => (on(r, 'in_qa').qa_fail.text = 'optional'),
    [`16 ${QA}.on.qa_fail.text`],
  ],
  [
    'approvals on an agent transition',
    (r) => {
      on(r, 'in_qa').qa_pass.requires.approvals = [migration];
    },
    [`16 ${QA}.on.qa_pass.requires.approvals`],
  ],
  [
    'approvals without merge_pr',
    (r) => {
      on(r, 'needs_input').close_without_merging.requires.approvals = [migration];
    },
    ['16 states.needs_input.on.close_without_merging.requires.approvals'],
  ],
  [
    'approval ids listed twice',
    (r) => {
      on(r, 'ready_to_merge').merge.requires.approvals = [
        migration,
        { ...migration, label: 'Again' },
      ];
    },
    [`16 ${MERGE}.requires.approvals.1.id`],
  ],
  [
    'route to a terminal state',
    (r) => {
      on(r, 'ready_to_merge').merge.on_unmet.routes = { conflict: 'done' };
    },
    [`16 ${MERGE}.on_unmet.routes.conflict`],
  ],
  [
    'route to a state with entry requirements',
    (r) => {
      r.states.in_qa!.entry = {
        checks: [{ name: 'Build passes', cmd: 'npm run build' }],
        on_unmet: { goto: 'implementing', else: 'needs_input' },
      };
      // qa_pass's on_unmet.goto is in_qa too: rule 13's twin of this check.
    },
    [`13 ${QA}.on.qa_pass.on_unmet.goto`, `16 ${MERGE}.on_unmet.routes.head_moved`],
  ],
  [
    'route to a missing state',
    (r) => {
      on(r, 'ready_to_merge').merge.on_unmet.routes = { head_moved: 'nowhere' };
    },
    [`1 ${MERGE}.on_unmet.routes.head_moved`],
  ],
  [
    'route to $return_to',
    (r) => {
      on(r, 'ready_to_merge').merge.on_unmet.routes = { head_moved: RETURN_TO };
    },
    [`10 ${MERGE}.on_unmet.routes.head_moved`],
  ],
  [
    'an unknown route reason (schema)',
    (r) => {
      on(r, 'ready_to_merge').merge.on_unmet.routes = { closed: 'in_qa' };
    },
    [`1 ${MERGE}.on_unmet.routes`],
  ],
];

describe('rule 16', () => {
  it.each(CASES)('%s', (_, mutate, expected) => {
    const r = v3();
    mutate(r);
    expect(paths(r)).toEqual(expected);
  });
});

describe('rule 4 reads routes as bounded (FR-4)', () => {
  // s → a (plain) → b (plain); b's unmet `head_moved` routes back to a.
  const loop = (back: 'route' | 'plain') => ({
    id: 'routes_loop',
    version: 1,
    start: 's',
    budget: { usd: 1, minutes: 10, max_loop_retries: 3 },
    on_budget_exceeded: 'h',
    states: {
      s: { type: 'agent', prompt: 'p', on: { go: 'a', ask_user: 'h' } },
      a: { type: 'agent', prompt: 'p', on: { go: 'b', ask_user: 'h' } },
      b: {
        type: 'agent',
        prompt: 'p',
        on: {
          finish: {
            goto: 'end',
            requires: { actions: ['inspect_pr'] },
            on_unmet: {
              goto: 'h',
              else: 'h',
              ...(back === 'route' ? { routes: { head_moved: 'a' } } : {}),
            },
          },
          ...(back === 'plain' ? { again: 'a' } : {}),
          ask_user: 'h',
        },
      },
      h: { type: 'human', on: { answer: { goto: RETURN_TO, actor: 'human' } } },
      end: { type: 'terminal' },
    },
  });

  it('a cycle closed by a routes leg is bounded', () => {
    expect(paths(loop('route'))).toEqual([]);
  });

  it('the same cycle closed by a plain edge is not', () => {
    expect(paths(loop('plain'))).toEqual(['4 states.a']);
  });
});
