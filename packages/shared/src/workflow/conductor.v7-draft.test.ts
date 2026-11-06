import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { requiredCapabilitiesOf } from './capabilities.js';
import { WorkflowDefinitionSchema } from './schema.js';
import { validateWorkflow } from './validate.js';

// ADR-0039 B1: docs/design/workflows/conductor.v7.draft.json is the v6 draft plus `bases`,
// `base_default` and `$base` in `resync_main`, `fix_and_resubmit` and the merge checks. It passes
// every rule but rule 14's "not available yet" refusals. B2 shrinks the refusal list.

const read = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../../docs/design/workflows/${name}`, import.meta.url), 'utf8'),
  );
const draft = read('conductor.v7.draft.json');

describe('conductor v7 draft (ADR-0039)', () => {
  it('parses with WorkflowDefinitionSchema', () => {
    expect(WorkflowDefinitionSchema.safeParse(draft).error).toBeUndefined();
  });

  it('passes every rule with allowUnavailable, warning once for the sprint cmd base', () => {
    const res = validateWorkflow(draft, { allowUnavailable: true });
    expect(res.ok ? [] : res.errors).toEqual([]);
    expect(res.warnings?.map((w) => `${w.rule} ${w.path.join('.')}`)).toEqual([
      '26 bases.sprint.pr_into',
    ]);
  });

  it('without it, only rule 14 refuses: v6 concurrency plus every base field', () => {
    const res = validateWorkflow(draft);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.every((e) => e.rule === 14)).toBe(true);
    const at = (t: string, ...rest: (string | number)[]) =>
      ['states', 'implementing', 'on', t, ...rest].join('.');
    const gates = ['ready_for_testing', 'pr_ready_for_review', 'personal_pr_ready_for_review'];
    expect(res.errors.map((e) => e.path.join('.')).sort()).toEqual(
      [
        at('pr_ready_for_review', 'requires', 'concurrency'),
        at('personal_pr_ready_for_review', 'requires', 'concurrency'),
        'bases',
        'base_default',
        'instructions.resync_main',
        'instructions.fix_and_resubmit',
        ...gates.map((t) => at(t, 'requires', 'checks', 2, 'cmd')),
      ].sort(),
    );
  });

  it('routes: az only when the kind defaults to the az cmd base', () => {
    const def = WorkflowDefinitionSchema.parse(draft);
    expect(requiredCapabilitiesOf(def, 'work')).not.toContain('cli:az:authed');
    const hot = WorkflowDefinitionSchema.parse({
      ...(draft as object),
      base_default: { work: 'hotfix', personal: 'default' },
    });
    expect(requiredCapabilitiesOf(hot, 'work')).toContain('cli:az:authed');
    expect(requiredCapabilitiesOf(hot, null)).toContain('cli:az:authed');
    expect(requiredCapabilitiesOf(hot, 'personal')).not.toContain('cli:az:authed');
  });
});
