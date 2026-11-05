import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema } from './schema.js';
import { RepoChecksSchema } from './repo-checks.js';
import { validateWorkflow } from './validate.js';

// ADR-0037 T1: docs/design/workflows/conductor.v6.draft.json is the definition the builder would
// save once P1–P8 land. With the schema in, it parses as is and passes every rule but rule 14's
// "not available yet" refusals (`allowUnavailable`). Each primitive's ticket shrinks the refusal
// list below until it is empty (T9 saves the draft).

const read = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../../docs/design/workflows/${name}`, import.meta.url), 'utf8'),
  );
const draft = read('conductor.v6.draft.json');

describe('conductor v6 draft (ADR-0037)', () => {
  it('parses with WorkflowDefinitionSchema', () => {
    expect(WorkflowDefinitionSchema.safeParse(draft).error).toBeUndefined();
  });

  it('passes every rule with allowUnavailable', () => {
    const res = validateWorkflow(draft, { allowUnavailable: true });
    expect(res.ok ? [] : res.errors).toEqual([]);
  });

  it('without it, only rule 14 refuses, once per ADR-0037 field', () => {
    const res = validateWorkflow(draft);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.every((e) => e.rule === 14)).toBe(true);
    const pr = ['pr_ready_for_review', 'personal_pr_ready_for_review'];
    const gates = [...pr, 'ready_for_testing'];
    const at = (s: string, t: string, ...rest: (string | number)[]) =>
      ['states', s, 'on', t, ...rest].join('.');
    expect(res.errors.map((e) => e.path.join('.')).sort()).toEqual(
      [
        'instructions',
        'notify',
        'states.in_review.watch',
        'states.needs_input.watch',
        'states.in_review.watch.on_broken.instruction',
        at('in_review', 'request_changes', 'presets'),
        at('planning', 'plan_needs_approval', 'notify'),
        ...pr.map((t) => at('implementing', t, 'handoff')),
        ...pr.map((t) => at('implementing', t, 'requires', 'concurrency')),
        ...gates.map((t) => at('implementing', t, 'on_unmet', 'instruction')),
      ].sort(),
    );
  });

  it('the repo-checks draft is a valid set_repo_checks payload', () => {
    const { repo, ...payload } = read('conductor.repo-checks.draft.json') as Record<
      string,
      unknown
    >;
    expect(repo).toBe('github.com/benjgrad/conductor');
    const parsed = RepoChecksSchema.safeParse(payload);
    expect(parsed.error).toBeUndefined();
  });
});
