import { describe, expect, it } from 'vitest';
import { checkingOfStep } from '../api/rest.js';
import { CONDUCTOR_V4_DEF } from '../workflow/conductor.js';
import type { RepoChecks } from '../workflow/repo-checks.js';
import { freshSnapshot, Harness, HEAD_SHA } from './apply.testkit.js';
import { GateStepSchema, type ApplyResult, type Effect } from './types.js';

// R3: a check with `paths` is skipped by the daemon when the diff touches none of them
// (`command.exited.skipped`); it counts as passed and the checklist says so.

const CHECKS: RepoChecks = {
  setup: '',
  checks: [
    { name: 'Tests', cmd: 'pnpm test', paths: ['packages/**'] },
    { name: 'Cargo', cmd: 'cargo nextest run', paths: ['crates/**', 'Cargo.*'] },
  ],
};

const SKIP = 'no changes match paths: crates/**, Cargo.* (diff against origin/main)';

const runCmd = (effects: Effect[]) =>
  effects.find((e): e is Extract<Effect, { type: 'run_cmd' }> => e.type === 'run_cmd');

function implementing(checks: RepoChecks): Harness {
  const snap = freshSnapshot(CONDUCTOR_V4_DEF);
  snap.ticket = { ...snap.ticket, kind: 'personal' };
  snap.repo_checks = checks;
  const h = new Harness(CONDUCTOR_V4_DEF, snap).claimAndStart();
  h.run({
    type: 'agent.complete_state',
    result: { plan: 'p', summary: 's' },
    transition: 'plan_ready',
    reason: 'ok',
  });
  h.started();
  expect(h.snap.workflow_state).toBe('implementing');
  return h;
}

const ship = (h: Harness) =>
  h.run({
    type: 'agent.complete_state',
    result: { summary: 'done' },
    transition: 'personal_pr_ready_for_review',
    reason: 'Please review.',
  });

const skipped = (h: Harness, reason = SKIP, head_sha: string | null = HEAD_SHA): ApplyResult =>
  h.run({
    type: 'command.exited',
    command_id: h.newId(),
    exit_code: 0,
    timed_out: false,
    output_tail: reason,
    head_sha,
    skipped: reason,
  });

describe('diff-aware checks (R3)', () => {
  it('sends a check’s paths with its run_cmd; a check without paths sends none', () => {
    const h = implementing({
      checks: [
        { name: 'Tests', cmd: 'pnpm test', paths: ['packages/**'] },
        { name: 'Lint', cmd: 'x' },
      ],
    });
    let r = ship(h);
    expect(runCmd(r.effects)?.checkout).toMatchObject({ paths: ['packages/**'], last: false });
    r = h.cmdExit(0);
    expect(runCmd(r.effects)?.checkout).not.toHaveProperty('paths');
  });

  it('a skipped check passes: the next check runs, and the step records why', () => {
    const h = implementing(CHECKS);
    ship(h);
    h.cmdExit(0);
    const r = skipped(h);
    expect(h.snap.step?.skipped_checks).toEqual([{ index: 1, reason: SKIP }]);
    // Both checks passed (one skipped): on to the next phase, nothing unmet or counted.
    expect(runCmd(r.effects)).toBeUndefined();
    expect(h.snap.workflow_state).not.toBe('implementing');
    expect(h.snap.retry_counters).toEqual({});
  });

  it('every check skipped: the action pushes the commit the skips reported', () => {
    const h = implementing(CHECKS);
    ship(h);
    skipped(h, 'no changes match paths: packages/**');
    const r = skipped(h);
    expect(h.snap.step?.head_sha).toBe(HEAD_SHA);
    const action = r.effects.find((e) => e.type === 'run_action');
    expect(action).toMatchObject({ action: 'open_pr', expected_sha: HEAD_SHA });
  });

  it('the checklist shows a skipped check as skipped, with the reason', () => {
    const h = implementing(CHECKS);
    ship(h);
    skipped(h, 'no changes match paths: packages/**');
    const items = checkingOfStep(CONDUCTOR_V4_DEF, h.snap.step!).items!;
    expect(items.filter((i) => i.kind === 'check')).toEqual([
      {
        kind: 'check',
        label: 'Tests',
        status: 'skipped',
        detail: 'no changes match paths: packages/**',
      },
      { kind: 'check', label: 'Cargo', status: 'running', detail: null },
    ]);
  });

  it('no merge base: the daemon runs the check, and a failure is unmet as usual', () => {
    // The daemon's answer when it can't tell (FR-2) is an ordinary exit with no `skipped`.
    const h = implementing(CHECKS);
    ship(h);
    h.cmdExit(0);
    h.cmdExit(1, 'error[E0425]');
    expect(h.snap.workflow_state).toBe('implementing');
    expect(h.snap.step).toBeNull();
  });

  it('a later skip on a different commit is unmet: the branch moved', () => {
    const h = implementing(CHECKS);
    ship(h);
    h.cmdExit(0);
    skipped(h, SKIP, 'f'.repeat(40));
    expect(h.snap.workflow_state).toBe('implementing');
  });

  it('a step written before R3 still parses (no skipped checks)', () => {
    const h = implementing(CHECKS);
    ship(h);
    const old: Record<string, unknown> = { ...h.snap.step! };
    delete old.skipped_checks;
    expect(GateStepSchema.parse(old).skipped_checks).toEqual([]);
  });
});
