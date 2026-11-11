/* eslint-disable @typescript-eslint/no-explicit-any -- raw definition edits in tests */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_RESULT_KINDS,
  AVAILABLE_WORKFLOW_FEATURES,
  NEVER_AUTO_ANSWERED,
  WORKFLOW_FEATURES,
  WorkflowDefinitionSchema,
} from './schema.js';
import { AVAILABLE_TOOL_ALIASES } from './tools.js';
import { checkAvailability, validateWorkflow } from './validate.js';

// ADR-0040 (R5a slice 1): the workflow `answerer` block. Rule 28 and rule 14's refusal of the
// feature. The base is the live conductor v6 (conductor.v6.test.ts).

type Raw = { states: Record<string, any> } & Record<string, any>;
const V6 = JSON.parse(
  readFileSync(
    new URL('../../../../docs/design/workflows/conductor.v6.json', import.meta.url),
    'utf8',
  ),
) as Raw;
const ROUTABLE = ['ask_user', 'scope_changed', 'needs_product_context'];
const withAnswerer = (answerer: Record<string, unknown>): Raw => ({
  ...structuredClone(V6),
  answerer,
});

function rule28(def: Raw) {
  const r = validateWorkflow(def, { allowUnavailable: true });
  return r.ok ? [] : r.errors.filter((e) => e.rule === 28 || e.rule === 1);
}

describe('answerer block (ADR-0040)', () => {
  it('v6 with the recommended applies_to passes every other rule', () => {
    const r = validateWorkflow(withAnswerer({ applies_to: ROUTABLE }), { allowUnavailable: true });
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it('is refused "not available yet" at answerer while the feature is off', () => {
    expect(AVAILABLE_WORKFLOW_FEATURES).not.toContain('answerer');
    expect(WORKFLOW_FEATURES).toContain('answerer');
    const r = validateWorkflow(withAnswerer({ applies_to: ROUTABLE }));
    expect(r.ok ? [] : r.errors).toEqual([
      { rule: 14, path: ['answerer'], message: 'the answerer is not available yet' },
    ]);
  });

  it('is accepted once the feature is available', () => {
    const def = WorkflowDefinitionSchema.parse(withAnswerer({ applies_to: ROUTABLE }));
    const errors = checkAvailability(def, {
      tools: AVAILABLE_TOOL_ALIASES,
      resultKinds: AVAILABLE_RESULT_KINDS,
      features: [...AVAILABLE_WORKFLOW_FEATURES, 'answerer'],
    });
    expect(errors).toEqual([]);
  });

  it('defaults min_confidence to high and leaves model and timeout unset', () => {
    const def = WorkflowDefinitionSchema.parse(withAnswerer({ applies_to: ['ask_user'] }));
    expect(def.answerer).toEqual({ applies_to: ['ask_user'], min_confidence: 'high' });
  });

  it.each(NEVER_AUTO_ANSWERED)('refuses %s, which needs a human', (name) => {
    expect(rule28(withAnswerer({ applies_to: ['ask_user', name] }))).toEqual([
      {
        rule: 28,
        path: ['answerer', 'applies_to', 1],
        message: `"${name}" needs a human's decision and can't be answered by conductor`,
      },
    ]);
  });

  it('refuses a hand-off, an unknown name and a duplicate, each at its index', () => {
    const def = withAnswerer({
      applies_to: ['ask_user', 'pr_ready_for_review', 'nope', 'ask_user'],
    });
    expect(rule28(def)).toEqual([
      {
        rule: 28,
        path: ['answerer', 'applies_to', 1],
        message: `"pr_ready_for_review" hands work off for review; it isn't a question`,
      },
      { rule: 28, path: ['answerer', 'applies_to', 2], message: 'no agent state asks "nope"' },
      { rule: 28, path: ['answerer', 'applies_to', 3], message: '"ask_user" is listed twice' },
    ]);
  });

  it('refuses a transition that exists but is not a question (plan_ready)', () => {
    expect(rule28(withAnswerer({ applies_to: ['plan_ready'] }))).toEqual([
      {
        rule: 28,
        path: ['answerer', 'applies_to', 0],
        message: 'no agent state asks "plan_ready"',
      },
    ]);
  });

  it('bounds the timeout to 1m–30m', () => {
    const msg = "the answerer's timeout must be between 1m and 30m";
    expect(rule28(withAnswerer({ applies_to: ['ask_user'], timeout: '45m' }))).toEqual([
      { rule: 28, path: ['answerer', 'timeout'], message: msg },
    ]);
    expect(rule28(withAnswerer({ applies_to: ['ask_user'], timeout: '30s' }))).toEqual([
      { rule: 28, path: ['answerer', 'timeout'], message: msg },
    ]);
    expect(rule28(withAnswerer({ applies_to: ['ask_user'], timeout: '30m' }))).toEqual([]);
  });

  it('the schema refuses an empty applies_to, a low min_confidence and unknown keys', () => {
    for (const answerer of [
      { applies_to: [] },
      { applies_to: ['ask_user'], min_confidence: 'low' },
      { applies_to: ['ask_user'], extra: 1 },
    ]) {
      expect(WorkflowDefinitionSchema.safeParse(withAnswerer(answerer)).success).toBe(false);
    }
  });

  it('the live v6 without the block still validates', () => {
    expect(validateWorkflow(V6).ok).toBe(true);
  });
});
