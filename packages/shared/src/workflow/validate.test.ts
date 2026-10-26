import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateWorkflow, type WorkflowRule } from './validate.js';

const json = (url: URL): unknown => JSON.parse(readFileSync(url, 'utf8'));
const reference = (name: string) =>
  json(new URL(`../../../../docs/design/workflows/${name}`, import.meta.url));
const fixture = (name: string) => json(new URL(`./__fixtures__/${name}.json`, import.meta.url));

type Raw = {
  start: string;
  budget: { max_loop_retries: number };
  states: Record<string, Record<string, unknown>>;
};

describe('validateWorkflow: reference workflows', () => {
  it.each(['m1_basic.v1.json', 'm1_reviewed.v1.json', 'pr_flow.v1.json'])('%s is valid', (name) => {
    const res = validateWorkflow(reference(name));
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.def.on_budget_exceeded).toBe('needs_input');
  });

  it('accepts an unregistered guard name (TD-017)', () => {
    const raw = reference('m1_basic.v1.json') as Raw;
    raw.states.implement!.guard = 'no_such_guard';
    expect(validateWorkflow(raw).ok).toBe(true);
  });

  it('accepts a loop whose object transition omits retries (capped by max_loop_retries)', () => {
    const raw = reference('m1_basic.v1.json') as Raw;
    raw.states.build!.on = { exit_0: 'test', fail: { goto: 'implement', attach: 'output' } };
    expect(validateWorkflow(raw).ok).toBe(true);
  });

  it('accepts a loop gated by a human state', () => {
    const raw = reference('m1_basic.v1.json') as Raw;
    raw.states.needs_input!.on = { answered: 'implement' };
    expect(validateWorkflow(raw).ok).toBe(true);
  });
});

// One row per failing fixture: the rule(s) it must trip and the error paths expected.
const FAILING: [string, WorkflowRule, (string | number)[][]][] = [
  ['rule1-schema-invalid', 1, [['id']]],
  ['rule1-missing-start', 1, [['start']]],
  ['rule1-missing-target', 1, [['states', 'work', 'on', 'done']]],
  ['rule1-missing-else-target', 1, [['states', 'work', 'on', 'fail', 'else']]],
  ['rule1-missing-budget-target', 1, [['on_budget_exceeded']]],
  ['rule2-unreachable', 2, [['states', 'orphan']]],
  ['rule3-dead-end', 3, [['states', 'build']]],
  [
    'rule3-trapped-cycle',
    3,
    [
      ['states', 'retry'],
      ['states', 'retry2'],
    ],
  ],
  ['rule4-unbudgeted-loop', 4, [['states', 'work']]],
  ['rule4-event-timeout-loop', 4, [['states', 'work']]],
  ['rule5-bad-ref-key', 5, [['states', 'post', 'input', 'url']]],
  ['rule5-ref-unknown-state', 5, [['states', 'work', 'input', 'url']]],
  ['rule5-ref-malformed', 5, [['states', 'work', 'input', 'url']]],
  ['rule5-ref-not-on-every-path', 5, [['states', 'post', 'input', 'url']]],
  ['rule5-ref-self', 5, [['states', 'work', 'input', 'prev']]],
  ['rule6-release-no-timeout', 6, [['states', 'wait', 'timeout']]],
  ['rule7-unknown-tool', 7, [['states', 'work', 'tools', 1]]],
  [
    'rule8-gate-else-not-human',
    8,
    [['states', 'work', 'on', 'done', 'requirements', 'on_unmet', 'else']],
  ],
  ['rule8-gate-out-of-event-state', 8, [['states', 'wait', 'on', 'pr.approved', 'requirements']]],
  ['rule10-agent-actor-on-event-state', 10, [['states', 'wait', 'on', 'nudge', 'actor']]],
  ['rule11-question-not-to-human', 11, [['states', 'work', 'on', 'stuck', 'question']]],
  ['rule12-agent-cannot-ask', 12, [['states', 'work']]],
  [
    'rule13-conditions-no-timeout',
    13,
    [['states', 'work', 'on', 'done', 'requires', 'condition_timeout']],
  ],
  [
    'rule14-enabled-unavailable-condition',
    14,
    [['states', 'work', 'on', 'done', 'requires', 'conditions', 1]],
  ],
];

describe('validateWorkflow: failing fixtures', () => {
  it.each(FAILING)('%s fails rule %d only', (name, rule, paths) => {
    const res = validateWorkflow(fixture(name));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map((e) => e.rule)).toEqual(paths.map(() => rule));
    expect(res.errors.map((e) => e.path)).toEqual(paths);
    for (const e of res.errors) expect(e.message).toMatch(/\S/);
  });

  it('covers every fixture file and every rule', () => {
    const files = readdirSync(new URL('./__fixtures__/', import.meta.url))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
    expect(files).toEqual(FAILING.map(([n]) => n).sort());
    expect(new Set(FAILING.map(([, r]) => r))).toEqual(
      new Set([1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14]),
    );
  });
});

describe('validateWorkflow: behaviour', () => {
  it('never throws on garbage input', () => {
    for (const input of [undefined, null, 42, 'x', [], {}]) {
      const res = validateWorkflow(input);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errors.every((e) => e.rule === 1)).toBe(true);
    }
  });

  it('skips graph rules when a target is missing, but still reports rules 6 and 7', () => {
    const raw = reference('pr_flow.v1.json') as Raw;
    raw.states.build!.on = { exit_0: 'tset' };
    raw.states.implement!.tools = ['edit', 'sudo'];
    delete raw.states.await_approval!.timeout;
    const res = validateWorkflow(raw);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map((e) => e.rule).sort()).toEqual([1, 6, 7]);
  });

  it('reports one error per unbudgeted loop, naming its states', () => {
    const raw = reference('m1_basic.v1.json') as Raw;
    raw.states.test!.on = { exit_0: 'done', fail: 'build' };
    raw.states.build!.on = { exit_0: 'test', fail: 'test' };
    const res = validateWorkflow(raw);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatchObject({ rule: 4 });
    expect(res.errors[0]!.message).toContain('"build"');
    expect(res.errors[0]!.message).toContain('"test"');
  });

  it('flags a self-loop on a plain transition', () => {
    const raw = reference('m1_basic.v1.json') as Raw;
    raw.states.build!.on = { exit_0: 'test', fail: 'build' };
    const res = validateWorkflow(raw);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toEqual([expect.objectContaining({ rule: 4 })]);
  });

  it('pr_flow: notify is invalid if open_pr stops producing pr_url', () => {
    const raw = reference('pr_flow.v1.json') as Raw;
    raw.states.open_pr!.result = ['branch'];
    const res = validateWorkflow(raw);
    expect(res).toMatchObject({ ok: false, errors: [{ rule: 5 }] });
  });

  it('pr_flow: a path to notify that skips open_pr fails rule 5', () => {
    const raw = reference('pr_flow.v1.json') as Raw;
    raw.states.test!.on = { exit_0: 'open_pr', fail: 'notify' };
    const res = validateWorkflow(raw);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.map((e) => e.rule)).toContain(5);
  });
});

describe('validateWorkflow: requirements gates (ADR-0009)', () => {
  type Gate = Record<string, unknown> & { on_unmet: Record<string, unknown> };
  type RawDef = Raw & { on_budget_exceeded?: string };
  const gated = (mutate: (gate: Gate, raw: RawDef) => void) => {
    const raw = reference('m1_reviewed.v1.json') as RawDef;
    const done = (raw.states.implement!.on as Record<string, { requirements: Gate }>).done!;
    mutate(done.requirements, raw);
    return validateWorkflow(raw);
  };
  const paths = (res: ReturnType<typeof validateWorkflow>) =>
    res.ok ? [] : res.errors.map((e) => `${e.rule} ${e.path.join('.')}`);
  const at = 'states.implement.on.done.requirements';

  it('on_unmet.goto and else must exist (rule 1, at the gate)', () => {
    expect(paths(gated((g) => (g.on_unmet.goto = 'implment')))).toEqual([`1 ${at}.on_unmet.goto`]);
    expect(paths(gated((g) => (g.on_unmet.else = 'nobody')))).toEqual([`1 ${at}.on_unmet.else`]);
  });

  it('else defaults to needs_input, which must then exist', () => {
    expect(gated((g) => delete g.on_unmet.else).ok).toBe(true);
    const res = gated((g, raw) => {
      delete g.on_unmet.else;
      raw.states.ask = { type: 'human' };
      delete raw.states.needs_input;
      const on = raw.states.implement!.on as Record<string, unknown>;
      on.ask_user = 'ask';
      on.timeout = 'ask';
      for (const s of ['build', 'test']) {
        (raw.states[s]!.on as Record<string, { else: string }>).fail!.else = 'ask';
      }
      raw.on_budget_exceeded = 'ask';
    });
    expect(paths(res)).toEqual([`1 ${at}.on_unmet.else`]);
  });

  it('items: at least one, none blank, at most 30 (rule 1, dotted item paths)', () => {
    expect(paths(gated((g) => (g.items = [])))).toEqual([`1 ${at}.items`]);
    expect(paths(gated((g) => (g.items = ['ok', '   '])))).toEqual([`1 ${at}.items.1`]);
    const many = Array.from({ length: 31 }, (_, i) => `r${i}`);
    expect(paths(gated((g) => (g.items = many)))).toEqual([`1 ${at}.items`]);
  });

  it('retries are bounded 0..10 (rule 1)', () => {
    expect(gated((g) => (g.on_unmet.retries = 0)).ok).toBe(true);
    expect(gated((g) => (g.on_unmet.retries = 10)).ok).toBe(true);
    expect(paths(gated((g) => (g.on_unmet.retries = 11)))).toEqual([`1 ${at}.on_unmet.retries`]);
    expect(paths(gated((g) => (g.on_unmet.retries = 1.5)))).toEqual([`1 ${at}.on_unmet.retries`]);
  });

  it('a gate out of a human state is rejected (rule 8)', () => {
    const raw = reference('m1_reviewed.v1.json') as Raw;
    raw.states.needs_input!.on = {
      answered: {
        goto: 'implement',
        requirements: { items: ['x'], on_unmet: { goto: 'implement' } },
      },
    };
    expect(paths(validateWorkflow(raw))).toEqual(['8 states.needs_input.on.answered.requirements']);
  });

  it('a gate into a terminal state is allowed', () => {
    const raw = reference('m1_reviewed.v1.json') as Raw;
    raw.states.test!.on = {
      exit_0: {
        goto: 'done',
        requirements: { items: ['The README mentions /health'], on_unmet: { goto: 'implement' } },
      },
      fail: { goto: 'implement', attach: 'output', retries: 3, else: 'needs_input' },
    };
    expect(validateWorkflow(raw).ok).toBe(true);
  });

  it('a gate-only object is a plain transition: a loop of them is unbudgeted (rule 4)', () => {
    const raw = reference('m1_reviewed.v1.json') as Raw;
    raw.states.build!.on = {
      exit_0: 'test',
      fail: { goto: 'implement', requirements: { items: ['x'], on_unmet: { goto: 'build' } } },
    };
    expect(paths(validateWorkflow(raw)).map((p) => p.split(' ')[0])).toEqual(['4']);
  });

  it('the review step key is a reserved state name (rule 8)', () => {
    const raw = reference('m1_basic.v1.json') as Raw;
    raw.states.__review = { type: 'human' };
    (raw.states.implement!.on as Record<string, unknown>).ask_user = '__review';
    expect(paths(validateWorkflow(raw))).toEqual(['8 states.__review']);
  });

  it("the gate's else leg is a path to a human (rule 3)", () => {
    const raw = reference('m1_reviewed.v1.json') as Raw;
    const on = raw.states.implement!.on as Record<string, unknown>;
    delete on.ask_user;
    delete on.timeout;
    // No rule 3 (dead end): only rule 12, implement can no longer ask a human (ADR-0011).
    expect(paths(validateWorkflow(raw))).toEqual(['12 states.implement']);
  });
});
