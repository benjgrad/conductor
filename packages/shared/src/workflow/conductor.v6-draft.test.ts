import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema } from './schema.js';
import { RepoChecksSchema } from './repo-checks.js';
import { validateWorkflow } from './validate.js';

// ADR-0037 T1: docs/design/workflows/conductor.v6.draft.json is the definition the builder would
// save once P1–P8 land. Each primitive's ticket lifted its rule-14 "not available yet" refusal; T7
// lifted the last, so it now validates as is (T9 saves the draft).

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

  it('validates without allowUnavailable: every ADR-0037 primitive is available (T7 last)', () => {
    const res = validateWorkflow(draft);
    expect(res.ok ? [] : res.errors).toEqual([]);
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
