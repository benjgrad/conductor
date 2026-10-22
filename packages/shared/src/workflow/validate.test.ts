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
  it.each(['m1_basic.v1.json', 'pr_flow.v1.json'])('%s is valid', (name) => {
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
    expect(new Set(FAILING.map(([, r]) => r))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));
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
