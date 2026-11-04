// 06 §Proposed tickets: an agent's optional `proposed_tickets` (in `session.context`) read back on
// GET ticket / session and the board card, approved (a real ticket, once) or dismissed. Needs the
// shared server (`pnpm db:up`): approve and dismiss lock rows and write board events.
import type { AddressInfo } from 'node:net';
import {
  API_PATHS,
  ApproveProposalResponseSchema,
  BoardResponseSchema,
  proposalId,
  SessionDetailSchema,
  TicketDetailSchema,
  TicketDtoSchema,
  TicketProposalSchema,
  type WorkflowDefinitionInput,
} from '@conductor/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/api/index.js';
import { FakeEngineService, InMemoryBoardBus, InMemoryOutputBus } from '../src/contracts.js';
import type { ApiHandle } from '../src/main.js';
import { useTestDatabase } from './db.js';

const db = useTestDatabase();
let api: ApiHandle;
let base: string;

const wf: WorkflowDefinitionInput = {
  id: 'proposals_wf',
  version: 1,
  start: 'planning',
  budget: { usd: 1, minutes: 10, max_loop_retries: 1 },
  states: {
    planning: {
      type: 'agent',
      prompt: 'plan_template',
      on: { done: 'implementing', ask_user: 'needs_input' },
    },
    implementing: {
      type: 'agent',
      prompt: 'implement_template',
      on: { done: 'done', ask_user: 'needs_input' },
    },
    needs_input: { type: 'human', on: { 'input.provided': 'implementing' } },
    done: { type: 'terminal' },
  },
};

const GOOD = { title: 'Speed up CI', repo: 'acme/app', why: 'Builds take 20 minutes.' };
const OTHER = { title: 'Fix docs', repo: 'acme/docs', why: 'They are out of date.' };
const CONTEXT = {
  planning: { plan: 'p', summary: 's', proposed_tickets: [GOOD, { title: 42 }, 'junk'] },
  implementing: { summary: 'done', proposed_tickets: [OTHER] },
  // Not an agent state's result: never read.
  __qa: { proposed_tickets: [{ title: 'hidden', repo: 'a/b', why: 'w' }] },
};
const GOOD_ID = proposalId('planning', GOOD.title, GOOD.repo);
const OTHER_ID = proposalId('implementing', OTHER.title, OTHER.repo);

async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  api = createApi({
    db: db.pool,
    engine: new FakeEngineService(),
    boardBus: new InMemoryBoardBus(),
    outputBus: new InMemoryOutputBus(),
  });
  await api.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const res = await send('POST', API_PATHS.workflows, { definition: wf });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
});

afterAll(async () => {
  await api.close();
});

/** A parent ticket with a session parked in `state` whose context is `context`. */
async function parent(context: unknown = CONTEXT, state = 'needs_input', kind = 'personal') {
  const res = await send('POST', API_PATHS.tickets, {
    title: 'Parent',
    body: 'b',
    repo: 'acme/app',
    workflow_id: 'proposals_wf',
    kind,
  });
  expect(res.status).toBe(201);
  const ticket = TicketDtoSchema.parse(res.body);
  const status = state === 'needs_input' ? 'needs_input' : 'running';
  const s = await db.pool.query<{ id: string }>(
    'INSERT INTO session (ticket_id, workflow_id, workflow_version, workflow_state, status, context) ' +
      "VALUES ($1, 'proposals_wf', 1, $2, $3, $4) RETURNING id",
    [ticket.id, state, status, JSON.stringify(context)],
  );
  return { ticket, sessionId: s.rows[0]!.id };
}

async function detail(id: string) {
  const res = await send('GET', API_PATHS.ticket(id));
  expect(res.status).toBe(200);
  return TicketDetailSchema.parse(res.body);
}

async function card(ticketId: string) {
  const res = await send('GET', API_PATHS.board);
  const board = BoardResponseSchema.parse(res.body);
  return board.columns.flatMap((c) => c.cards).find((c) => c.ticket_id === ticketId)!;
}

const approve = (id: string, body: Record<string, unknown>) =>
  send('POST', API_PATHS.ticketProposalApprove(id), body);
const dismiss = (id: string, proposal_id: string) =>
  send('POST', API_PATHS.ticketProposalDismiss(id), { proposal_id });

/** Follow-ups of `parentId` titled `title` (the default body links the parent). */
async function followUps(parentId: string, title: string) {
  const r = await db.pool.query(
    "SELECT id FROM ticket WHERE title = $1 AND body LIKE '%' || $2 || '%'",
    [title, `/#/?ticket=${parentId}`],
  );
  return r.rowCount;
}

describe('reading proposals', () => {
  it('GET ticket and session: only the well-formed ones, pending, with their state', async () => {
    const { ticket, sessionId } = await parent();
    const d = await detail(ticket.id);
    expect(d.proposals).toEqual([
      { id: GOOD_ID, state: 'planning', ...GOOD, status: 'pending', created_ticket_id: null },
      { id: OTHER_ID, state: 'implementing', ...OTHER, status: 'pending', created_ticket_id: null },
    ]);
    const s = SessionDetailSchema.parse((await send('GET', API_PATHS.session(sessionId))).body);
    expect(s.proposals).toEqual(d.proposals);
  });

  it('no proposed_tickets: none, and no badge', async () => {
    const { ticket } = await parent({ planning: { plan: 'p', summary: 's' } });
    expect((await detail(ticket.id)).proposals).toEqual([]);
    expect((await card(ticket.id)).proposals_pending).toBeUndefined();
  });

  it('the board badge counts pending proposals on a Needs input card only', async () => {
    const parked = await parent();
    expect((await card(parked.ticket.id)).proposals_pending).toBe(2);
    const working = await parent(CONTEXT, 'implementing');
    expect((await card(working.ticket.id)).proposals_pending).toBeUndefined();
  });
});

describe('approve', () => {
  it('creates one ticket, however often it is approved', async () => {
    const { ticket, sessionId } = await parent();
    const before = await db.pool.query('SELECT workflow_state, status FROM session WHERE id = $1', [
      sessionId,
    ]);

    const first = await approve(ticket.id, { proposal_id: GOOD_ID });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const created = ApproveProposalResponseSchema.parse(first.body);
    expect(created.proposal).toMatchObject({ id: GOOD_ID, status: 'approved' });
    expect(created.proposal.created_ticket_id).toBe(created.ticket.id);
    expect(created.ticket).toMatchObject({
      title: GOOD.title,
      repo: GOOD.repo,
      workflow_id: 'proposals_wf',
      kind: 'personal',
    });
    expect(created.ticket.body).toContain(GOOD.why);
    expect(created.ticket.body).toContain(`/#/?ticket=${ticket.id}`);

    const again = await approve(ticket.id, { proposal_id: GOOD_ID, title: 'Edited later' });
    expect(again.status).toBe(200);
    expect(ApproveProposalResponseSchema.parse(again.body).ticket.id).toBe(created.ticket.id);
    expect(await followUps(ticket.id, GOOD.title)).toBe(1);
    expect(await followUps(ticket.id, 'Edited later')).toBe(0);

    // Concurrent approvals of the other proposal still create one ticket.
    const both = await Promise.all([
      approve(ticket.id, { proposal_id: OTHER_ID }),
      approve(ticket.id, { proposal_id: OTHER_ID }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(await followUps(ticket.id, OTHER.title)).toBe(1);

    const d = await detail(ticket.id);
    expect(d.proposals!.map((p) => p.status)).toEqual(['approved', 'approved']);
    expect((await card(ticket.id)).proposals_pending).toBeUndefined();
    // The parent doesn't move.
    const after = await db.pool.query('SELECT workflow_state, status FROM session WHERE id = $1', [
      sessionId,
    ]);
    expect(after.rows).toEqual(before.rows);
  });

  it('uses the edited title and body', async () => {
    const { ticket } = await parent();
    const res = await approve(ticket.id, {
      proposal_id: GOOD_ID,
      title: 'Edited title',
      body: 'Edited body',
    });
    expect(res.status).toBe(201);
    expect(ApproveProposalResponseSchema.parse(res.body).ticket).toMatchObject({
      title: 'Edited title',
      body: 'Edited body',
    });
  });

  it('404 for an unknown proposal or ticket, 400 for a malformed id', async () => {
    const { ticket } = await parent();
    expect((await approve(ticket.id, { proposal_id: '0123456789abcdef' })).status).toBe(404);
    expect((await approve(crypto.randomUUID(), { proposal_id: GOOD_ID })).status).toBe(404);
    expect((await approve(ticket.id, { proposal_id: 'nope' })).status).toBe(400);
  });
});

describe('dismiss', () => {
  it('hides the proposal, is idempotent, and blocks a later approve', async () => {
    const { ticket, sessionId } = await parent();
    const res = await dismiss(ticket.id, GOOD_ID);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(TicketProposalSchema.parse(res.body)).toMatchObject({ status: 'dismissed' });
    expect((await dismiss(ticket.id, GOOD_ID)).status).toBe(200);

    const d = await detail(ticket.id);
    expect(d.proposals!.filter((p) => p.status === 'pending').map((p) => p.id)).toEqual([OTHER_ID]);
    expect((await card(ticket.id)).proposals_pending).toBe(1);

    expect((await approve(ticket.id, { proposal_id: GOOD_ID })).status).toBe(409);
    expect(await followUps(ticket.id, GOOD.title)).toBe(0);
    const s = await db.pool.query('SELECT workflow_state, status FROM session WHERE id = $1', [
      sessionId,
    ]);
    expect(s.rows[0]).toEqual({ workflow_state: 'needs_input', status: 'needs_input' });
  });

  it('409 after an approve', async () => {
    const { ticket } = await parent();
    expect((await approve(ticket.id, { proposal_id: OTHER_ID })).status).toBe(201);
    expect((await dismiss(ticket.id, OTHER_ID)).status).toBe(409);
  });
});
