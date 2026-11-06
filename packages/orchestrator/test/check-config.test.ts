// Check-setup failures (05 §Requirements to enter a column, "Setup failures"), the orchestrator's
// side: an agent's ask_user `proposed_checks` becomes a change proposal linked to the ticket and
// its question (nothing changes until a human applies it); applying it answers that question; any
// repo-checks change sends `gate.retry` to the sessions waiting on a `check_config` request for
// that repo; the snapshot carries who saved the repo's checks. Needs `pnpm db:up`: the rows are
// what is tested. apply() is scripted (ScriptedApply): the engine's routing has its own tests.
import { randomUUID } from 'node:crypto';
import { LOCAL_ACCOUNT_ID, type SessionSnapshot } from '@conductor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyProposal, listProposals } from '../src/advisor/proposals.js';
import { afterRepoChecksChanged, appliedAnswer } from '../src/api/check-config.js';
import { setRepoChecks } from '../src/api/repo-checks.js';
import { InMemoryBoardBus } from '../src/contracts.js';
import type { ChangeProposalRow } from '../src/db/types.js';
import { createEngineService } from '../src/engine/index.js';
import { useTestDatabase } from './db.js';
import { MACHINE, ScriptedApply, seedSession } from './engine/fixtures.js';

const db = useTestDatabase();
const REPO = 'github.com/x/app';
const now = () => new Date('2026-11-06T15:00:00.000Z');
let script: ScriptedApply;

const make = () =>
  createEngineService({ db: db.pool, boardBus: new InMemoryBoardBus(), now, apply: script.apply })
    .engine;

const PROPOSED = {
  title: 'Drop the origin fetch',
  rationale: 'The fresh checkout has no origin remote, so `git fetch origin` fails.',
  checks: { setup: '', checks: [{ name: 'Build', cmd: 'npm run build' }] },
};

/** The agent asks, with or without proposed checks: an agent_question opens. */
const ask = () =>
  script.on('agent.ask_user', (snap) => ({
    snapshot: { status: 'needs_input', workflow_state: 'needs_input', return_to: 'implement' },
    effects: [
      { type: 'session_status', from: snap.status, to: 'needs_input' },
      {
        type: 'create_input_request',
        kind: 'agent_question',
        question: 'Apply my fix?',
        return_to: 'implement',
      },
    ],
  }));

const proposals = async () =>
  (await db.pool.query<ChangeProposalRow>('SELECT * FROM change_proposal ORDER BY created_at'))
    .rows;

const openRequest = async (sessionId: string) =>
  (
    await db.pool.query<{ id: string; question: string; answer: string | null }>(
      'SELECT id, question, answer FROM input_request WHERE session_id = $1',
      [sessionId],
    )
  ).rows;

beforeEach(async () => {
  script = new ScriptedApply();
  await db.pool.query('DELETE FROM change_proposal');
  await db.pool.query('DELETE FROM repo_checks');
});

const running = () =>
  seedSession(db.pool, {
    status: 'running',
    machine_id: MACHINE,
    workflow_state: 'implement',
    agent_process_live: true,
  });

describe('an agent’s proposed checks', () => {
  it('is stored as a proposal linked to the ticket and its question; nothing changes', async () => {
    ask();
    const { ticketId, sessionId } = await running();
    const res = await make().applyEvent(sessionId, {
      type: 'agent.ask_user',
      question: 'Apply my fix?',
      proposed_checks: PROPOSED,
    });
    expect(res.status).toBe('applied');
    const [req] = await openRequest(sessionId);
    const rows = await proposals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'repo_checks',
      status: 'proposed',
      ticket_id: ticketId,
      input_request_id: req!.id,
      created_by: `agent:${ticketId.slice(0, 8)}`,
      title: PROPOSED.title,
    });
    expect(rows[0]!.payload).toMatchObject({ repo: REPO, checks: PROPOSED.checks });
    const checks = await db.pool.query('SELECT * FROM repo_checks');
    expect(checks.rows).toEqual([]);
    const listed = await listProposals(db.pool, LOCAL_ACCOUNT_ID, { ticket_id: ticketId });
    expect(listed.proposals.map((p) => p.ticket_id)).toEqual([ticketId]);
  });

  it('a refused proposal is noted on the question instead', async () => {
    ask();
    const { sessionId } = await running();
    // No override and `checks: null` (clear it): nothing would change.
    await make().applyEvent(sessionId, {
      type: 'agent.ask_user',
      question: 'Apply my fix?',
      proposed_checks: { ...PROPOSED, checks: null },
    });
    expect(await proposals()).toEqual([]);
    const [req] = await openRequest(sessionId);
    expect(req!.question).toContain('(Conductor could not store the proposed checks:');
  });

  it('applying it sets the checks and answers the agent’s question', async () => {
    ask();
    const answered: string[] = [];
    script.on('input.provided', (_snap, event) => {
      if (event.type === 'input.provided') answered.push(event.answer);
      return { snapshot: { status: 'running', workflow_state: 'implement' } };
    });
    const { sessionId } = await running();
    const engine = make();
    await engine.applyEvent(sessionId, {
      type: 'agent.ask_user',
      question: 'Apply my fix?',
      proposed_checks: PROPOSED,
    });
    const [row] = await proposals();
    const actor = { accountId: LOCAL_ACCOUNT_ID, by: 'ben@example.com', mayEditWorkflows: false };
    const res = await applyProposal(db.pool, actor, row!.id);
    expect(res.ok).toBe(true);
    const out = await afterRepoChecksChanged({ db: db.pool, engine }, LOCAL_ACCOUNT_ID, REPO, {
      proposalId: row!.id,
      by: actor.by,
    });
    expect(out.answered).toBe(1);
    expect(answered).toEqual([appliedAnswer(PROPOSED.title, actor.by)]);
    const [req] = await openRequest(sessionId);
    expect(req!.answer).toBe(appliedAnswer(PROPOSED.title, actor.by));
    const checks = await db.pool.query<{ config: unknown }>('SELECT config FROM repo_checks');
    expect(checks.rows[0]!.config).toEqual(PROPOSED.checks);
  });
});

describe('a repo-checks change retries the gates waiting on it', () => {
  const waiting = async (repo = REPO) => {
    const s = await seedSession(db.pool, {
      status: 'needs_input',
      machine_id: MACHINE,
      workflow_state: 'needs_input',
    });
    await db.pool.query('UPDATE ticket SET repo = $2 WHERE id = $1', [s.ticketId, repo]);
    await db.pool.query(
      "INSERT INTO input_request (id, session_id, kind, question, return_to) VALUES ($1, $2, 'check_config', 'Setup failed …', 'implement')",
      [randomUUID(), s.sessionId],
    );
    return s;
  };

  it('sends gate.retry to the sessions of that repo only, with the new checks on the snapshot', async () => {
    const seen: SessionSnapshot[] = [];
    script.on('gate.retry', (snap) => {
      seen.push(snap);
      return { snapshot: { status: 'running', workflow_state: 'implement' } };
    });
    const mine = await waiting();
    await waiting('github.com/x/other');
    const res = await setRepoChecks(
      db.pool,
      LOCAL_ACCOUNT_ID,
      { repo: REPO, setup: '', checks: [{ name: 'Build', cmd: 'npm run build' }] },
      'ben@example.com',
    );
    expect(res.ok).toBe(true);
    const out = await afterRepoChecksChanged(
      { db: db.pool, engine: make() },
      LOCAL_ACCOUNT_ID,
      REPO,
    );
    expect(out).toEqual({ answered: 0, retried: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe(mine.sessionId);
    expect(seen[0]!.repo_checks).toEqual({
      setup: '',
      checks: [{ name: 'Build', cmd: 'npm run build' }],
    });
    expect(seen[0]!.repo_checks_meta).toMatchObject({ updated_by: 'ben@example.com' });
    // The wrapper answers the check_config request.
    const [req] = await openRequest(mine.sessionId);
    expect(req!.answer).toBe('[$retry_checks]');
  });
});
