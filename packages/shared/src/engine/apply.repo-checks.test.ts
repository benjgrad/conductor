import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V4_DEF } from '../workflow/conductor.js';
import type { RepoChecks } from '../workflow/repo-checks.js';
import { freshSnapshot, Harness } from './apply.testkit.js';
import { GateStepSchema, type Effect } from './types.js';

// ADR-0030: a repo's check override replaces a shipping transition's checks, pinned per step.

const OVERRIDE: RepoChecks = {
  setup: '',
  checks: [
    { name: 'Web build', cmd: 'cd m-one && npm ci && npm run build', timeout: '15m' },
    { name: '.NET tests', cmd: 'vstest.console.exe Com.Method.Tests.dll' },
  ],
};

const runCmd = (effects: Effect[]) =>
  effects.find((e): e is Extract<Effect, { type: 'run_cmd' }> => e.type === 'run_cmd');

/** A personal ticket running Implementing on conductor v4, with `override` on the session. */
function implementing(override: RepoChecks | null): Harness {
  const snap = freshSnapshot(CONDUCTOR_V4_DEF);
  snap.ticket = { ...snap.ticket, kind: 'personal' };
  snap.repo_checks = override;
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

describe('repo checks in a move step', () => {
  it('without an override, the workflow’s checks run (auto-detected setup)', () => {
    const r = ship(implementing(null));
    expect(runCmd(r.effects)).toMatchObject({
      cmd: 'npm run build',
      checkout: { setup: null, last: false },
    });
  });

  it('runs the override’s checks with its setup and timeouts, in order', () => {
    const h = implementing(OVERRIDE);
    let r = ship(h);
    expect(h.snap.step?.repo_checks).toEqual(OVERRIDE);
    expect(runCmd(r.effects)).toMatchObject({
      cmd: OVERRIDE.checks[0]!.cmd,
      timeout_ms: 15 * 60_000,
      checkout: { setup: '', last: false },
    });
    r = h.cmdExit(0);
    expect(runCmd(r.effects)).toMatchObject({
      cmd: OVERRIDE.checks[1]!.cmd,
      checkout: { setup: '', last: true },
    });
  });

  it('is pinned on the step: an edit mid-step changes nothing until the next attempt', () => {
    const h = implementing(OVERRIDE);
    ship(h);
    h.snap = { ...h.snap, repo_checks: { checks: [{ name: 'Other', cmd: 'make' }] } };
    const r = h.cmdExit(0);
    expect(runCmd(r.effects)?.cmd).toBe(OVERRIDE.checks[1]!.cmd);
  });

  it('a failed override check goes back to Implementing, naming it', () => {
    const h = implementing(OVERRIDE);
    ship(h);
    h.cmdExit(0);
    const r = h.cmdExit(1, 'error MSB3027: could not copy');
    expect(h.snap.workflow_state).toBe('implementing');
    expect(h.snap.step).toBeNull();
    const start = r.effects.find((e) => e.type === 'start_session');
    expect(JSON.stringify(start)).toContain('.NET tests');
  });

  it('an older step without repo_checks still parses (null)', () => {
    const h = implementing(null);
    ship(h);
    const old: Record<string, unknown> = { ...h.snap.step! };
    delete old.repo_checks;
    expect(GateStepSchema.parse(old).repo_checks).toBeNull();
  });
});
