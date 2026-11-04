import { randomUUID } from 'node:crypto';
import {
  CONDUCTOR_V4_DEF,
  OPEN_PROPOSALS_MAX,
  transitionsOf,
  type ProposeChangeInput,
} from '@conductor/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyProposal,
  createProposal,
  getProposal,
  listProposals,
  rejectProposal,
  reviewProposal,
  type ProposalActor,
} from '../src/advisor/proposals.js';
import { setRepoChecks } from '../src/api/repo-checks.js';
import { useTestDatabase } from './db.js';

// ADR-0033 P3 (MA-T05): the proposal store against a real migrated database: the account scope,
// the row lock that makes apply run once, and the guards it re-runs (the workflow admin gate,
// approvals, base_version, the repo checks' snapshot) are SQL and transactions, so they're what is
// under test here. The diff and the metric comparison have pure tests in shared.

const db = useTestDatabase();

async function account(name: string): Promise<string> {
  const r = await db.pool.query<{ id: string }>(
    'INSERT INTO account (name) VALUES ($1) RETURNING id',
    [name],
  );
  return r.rows[0]!.id;
}

type Def = {
  id: string;
  states: Record<string, { title?: string; on?: Record<string, string | object> }>;
};
const def = (id: string, edit: (d: Def) => void = () => {}): Record<string, unknown> => {
  const d = structuredClone(CONDUCTOR_V4_DEF) as unknown as Def;
  d.id = id;
  edit(d);
  return d;
};
const FIRST_STATE = Object.keys(CONDUCTOR_V4_DEF.states)[0]!;
const retitle = (title: string) => (d: Def) => {
  d.states[FIRST_STATE]!.title = title;
};
const HUMAN_T = transitionsOf(CONDUCTOR_V4_DEF, 'needs_input', { actor: 'human' })[0]!.name;
const gate = (d: Def) => {
  const t = d.states.needs_input!.on![HUMAN_T];
  d.states.needs_input!.on![HUMAN_T] = {
    ...(typeof t === 'string' ? { goto: t } : t),
    requires: { approvals: [{ id: 'migration', label: 'Approve', paths: ['**/migrations/**'] }] },
  };
};
async function storeWorkflow(id: string, version: number, definition: Record<string, unknown>) {
  await db.pool.query(
    'INSERT INTO workflow_definition (id, version, definition) VALUES ($1, $2, $3)',
    [id, version, JSON.stringify({ ...definition, version })],
  );
}

const META = {
  title: 'Build in m-one',
  rationale: 'The root has no package.json.',
  evidence: [{ finding_id: 'failing_check:npm run build', text: '5 of 5 runs failed' }],
  expected_effect: {
    metric: 'check_failure_rate' as const,
    scope: { check: 'npm run build' },
    direction: 'down' as const,
    text: 'The build stops failing.',
  },
  rollback: 'Clear the repo checks.',
};
const repoChange = (repo: string, cmd: string | null): ProposeChangeInput => ({
  ...META,
  change: {
    kind: 'repo_checks',
    repo,
    checks: cmd === null ? null : { checks: [{ name: 'build', cmd }] },
  },
});
const wfChange = (id: string, base: number, definition: Record<string, unknown>) => ({
  ...META,
  change: { kind: 'workflow', workflow_id: id, base_version: base, definition },
});

async function propose(actor: ProposalActor, input: unknown) {
  const res = await createProposal(db.pool, actor, input);
  if (!res.ok) throw new Error(`${res.code}: ${res.message}`);
  return res.value;
}
const checksOf = async (accountId: string, repo: string) =>
  (
    await db.pool.query<{ config: unknown }>(
      'SELECT config FROM repo_checks WHERE account_id = $1 AND repo = $2',
      [accountId, repo],
    )
  ).rows[0]?.config ?? null;
const statusOf = async (id: string) =>
  (
    await db.pool.query<{ status: string }>('SELECT status FROM change_proposal WHERE id = $1', [
      id,
    ])
  ).rows[0]!.status;

describe('change proposals (ADR-0033 P3)', () => {
  let a: ProposalActor;
  let b: ProposalActor;
  let member: ProposalActor;

  beforeAll(async () => {
    await storeWorkflow('conductor', 1, def('conductor')).catch(() => undefined);
    const idA = await account('A');
    a = { accountId: idA, by: 'admin@a', mayEditWorkflows: true };
    member = { accountId: idA, by: 'member@a', mayEditWorkflows: false };
    b = { accountId: await account('B'), by: 'b@b', mayEditWorkflows: true };
  });

  it('repo checks: propose shows the diff; apply saves once; review is too early', async () => {
    const repo = 'github.com/acme/one';
    const p = await propose(a, repoChange('GitHub.com/Acme/One', 'cd m-one && npm run build'));
    expect(p).toMatchObject({
      kind: 'repo_checks',
      status: 'proposed',
      target: repo,
      requires_admin: false,
      warning: null,
      changes: 2,
    });
    expect(p.diff.changes.map((c) => [c.op, c.path])).toEqual([
      ['add', 'checks.build'],
      ['add', 'override'],
    ]);
    expect(await checksOf(a.accountId, repo)).toBeNull();

    // A member may apply a repo change (it is the account's own); twice at once applies once.
    const [x, y] = await Promise.all([
      applyProposal(db.pool, member, p.id),
      applyProposal(db.pool, member, p.id),
    ]);
    const results = [x, y].map((r) => (r.ok ? 'ok' : r.code)).sort();
    expect(results).toEqual(['already_applied', 'ok']);
    expect(await checksOf(a.accountId, repo)).toEqual({
      checks: [{ name: 'build', cmd: 'cd m-one && npm run build' }],
    });
    const applied = await getProposal(db.pool, a.accountId, p.id);
    expect(applied).toMatchObject({ status: 'applied', decided_by: 'member@a' });
    expect(applied!.applied_at).not.toBeNull();

    const review = await reviewProposal(db.pool, a.accountId, p.id);
    expect(review.ok && review.value.review).toMatchObject({ too_early: true, delta: null });
  });

  it('repo checks: a change made since the proposal is a conflict; null clears', async () => {
    const repo = 'github.com/acme/two';
    const p = await propose(a, repoChange(repo, 'make'));
    await setRepoChecks(db.pool, a.accountId, { repo, checks: [{ name: 'x', cmd: 'x' }] }, 'me');
    const res = await applyProposal(db.pool, a, p.id);
    expect(res.ok ? 'ok' : res.code).toBe('conflict');
    expect(await statusOf(p.id)).toBe('conflict');
    expect(await checksOf(a.accountId, repo)).toEqual({ checks: [{ name: 'x', cmd: 'x' }] });

    const clear = await propose(a, repoChange(repo, null));
    expect((await applyProposal(db.pool, a, clear.id)).ok).toBe(true);
    expect(await checksOf(a.accountId, repo)).toBeNull();
  });

  it('refuses an empty change, an invalid one, and more than the open cap', async () => {
    const acc: ProposalActor = { ...a, accountId: await account('cap') };
    const repo = 'github.com/acme/cap';
    await setRepoChecks(
      db.pool,
      acc.accountId,
      { repo, checks: [{ name: 'build', cmd: 'b' }] },
      'me',
    );
    const same = await createProposal(db.pool, acc, repoChange(repo, 'b'));
    expect(same.ok ? 'ok' : same.code).toBe('no_change');
    const bad = await createProposal(db.pool, acc, {
      ...META,
      change: { kind: 'machine_settings' },
    });
    expect(bad.ok ? 'ok' : bad.code).toBe('invalid_input');

    for (let i = 0; i < OPEN_PROPOSALS_MAX; i++) await propose(acc, repoChange(repo, `c${i}`));
    const over = await createProposal(db.pool, acc, repoChange(repo, 'one more'));
    expect(over.ok ? 'ok' : over.code).toBe('too_many_open');
    const page = await listProposals(db.pool, acc.accountId, { status: 'proposed' });
    expect([page.proposals.length, page.total, page.next_cursor]).toEqual([10, 20, 10]);
    const last = await listProposals(db.pool, acc.accountId, { cursor: 10 });
    expect([last.proposals.length, last.next_cursor]).toEqual([10, null]);
  });

  it('another account sees, applies and rejects none of them', async () => {
    const p = await propose(a, repoChange('github.com/acme/three', 'make'));
    expect(await getProposal(db.pool, b.accountId, p.id)).toBeNull();
    expect((await listProposals(db.pool, b.accountId)).total).toBe(0);
    for (const res of [
      await applyProposal(db.pool, b, p.id),
      await rejectProposal(db.pool, b, p.id),
      await reviewProposal(db.pool, b.accountId, p.id),
      await applyProposal(db.pool, b, 'not-a-uuid'),
    ]) {
      expect(res.ok ? 'ok' : res.code).toBe('not_found');
    }
    expect(await statusOf(p.id)).toBe('proposed');
  });

  it('reject moves proposed to rejected, once; a rejected one is not applied', async () => {
    const p = await propose(a, repoChange('github.com/acme/four', 'make'));
    const r = await rejectProposal(db.pool, a, p.id);
    expect(r.ok && r.value).toMatchObject({ status: 'rejected', decided_by: 'admin@a' });
    const again = await rejectProposal(db.pool, a, p.id);
    expect(again.ok ? 'ok' : again.code).toBe('wrong_state');
    const apply = await applyProposal(db.pool, a, p.id);
    expect(apply.ok ? 'ok' : apply.code).toBe('wrong_state');
  });

  it('workflow: propose checks base and approvals; apply needs an admin and the same base', async () => {
    await storeWorkflow('wf_p', 1, def('wf_p'));
    const invalid = await createProposal(db.pool, a, wfChange('wf_p', 1, { id: 'wf_p' }));
    expect(invalid.ok ? 'ok' : invalid.code).toBe('invalid_workflow');
    const stale = await createProposal(db.pool, a, wfChange('wf_p', 7, def('wf_p', retitle('X'))));
    expect(stale.ok ? 'ok' : !stale.ok && [stale.code, stale.latest]).toEqual(['conflict', 1]);
    const wrongId = await createProposal(db.pool, a, wfChange('wf_p', 1, def('other')));
    expect(wrongId.ok ? 'ok' : wrongId.code).toBe('invalid_input');

    const p = await propose(member, wfChange('wf_p', 1, def('wf_p', retitle('Plan it'))));
    expect(p).toMatchObject({ requires_admin: true, base_version: 1 });
    expect(p.warning).toMatch(/every account/);
    expect(p.diff.changes).toEqual([
      {
        op: 'change',
        path: `states.${FIRST_STATE}.title`,
        before: CONDUCTOR_V4_DEF.states[FIRST_STATE]!.title,
        after: 'Plan it',
      },
    ]);
    const second = await propose(a, wfChange('wf_p', 1, def('wf_p', retitle('Other'))));

    const forbidden = await applyProposal(db.pool, member, p.id);
    expect(forbidden.ok ? 'ok' : forbidden.code).toBe('forbidden');
    expect(await statusOf(p.id)).toBe('proposed');

    const done = await applyProposal(db.pool, a, p.id);
    expect(done.ok && done.value).toMatchObject({ status: 'applied', applied_version: 2 });
    const v = await db.pool.query<{ created_by: string; definition: Def }>(
      "SELECT created_by, definition FROM workflow_definition WHERE id = 'wf_p' AND version = 2",
    );
    expect(v.rows[0]!.created_by).toBe('admin@a');
    expect(v.rows[0]!.definition.states[FIRST_STATE]!.title).toBe('Plan it');

    // The other proposal was made from version 1: applying it now is a conflict, never a save.
    const late = await applyProposal(db.pool, a, second.id);
    expect(late.ok ? 'ok' : !late.ok && [late.code, late.latest]).toEqual(['conflict', 2]);
    expect(await statusOf(second.id)).toBe('conflict');
    const versions = await db.pool.query("SELECT 1 FROM workflow_definition WHERE id = 'wf_p'");
    expect(versions.rowCount).toBe(2);
  });

  it('workflow: weakening an approval is refused when proposing and when applying', async () => {
    await storeWorkflow('wf_g', 1, def('wf_g', gate));
    const weak = await createProposal(db.pool, a, wfChange('wf_g', 1, def('wf_g', retitle('Y'))));
    expect(weak.ok ? 'ok' : !weak.ok && [weak.code, weak.transitions]).toEqual([
      'approval_weakened',
      [`needs_input.${HUMAN_T}`],
    ]);

    // Proposed from an ungated v1; a human gates it on the board (v2) before it is applied.
    await storeWorkflow('wf_h', 1, def('wf_h'));
    const p = await propose(a, wfChange('wf_h', 1, def('wf_h', retitle('Z'))));
    await storeWorkflow('wf_h', 2, def('wf_h', gate));
    const res = await applyProposal(db.pool, a, p.id);
    expect(res.ok ? 'ok' : res.code).toBe('approval_weakened');
    expect(await statusOf(p.id)).toBe('conflict');
  });

  it('review compares the expected metric before and after the change', async () => {
    const repo = 'github.com/acme/review';
    const machineId = randomUUID();
    await db.pool.query(
      'INSERT INTO machine (id, account_id, name, hostname, os, arch, cpu_total, mem_total_mb, ' +
        'disk_free_mb, budget_cpu, budget_mem_mb, max_sessions, max_concurrent_builds) ' +
        "VALUES ($1, $2, 'L', 'h', 'linux', 'x64', 8, 16000, 100000, 4, 8000, 2, 1)",
      [machineId, a.accountId],
    );
    const day = 86_400_000;
    const now = new Date();
    const appliedAt = new Date(now.getTime() - 5 * day);
    /** A ticket whose build check ran `ago` ms back with `exit`. */
    const run = async (agoMs: number, exit: number) => {
      const t = await db.pool.query<{ id: string }>(
        'INSERT INTO ticket (account_id, repo, title, body, workflow_id, status, kind) ' +
          "VALUES ($1, $2, 'T', 'B', 'conductor', 'done', 'work') RETURNING id",
        [a.accountId, repo],
      );
      const s = await db.pool.query<{ id: string }>(
        'INSERT INTO session (account_id, ticket_id, machine_id, workflow_id, workflow_version, ' +
          "status, workflow_state) VALUES ($1, $2, $3, 'conductor', 1, 'done', 'done') RETURNING id",
        [a.accountId, t.rows[0]!.id, machineId],
      );
      const commandId = randomUUID();
      const ts = new Date(now.getTime() - agoMs);
      await db.pool.query(
        "INSERT INTO outbox (command_id, target, kind, session_id, payload, created_at) VALUES ($1, $2, 'run_cmd', $3, $4, $5)",
        [
          commandId,
          `machine:${machineId}`,
          s.rows[0]!.id,
          JSON.stringify({ state: 'implementing', cmd: 'npm run build' }),
          ts,
        ],
      );
      await db.pool.query(
        "INSERT INTO event (session_id, type, payload, ts) VALUES ($1, 'command.exited', $2, $3)",
        [s.rows[0]!.id, JSON.stringify({ command_id: commandId, exit_code: exit }), ts],
      );
    };
    // Before (6..9 days back): all three fail. After (1..4 days back): one of three fails.
    // 12 days back is outside the 5-day before-window.
    for (const d of [6, 7, 9]) await run(d * day, 1);
    await run(12 * day, 0);
    for (const [d, exit] of [
      [1, 0],
      [2, 0],
      [4, 1],
    ] as const)
      await run(d * day, exit);

    const p = await propose(a, repoChange(repo, 'cd m-one && npm run build'));
    await applyProposal(db.pool, a, p.id);
    await db.pool.query('UPDATE change_proposal SET applied_at = $2 WHERE id = $1', [
      p.id,
      appliedAt,
    ]);
    const res = await reviewProposal(db.pool, a.accountId, p.id, now);
    expect(res.ok && res.value.review).toMatchObject({
      metric: 'check_failure_rate',
      window_days: 5,
      before: { value: 1, sample: 3 },
      after: { value: 0.33, sample: 3 },
      delta: -0.67,
      direction_met: true,
      too_early: false,
    });
    const notApplied = await propose(a, repoChange(repo, 'other'));
    const wrong = await reviewProposal(db.pool, a.accountId, notApplied.id, now);
    expect(wrong.ok ? 'ok' : wrong.code).toBe('wrong_state');
  });
});
