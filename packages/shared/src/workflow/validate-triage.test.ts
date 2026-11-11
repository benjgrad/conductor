/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- raw definition edits in tests */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { triageDefinitionInput } from '../engine/apply.testkit.js';
import { WorkflowDefinitionSchema } from './schema.js';
import { validateWorkflow } from './validate.js';
import { triageLegs, triagePseudoEdges, triageSources } from './validate-triage.js';

// ADR-0043 rule 30 (the triage role), the relaxed "else is a human or triage state" of rules 8,
// 9, 13 and 19, and rule 4 on the edges `$return_to` / `$gate` stand for.

type Raw = { states: Record<string, any> } & Record<string, any>;
const base = (): Raw => structuredClone(triageDefinitionInput()) as Raw;
const found = (input: unknown) => {
  const r = validateWorkflow(input);
  return r.ok ? [] : r.errors.map((e) => `${e.rule} ${e.path.join('.')}`);
};
const parse = (raw: Raw) => WorkflowDefinitionSchema.parse(raw);

describe('rule 30: the triage role', () => {
  it('accepts the reference definition (a gate else into triage, four verdicts)', () => {
    expect(found(base())).toEqual([]);
  });

  it('accepts triage as an on_unmet.goto, an entry else and a watch on_broken target', () => {
    const goto = base();
    goto.states.implementing.on.pr_ready.on_unmet = { goto: 'triage', else: 'needs_input' };
    expect(found(goto)).toEqual([]);

    const entry = base();
    entry.states.implementing.on.pr_ready = 'in_qa';
    entry.states.in_qa = {
      type: 'command',
      cmd: 'true',
      entry: {
        checks: [{ name: 'Tests pass', cmd: 'npm test' }],
        on_unmet: { goto: 'implementing', else: 'triage' },
      },
      on: { exit_0: 'in_review', fail: 'needs_input' },
    };
    expect(found(entry)).toEqual([]);

    const watch = base();
    watch.states.in_review.watch = {
      conditions: [{ type: 'pr_mergeable' }],
      on_broken: { goto: 'implementing', else: 'triage' },
    };
    expect(validateWorkflow(watch, { allowUnavailable: true }).ok).toBe(true);
  });

  it('still refuses a plain agent state as an else target', () => {
    const raw = base();
    raw.states.implementing.on.pr_ready.on_unmet.else = 'fix_env';
    expect(found(raw)).toContain('13 states.implementing.on.pr_ready.on_unmet.else');
  });

  it('refuses an uncounted $return_to / $gate verdict, and an else that is not human', () => {
    const raw = base();
    raw.states.triage.on.send_back = { goto: '$return_to' };
    raw.states.triage.on.rerun = '$gate';
    raw.states.fix_env.on.exit_0 = { goto: '$gate', retries: 1, else: 'fix_env' };
    const errs = found(raw);
    expect(errs).toContain('30 states.triage.on.send_back.goto');
    expect(errs).toContain('30 states.triage.on.rerun');
    expect(errs).toContain('30 states.fix_env.on.exit_0.else');
  });

  it('rule 4 flags an uncounted triage loop', () => {
    const raw = base();
    raw.states.triage.on.rerun = { goto: '$gate' };
    expect(found(raw)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^4 states\./),
        '30 states.triage.on.rerun.goto',
      ]),
    );
  });

  it('refuses $gate / $return_to outside a triage state or its legs', () => {
    const raw = base();
    raw.states.implementing.on.retry = { goto: '$gate', retries: 1, else: 'needs_input' };
    raw.states.in_review.on.again = { goto: '$gate', actor: 'human' };
    const errs = found(raw);
    expect(errs).toContain('30 states.implementing.on.retry.goto');
    expect(errs).toContain('30 states.in_review.on.again.goto');
  });

  it('a state also entered from outside triage is no leg', () => {
    const raw = base();
    raw.states.implementing.on.fix = 'fix_env';
    expect(triageLegs(parse(raw)).has('fix_env')).toBe(false);
    expect(found(raw)).toContain('30 states.fix_env.on.exit_0.goto');
    expect(triageLegs(parse(base()))).toEqual(new Set(['fix_env']));
  });

  it('needs an escalate verdict, no questions, hand-offs or requirements on a verdict', () => {
    const raw = base();
    delete raw.states.triage.on.escalate;
    raw.states.triage.on.fix_env = {
      goto: 'fix_env',
      requires: { checks: [{ name: 'x', cmd: 'true' }] },
      on_unmet: { goto: 'implementing', else: 'needs_input' },
    };
    const errs = found(raw);
    expect(errs).toContain('30 states.triage.on');
    expect(errs).toContain('30 states.triage.on.fix_env.requires');

    const q = base();
    q.states.triage.on.escalate = { goto: 'needs_input', question: true };
    expect(found(q)).toContain('30 states.triage.on.escalate.question');
  });

  it('refuses a triage start state, entry, checkout, follow-ups and other tools', () => {
    const raw = base();
    raw.states.triage.tools = ['edit'];
    raw.states.triage.follow_ups = { enabled: true };
    const errs = found(raw);
    expect(errs).toContain('30 states.triage.tools');
    expect(errs).toContain('30 states.triage.follow_ups');

    const ok = base();
    ok.states.triage.tools = ['triage'];
    expect(found(ok)).toEqual([]);
  });

  it('refuses a triage state that nothing routes into', () => {
    const raw = base();
    raw.states.implementing.on.pr_ready.on_unmet.else = 'needs_input';
    raw.states.needs_input.on.triage_it = { goto: 'triage', actor: 'human' };
    expect(found(raw)).toEqual([]);
    raw.states.needs_input.on.triage_it = undefined;
    delete raw.states.needs_input.on.triage_it;
    expect(found(raw)).toEqual(expect.arrayContaining(['30 states.triage']));
  });

  it('expands the pseudo-targets into edges back to the failed state', () => {
    const def = parse(base());
    expect(triageSources(def, 'triage')).toEqual(['implementing']);
    const edges = triagePseudoEdges(def).map((e) => `${e.from}-${e.outcome}->${e.to}:${e.counted}`);
    expect(edges.sort()).toEqual([
      'fix_env-exit_0->implementing:true',
      'triage-rerun->implementing:true',
      'triage-send_back->implementing:true',
    ]);
  });

  it('an entry gate leads back to the states that enter it', () => {
    const raw = base();
    raw.states.implementing.on.pr_ready = 'in_qa';
    raw.states.in_qa = {
      type: 'command',
      cmd: 'true',
      entry: {
        checks: [{ name: 'Tests pass', cmd: 'npm test' }],
        on_unmet: { goto: 'implementing', else: 'triage' },
      },
      on: { exit_0: 'in_review', fail: 'needs_input' },
    };
    expect(triageSources(parse(raw), 'triage')).toEqual(['implementing']);
  });
});

describe('rule 30 leaves every shipped workflow unchanged', () => {
  it('each docs/design/workflows definition validates as before', () => {
    const dir = new URL('../../../../docs/design/workflows/', import.meta.url);
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      if (f.includes('repo-checks')) continue;
      const raw = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as unknown;
      const r = validateWorkflow(raw, { allowUnavailable: true });
      const rule29 = r.ok ? [] : r.errors.filter((e) => e.rule === 29);
      expect(rule29, f).toEqual([]);
    }
  });
});
