import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../domain.js';
import { WorkflowDefinitionSchema } from '../workflow/schema.js';
import { validateWorkflow } from '../workflow/validate.js';
import { Harness, triageDefinition, triageDefinitionInput } from './apply.testkit.js';
import { qaFenceChanged } from './qa.js';
import { TRIAGE_CONTEXT_KEY, triageOf, type TriageContext } from './triage.js';
import type { Effect } from './types.js';

// ADR-0043: a gate failure goes to a `role: 'triage'` state with the evidence; its verdicts send
// the work back (`$return_to`), rerun the gate (`$gate`), fix the environment (a command leg that
// reruns the gate) or escalate to a human. Every loop through it is counted.

const def = triageDefinition();
const WORKER = 'c1a0de00-0000-4000-8000-00000000000a';
const TRIAGE = 'c1a0de00-0000-4000-8000-00000000000c';
const FAIL_OUTPUT = 'FAIL src/health.test.ts\n  expected 200, got 500';

function effectsOf<T extends Effect['type']>(h: Harness, type: T) {
  return h.last.effects.filter((e): e is Extract<Effect, { type: T }> => e.type === type);
}

function startOf(h: Harness) {
  const starts = effectsOf(h, 'start_session');
  expect(starts).toHaveLength(1);
  return starts[0]!;
}

function enteredOf(h: Harness) {
  return effectsOf(h, 'state_entered');
}

const prReady = (h: Harness) =>
  h.run({
    type: 'agent.complete_state',
    transition: 'pr_ready',
    reason: 'done',
    result: { summary: 'Added /health.' },
  });

/** Claimed, the worker's Claude id known; its gate fails twice, so the second goes to triage. */
function inTriage(): Harness {
  const h = new Harness(def).claimAndStart();
  h.run({ type: 'agent.claude_session_id', claude_session_id: WORKER });
  prReady(h);
  h.cmdExit(1, FAIL_OUTPUT);
  expect(h.snap.workflow_state).toBe('implementing');
  h.started();
  prReady(h);
  h.cmdExit(1, FAIL_OUTPUT);
  expect(h.snap.workflow_state).toBe('triage');
  h.started();
  h.run({ type: 'agent.claude_session_id', claude_session_id: TRIAGE });
  return h;
}

function verdict(h: Harness, transition: string, reason: string, result: JsonObject = {}) {
  return h.run({
    type: 'agent.complete_state',
    transition,
    reason,
    result: { diagnosis: reason, ...result },
  });
}

function triage(h: Harness): TriageContext {
  const t = triageOf(h.snap.context);
  expect(t).not.toBeNull();
  return t!;
}

describe('ADR-0043 the triage role', () => {
  it('the reference definition validates', () => {
    expect(validateWorkflow(triageDefinitionInput()).ok).toBe(true);
  });

  it('(a) a failed gate enters triage with the evidence and a fresh read-only start', () => {
    const h = new Harness(def).claimAndStart();
    h.run({ type: 'agent.claude_session_id', claude_session_id: WORKER });
    prReady(h);
    h.cmdExit(1, FAIL_OUTPUT);
    h.started();
    prReady(h);
    h.cmdExit(1, FAIL_OUTPUT);
    expect(h.snap.workflow_state).toBe('triage');
    expect(enteredOf(h)).toEqual([
      expect.objectContaining({
        from: 'implementing → in_review (move: pr_ready)',
        to: 'triage',
        cause: 'retries_exhausted',
        transition: 'pr_ready',
      }),
    ]);
    const t = triage(h);
    expect(t).toMatchObject({
      gate: { kind: 'move', from: 'implementing', to: 'in_review', transition: 'pr_ready' },
      return_to: 'implementing',
      cause: 'retries_exhausted',
      transition: 'pr_ready',
      claude_session_id: null,
    });
    expect(t.question).toContain('expected 200, got 500');
    expect(t.question).not.toMatch(/Retry, skip, or abort\?$/);
    const start = startOf(h);
    expect(start).toMatchObject({
      state: 'triage',
      tools: ['triage'],
      resume_claude_session_id: null,
      review: true,
    });
    expect(start.mcp).toBeUndefined();
    expect(start.prompt).toContain('## What failed');
    expect(start.prompt).toContain('expected 200, got 500');
    expect(start.transitions?.map((o) => o.name)).toEqual([
      'send_back',
      'rerun',
      'fix_env',
      'escalate',
    ]);
    // The worker's conversation is untouched; the triage's is its own.
    h.started();
    h.run({ type: 'agent.claude_session_id', claude_session_id: TRIAGE });
    expect(h.snap.claude_session_id).toBe(WORKER);
    expect(triage(h).claude_session_id).toBe(TRIAGE);
  });

  it('(a) the wrapper fences entering and leaving triage', () => {
    expect(
      qaFenceChanged(def, { workflow_state: 'implementing' }, { workflow_state: 'triage' }),
    ).toBe(true);
    expect(qaFenceChanged(def, { workflow_state: 'triage' }, { workflow_state: 'fix_env' })).toBe(
      true,
    );
  });

  it('(b) send_back resumes the worker with the instruction and the evidence', () => {
    const h = inTriage();
    verdict(h, 'send_back', 'The test asserts the wrong status.', {
      instruction: 'Return 200 from /health when the DB is up; fix the handler, not the test.',
    });
    expect(h.snap.workflow_state).toBe('implementing');
    expect(enteredOf(h)).toEqual([
      expect.objectContaining({
        from: 'triage',
        to: 'implementing',
        cause: 'transition',
        transition: 'send_back',
        actor: 'agent',
        triage: { failure_cause: 'retries_exhausted', gate_transition: 'pr_ready' },
      }),
    ]);
    const start = startOf(h);
    expect(start.resume_claude_session_id).toBe(WORKER);
    expect(start.prompt).toContain('Sent back by Triage');
    expect(start.prompt).toContain('fix the handler, not the test');
    expect(start.prompt).toContain('expected 200, got 500');
    expect(h.snap.context[TRIAGE_CONTEXT_KEY]).toBeUndefined();
    expect(h.snap.retry_counters['triage->$return_to:pr_ready']).toBe(1);
  });

  it('(c) rerun runs the failed gate again; passing it clears the evidence', () => {
    const h = inTriage();
    const triageCmd = h.agentCmd;
    verdict(h, 'rerun', 'Flaky: the port was taken.');
    expect(h.snap.step).toMatchObject({ kind: 'move', from: 'implementing', to: 'in_review' });
    expect(effectsOf(h, 'kill')).toEqual([
      expect.objectContaining({ target_command_id: triageCmd }),
    ]);
    expect(enteredOf(h)).toEqual([
      expect.objectContaining({
        transition: 'rerun',
        triage: { failure_cause: 'retries_exhausted', gate_transition: 'pr_ready' },
      }),
    ]);
    expect(effectsOf(h, 'run_cmd')).toHaveLength(1);
    h.cmdExit(0);
    expect(h.snap.workflow_state).toBe('in_review');
    expect(h.snap.context[TRIAGE_CONTEXT_KEY]).toBeUndefined();
  });

  it('(c, f) a rerun that fails again comes back to triage; the second rerun goes to a human', () => {
    const h = inTriage();
    verdict(h, 'rerun', 'Flaky.');
    h.cmdExit(1, FAIL_OUTPUT);
    expect(h.snap.workflow_state).toBe('triage');
    h.started();
    verdict(h, 'rerun', 'Still flaky?');
    expect(h.snap.workflow_state).toBe('needs_input');
    const req = effectsOf(h, 'create_input_request')[0]!;
    expect(req.kind).toBe('retries_exhausted');
    expect(req.question).toContain('"rerun" for "pr_ready" 1 time already (limit 1)');
    expect(enteredOf(h)).toEqual([
      expect.objectContaining({
        cause: 'retries_exhausted',
        triage: { failure_cause: 'retries_exhausted', gate_transition: 'pr_ready' },
      }),
    ]);
    // Escalated: the evidence stays for the answer that brings the ticket back to triage.
    expect(triageOf(h.snap.context)).not.toBeNull();
  });

  it('(d) fix_env runs a command leg that reruns the gate', () => {
    const h = inTriage();
    verdict(h, 'fix_env', 'node_modules is stale.');
    expect(h.snap.workflow_state).toBe('fix_env');
    expect(effectsOf(h, 'run_cmd')[0]).toMatchObject({ state: 'fix_env', cmd: 'pnpm install' });
    expect(triageOf(h.snap.context)).not.toBeNull();
    h.cmdExit(0, 'installed');
    expect(h.snap.step).toMatchObject({ kind: 'move', from: 'implementing', to: 'in_review' });
    expect(h.snap.retry_counters['fix_env->$gate:pr_ready']).toBe(1);
    h.cmdExit(0);
    expect(h.snap.workflow_state).toBe('in_review');
  });

  it('(e) escalate opens a request that leads with the diagnosis; the answer returns to triage', () => {
    const h = inTriage();
    verdict(h, 'escalate', 'The test needs a database the CI runner does not have.');
    expect(h.snap.workflow_state).toBe('needs_input');
    const req = effectsOf(h, 'create_input_request')[0]!;
    expect(req.question).toMatch(
      /^Triage diagnosis \(Triage, "escalate"\): The test needs a database/,
    );
    expect(req.question).toContain('expected 200, got 500');
    expect(req.return_to).toBe('triage');
    const kept = triage(h);
    h.run({
      type: 'human.transition',
      name: 'answer',
      text: 'Mark it skipped on CI and send it back.',
      actor: 'ben',
    });
    expect(h.snap.workflow_state).toBe('triage');
    expect(triage(h).return_to).toBe(kept.return_to);
    const start = startOf(h);
    expect(start.tools).toEqual(['triage']);
    expect(start.prompt).toContain('Mark it skipped on CI');
    expect(start.prompt).toContain('## What failed');
  });

  it('(f) send_back is counted: past its retries it goes to its else', () => {
    const h = inTriage();
    for (let i = 0; i < 2; i++) {
      verdict(h, 'send_back', 'Fix it.', { instruction: 'Fix the handler.' });
      expect(h.snap.workflow_state).toBe('implementing');
      h.started();
      prReady(h);
      h.cmdExit(1, FAIL_OUTPUT);
      expect(h.snap.workflow_state).toBe('triage');
      h.started();
    }
    verdict(h, 'send_back', 'Fix it again.', { instruction: 'Fix the handler.' });
    expect(h.snap.workflow_state).toBe('needs_input');
    expect(h.snap.retry_counters['triage->$return_to:pr_ready']).toBe(2);
  });

  it('(g) a timeout and a failed check as on_unmet.goto reach triage too', () => {
    const raw = triageDefinitionInput() as { states: Record<string, Record<string, unknown>> };
    const on = raw.states.implementing!.on as Record<string, unknown>;
    on.pr_ready = {
      goto: 'in_review',
      requires: { checks: [{ name: 'Tests pass', cmd: 'npm test', timeout: '10m' }] },
      on_unmet: { goto: 'triage', retries: 2, else: 'needs_input' },
    };
    const h = new Harness(WorkflowDefinitionSchema.parse(raw)).claimAndStart();
    prReady(h);
    h.cmdExit(null, 'still running', true);
    expect(h.snap.workflow_state).toBe('triage');
    expect(triage(h)).toMatchObject({ cause: 'check_failed', transition: 'pr_ready' });
    expect(triage(h).unmet).toEqual([expect.objectContaining({ item: 'Tests pass' })]);

    const g = new Harness(WorkflowDefinitionSchema.parse(raw)).claimAndStart();
    prReady(g);
    g.cmdExit(1, FAIL_OUTPUT);
    expect(g.snap.workflow_state).toBe('triage');
    expect(triage(g)).toMatchObject({ cause: 'check_failed', return_to: 'implementing' });
    expect(triage(g).unmet).toEqual([
      expect.objectContaining({
        item: 'Tests pass',
        output: expect.stringContaining('500') as unknown as string,
      }),
    ]);
  });

  it('(g) a failed agent loop reaches triage without a gate; $gate then goes to a human', () => {
    const raw = triageDefinitionInput() as { states: Record<string, Record<string, unknown>> };
    (raw.states.implementing!.on as Record<string, unknown>).fail = {
      goto: 'implementing',
      retries: 0,
      else: 'triage',
    };
    const h = new Harness(WorkflowDefinitionSchema.parse(raw)).claimAndStart();
    h.run({
      type: 'agent.exited',
      command_id: h.agentCmd,
      code: 1,
      signal: null,
      stderr_tail: 'boom',
    });
    expect(h.snap.workflow_state).toBe('triage');
    expect(triage(h)).toMatchObject({ gate: null, return_to: 'implementing' });
    h.started();
    verdict(h, 'rerun', 'Try again.');
    expect(h.snap.workflow_state).toBe('needs_input');
    expect(effectsOf(h, 'create_input_request')[0]!.question).toContain('nothing to run again');
  });

  it('(h) the late exit of the triage process after its verdict is ignored', () => {
    const h = inTriage();
    const triageCmd = h.agentCmd;
    verdict(h, 'send_back', 'Fix it.', { instruction: 'Fix it.' });
    const r = h.run({ type: 'agent.exited', command_id: triageCmd, code: 0, signal: null });
    expect(r.ignored).toBe('command_id_mismatch');
  });

  it('a $return_to verdict without recorded evidence goes to a human (fallback)', () => {
    const h = new Harness(def).claimAndStart();
    // A session in triage with nothing recorded (it can't be routed there without a failure).
    const snap = structuredClone(h.snap);
    snap.workflow_state = 'triage';
    const g = new Harness(def, snap);
    verdict(g, 'send_back', 'Fix it.');
    expect(g.snap.workflow_state).toBe('needs_input');
    expect(enteredOf(g)).toEqual([expect.objectContaining({ cause: 'fallback' })]);
  });
});

describe('ADR-0043 every path through triage ends at a human (property)', () => {
  const VERDICTS = ['send_back', 'rerun', 'fix_env', 'escalate'] as const;

  /** Drive the session: each step takes the next choice the place allows. */
  function drive(h: Harness, verdicts: readonly string[], passes: readonly boolean[]) {
    let v = 0;
    let p = 0;
    let triageEntries = 1;
    for (let i = 0; i < 80; i++) {
      const state = h.snap.workflow_state;
      if (h.snap.step !== null) {
        h.cmdExit(passes[p++ % passes.length] ? 0 : 1, FAIL_OUTPUT);
        if (h.snap.workflow_state === 'triage') triageEntries++;
        continue;
      }
      if (state === 'triage') {
        if (h.snap.agent_command_id !== null && !h.snap.agent_process_live) h.started();
        verdict(h, verdicts[v++ % verdicts.length]!, 'judged', { instruction: 'Fix it.' });
      } else if (state === 'implementing') {
        if (h.snap.agent_command_id !== null && !h.snap.agent_process_live) h.started();
        prReady(h);
      } else if (state === 'fix_env') {
        h.cmdExit(passes[p++ % passes.length] ? 0 : 1, 'installed');
      } else {
        break;
      }
    }
    return triageEntries;
  }

  it('random verdicts and gate results never loop forever; all-failing gates reach needs_input', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...VERDICTS), { minLength: 1, maxLength: 12 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }),
        (verdicts, passes) => {
          const h = inTriage();
          const entries = drive(h, verdicts, passes);
          expect(['in_review', 'needs_input']).toContain(h.snap.workflow_state);
          // send_back 2 + rerun 1 + fix_env's rerun 1, plus the first entry.
          expect(entries).toBeLessThanOrEqual(5);
          for (const [k, n] of Object.entries(h.snap.retry_counters)) {
            if (k.startsWith('triage->$return_to')) expect(n).toBeLessThanOrEqual(2);
            if (k.startsWith('triage->$gate') || k.startsWith('fix_env->$gate')) {
              expect(n).toBeLessThanOrEqual(1);
            }
          }
          if (passes.every((x) => !x)) expect(h.snap.workflow_state).toBe('needs_input');
        },
      ),
      { numRuns: 150 },
    );
  });
});
