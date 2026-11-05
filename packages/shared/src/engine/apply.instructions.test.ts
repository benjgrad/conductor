import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from '../workflow/schema.js';
import { Harness, qaDefinition } from './apply.testkit.js';
import { renderReviewFeedback } from './review.js';
import type { Effect } from './types.js';

// ADR-0037 P5 (T8): an `on_unmet.instruction` that is a `$instructions.<slug>` ref is resolved
// when the move is taken, against the definition the session runs on (its pinned version), and
// the prompt shows the text, never the ref.

/** qaDefinition with `pr_ready.on_unmet.instruction` = `instruction` and `instructions`. */
function withInstruction(instruction: string, texts?: Record<string, string>): WorkflowDefinition {
  const raw = structuredClone(qaDefinition()) as WorkflowDefinition;
  const t = raw.states.implementing!;
  if (t.type !== 'agent') throw new Error('implementing is an agent state');
  const pr = t.on!.pr_ready;
  if (typeof pr !== 'object' || pr.on_unmet === undefined) throw new Error('pr_ready.on_unmet');
  pr.on_unmet.instruction = instruction;
  return WorkflowDefinitionSchema.parse({ ...raw, ...(texts ? { instructions: texts } : {}) });
}

const startOf = (effects: Effect[]) =>
  effects.find((e): e is Extract<Effect, { type: 'start_session' }> => e.type === 'start_session');

/** The worker finishes, the check fails: back to implementing with the feedback. */
function failCheck(h: Harness) {
  h.run({
    type: 'agent.complete_state',
    transition: 'pr_ready',
    reason: 'done',
    result: { summary: 'Added /health.' },
  });
  return h.cmdExit(1, 'FAIL src/health.test.ts');
}

describe('ADR-0037 P5 instruction refs in on_unmet', () => {
  it('a ref resolves to the instruction text in the prompt, never the ref', () => {
    const h = new Harness(withInstruction('$instructions.fix', { fix: 'Fix it v1.' })).claimAndStart();
    const r = failCheck(h);
    expect(h.snap.workflow_state).toBe('implementing');
    const prompt = startOf(r.effects)!.prompt;
    expect(prompt).toContain('Fix it v1.');
    expect(prompt).not.toContain('$instructions');
  });

  it('resolves against the pinned version: a newer version changes only later moves', () => {
    const v1 = withInstruction('$instructions.fix', { fix: 'Fix it v1.' });
    const v2 = withInstruction('$instructions.fix', { fix: 'Fix it v2.' });
    const h = new Harness(v1).claimAndStart();
    const first = startOf(failCheck(h).effects)!.prompt;
    expect(first).toContain('Fix it v1.');
    // The prompt already sent carries the text, so a newer version can't reach it. The engine
    // only ever sees the session's pinned definition (EngineService loads it by
    // session.workflow_version); a session pinned to v2 gets v2's text.
    h.started();
    const repinned = new Harness(v2, h.snap, h.now);
    const second = startOf(failCheck(repinned).effects)!.prompt;
    expect(second).toContain('Fix it v2.');
    expect(second).not.toContain('Fix it v1.');
    expect(first).not.toContain('Fix it v2.');
  });

  it('a literal instruction still works', () => {
    const h = new Harness(withInstruction('Just fix it.')).claimAndStart();
    expect(startOf(failCheck(h).effects)!.prompt).toContain('Just fix it.');
  });

  it('the feedback never renders an unresolved ref', () => {
    const text = renderReviewFeedback({
      heading: 'Requirements for x were not met:',
      unmet: [{ item: 'Tests pass', reason: 'exit 1' }],
      instruction: '$instructions.gone',
    });
    expect(text).not.toContain('$instructions');
  });
});
