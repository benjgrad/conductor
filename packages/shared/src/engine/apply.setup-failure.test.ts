import { describe, expect, it } from 'vitest';
import { humanTransitionsOfCard } from '../api/rest.js';
import { CONDUCTOR_V4_DEF } from '../workflow/conductor.js';
import type { RepoChecks } from '../workflow/repo-checks.js';
import { freshSnapshot, HEAD_SHA, Harness } from './apply.testkit.js';
import { CHECK_CONFIG_KEY, RETRY_CHECKS } from './setup-failure.js';
import type { Effect, EngineEvent } from './types.js';

// A failed check setup, triaged by the daemon's run of the same setup on the base branch's tip
// (cmd_exit `setup_on_base`): failing there too, it is conductor's check config → a human,
// `check_config`, uncounted; passing there, it is the branch → back to the agent, counted.

const REPO = 'github.com/benjgrad/fixture-app';

/** The 2026-11-06 override: a setup that needs an `origin` remote the fresh checkout lacks. */
const INCIDENT: RepoChecks = {
  setup: 'git fetch -q origin && git branch -f main origin/main',
  checks: [{ name: 'Merges cleanly', cmd: 'git merge-tree --write-tree origin/main HEAD' }],
};
const META = { updated_at: '2026-11-06T14:28:00.000Z', updated_by: 'ben@example.com' };
const FATAL = "fatal: 'origin' does not appear to be a git repository";

const of = <T extends Effect['type']>(effects: Effect[], type: T) =>
  effects.filter((e): e is Extract<Effect, { type: T }> => e.type === type);

function implementing(override: RepoChecks | null = INCIDENT): Harness {
  const snap = freshSnapshot(CONDUCTOR_V4_DEF);
  snap.ticket = { ...snap.ticket, kind: 'personal', repo: REPO };
  snap.repo_checks = override;
  snap.repo_checks_meta = override === null ? null : META;
  const h = new Harness(CONDUCTOR_V4_DEF, snap).claimAndStart();
  h.run({
    type: 'agent.complete_state',
    result: { plan: 'p', summary: 's' },
    transition: 'plan_ready',
    reason: 'ok',
  });
  h.started();
  return h;
}

const ship = (h: Harness) =>
  h.run({
    type: 'agent.complete_state',
    result: { summary: 'done' },
    transition: 'personal_pr_ready_for_review',
    reason: 'Please review.',
  });

function setupFailed(
  h: Harness,
  onBase: 'pass' | 'fail' | 'unknown' | undefined,
  cmd: string | null = INCIDENT.setup!,
) {
  const e: EngineEvent = {
    type: 'command.exited',
    command_id: h.newId(),
    exit_code: 128,
    timed_out: false,
    output_tail: FATAL,
    head_sha: HEAD_SHA,
    setup_failed: true,
    ...(cmd !== null ? { setup_cmd: cmd } : {}),
    ...(onBase !== undefined ? { setup_on_base: onBase, base_ref: 'main' } : {}),
  };
  return h.run(e);
}

describe('a setup that fails on the base branch too (conductor’s check config)', () => {
  it('goes to a human as check_config, uncounted, naming the command, source and fix', () => {
    const h = implementing();
    ship(h);
    const counters = { ...h.snap.retry_counters };
    const r = setupFailed(h, 'fail');
    expect(r.snapshot).toMatchObject({ workflow_state: 'needs_input', status: 'needs_input' });
    expect(r.snapshot.retry_counters).toEqual(counters);
    expect(of(r.effects, 'start_session')).toEqual([]);
    const reqs = of(r.effects, 'create_input_request');
    expect(reqs).toHaveLength(1);
    const q = reqs[0]!.question;
    expect(reqs[0]!.kind).toBe('check_config');
    expect(q.split('\n')[0]).toBe(
      `Setup failed before any check ran: \`${INCIDENT.setup}\` (from the repo checks override for ${REPO}, saved 2026-11-06 14:28 UTC by ben@example.com).`,
    );
    expect(q).toContain('not your branch');
    expect(q).toContain(`set_repo_checks for ${REPO}`);
    expect(q).toContain('fails on `main` too');
    expect(q).toContain(FATAL);
    const entered = of(r.effects, 'state_entered').at(-1)!;
    expect(entered).toMatchObject({ to: 'needs_input', cause: 'check_failed', actor: 'system' });
    expect(r.snapshot.context[CHECK_CONFIG_KEY]).toMatchObject({
      from: 'implementing',
      at: 'needs_input',
    });
  });

  it('the card offers Retry checks', () => {
    const h = implementing();
    ship(h);
    const r = setupFailed(h, 'fail');
    const buttons = humanTransitionsOfCard(
      { kind: 'personal' },
      {
        status: r.snapshot.status,
        workflow_state: r.snapshot.workflow_state,
        context: r.snapshot.context,
        return_to: r.snapshot.return_to,
      },
      { def: CONDUCTOR_V4_DEF } as unknown as Parameters<typeof humanTransitionsOfCard>[2],
      'check_config',
    );
    expect(buttons[0]).toMatchObject({ name: RETRY_CHECKS, title: 'Retry checks' });
  });

  it('gate.retry re-runs the gate with the repo’s new checks', () => {
    const h = implementing();
    ship(h);
    setupFailed(h, 'fail');
    const fixed: RepoChecks = { ...INCIDENT, setup: 'git fetch -q --all' };
    h.snap = { ...h.snap, repo_checks: fixed };
    const r = h.run({ type: 'gate.retry', actor: 'ui' });
    expect(r.ignored).toBeNull();
    expect(r.snapshot.status).toBe('running');
    expect(r.snapshot.step).toMatchObject({ from: 'implementing', repo_checks: fixed });
    expect(of(r.effects, 'run_cmd')[0]).toMatchObject({
      cmd: INCIDENT.checks[0]!.cmd,
      checkout: { setup: 'git fetch -q --all' },
    });
    expect(r.snapshot.context[CHECK_CONFIG_KEY]).toBeUndefined();
    // A second retry has nothing to retry.
    expect(h.run({ type: 'gate.retry', actor: 'ui' }).ignored).toBe('wrong_status');
  });

  it('gate.retry is refused outside a check_config wait', () => {
    const h = implementing();
    expect(h.run({ type: 'gate.retry', actor: 'ui' }).ignored).toBe('wrong_status');
    ship(h);
    expect(h.run({ type: 'gate.retry', actor: 'ui' }).ignored).toBe('wrong_status');
  });

  it('gate.retry is refused once the human moved the ticket on', () => {
    const h = implementing();
    ship(h);
    setupFailed(h, 'fail');
    // The human sends it back to the agent; a later needs_input visit is not that wait.
    h.run({ type: 'input.provided', input_request_id: h.newId(), answer: 'try again' });
    expect(h.run({ type: 'gate.retry', actor: 'ui' }).ignored).toBe('wrong_status');
  });
});

describe('a setup that passes on the base branch (the branch’s problem)', () => {
  it('goes back to the agent, counted, with the same message and the propose hint', () => {
    const h = implementing();
    ship(h);
    const r = setupFailed(h, 'pass');
    expect(r.snapshot.workflow_state).toBe('implementing');
    expect(Object.values(r.snapshot.retry_counters).some((n) => n === 1)).toBe(true);
    const prompt = of(r.effects, 'start_session')[0]!.prompt;
    expect(prompt).toContain(`Setup failed before any check ran: \`${INCIDENT.setup}\``);
    expect(prompt).toContain('It passes on `main`, so something on this branch breaks it');
    expect(prompt).toContain('proposed_checks');
    expect(prompt).toContain(FATAL);
    expect(r.snapshot.context[CHECK_CONFIG_KEY]).toBeUndefined();
  });

  it('an unknown or absent probe keeps today’s routing, saying it could not tell', () => {
    for (const onBase of ['unknown', undefined] as const) {
      const h = implementing(null);
      ship(h);
      const r = setupFailed(h, onBase, null);
      expect(r.snapshot.workflow_state).toBe('implementing');
      const prompt = of(r.effects, 'start_session')[0]!.prompt;
      expect(prompt).toContain('the auto-detected setup (auto-detected from the lockfile)');
      expect(prompt).toContain('could not tell whether it also fails on');
    }
  });
});

describe('replay: the 2026-11-06 incident (7e816416 / edc5cfca)', () => {
  it('produces one question to Ben naming the setup and set_repo_checks, and no agent retry', () => {
    const h = implementing();
    const effects: Effect[] = [];
    effects.push(...ship(h).effects);
    const r = setupFailed(h, 'fail');
    effects.push(...r.effects);
    const asks = of(effects, 'create_input_request');
    expect(asks).toHaveLength(1);
    expect(asks[0]!.question).toContain(INCIDENT.setup!);
    expect(asks[0]!.question).toContain('set_repo_checks');
    expect(of(effects, 'start_session')).toEqual([]);
    expect(h.snap.retry_counters).toEqual({});
  });
});
