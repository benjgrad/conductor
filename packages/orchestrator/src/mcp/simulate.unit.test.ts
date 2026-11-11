import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  apply,
  eventPayload,
  WorkflowDefinitionSchema,
  type EngineEvent,
  type SessionSnapshot,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import type { RequestAuth } from '../auth/middleware.js';
import { buildMcpServer, type ToolDeps } from './tools.js';

// simulate_workflow (R17) over a real MCP client and server joined in memory, with a stub
// database answering the loader's SELECTs from a recorded m1_basic run (no Postgres: the replay
// itself is covered in shared/src/engine/simulate.test.ts).

const m1 = WorkflowDefinitionSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('../../../../docs/design/workflows/m1_basic.v1.json', import.meta.url),
      'utf8',
    ),
  ),
);
const TICKET = '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2';
const SESSION = '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f';
const T0 = Date.parse('2026-11-01T10:00:00.000Z');

/** The `event` rows the EngineService would have written for an m1_basic run to `done`. */
function recordedRun(): {
  id: string;
  session_id: string;
  type: string;
  payload: unknown;
  ts: Date;
}[] {
  let snap: SessionSnapshot = {
    id: SESSION,
    ticket: {
      id: TICKET,
      title: 'Add /health',
      body: '',
      repo: 'github.com/acme/app',
      external_ref: null,
    },
    machine_id: null,
    workflow_id: m1.id,
    workflow_version: m1.version,
    workflow_state: null,
    status: 'queued',
    fencing_token: 1,
    claude_session_id: null,
    agent_command_id: null,
    agent_process_live: false,
    pending_answer: null,
    retry_counters: {},
    state_visits: {},
    state_entered_at: new Date(T0).toISOString(),
    state_deadline: null,
    return_to: null,
    spend_usd: 0,
    claude_spend_totals: {},
    wall_seconds: 0,
    context: {},
    step: null,
  };
  const rows: { id: string; session_id: string; type: string; payload: unknown; ts: Date }[] = [];
  let n = 0;
  const run = (event: EngineEvent) => {
    const ts = new Date(T0 + ++n * 60_000);
    const res = apply(m1, snap, event, ts);
    rows.push({
      id: String(rows.length + 1),
      session_id: SESSION,
      type: event.type,
      payload: eventPayload(event, res.ignored),
      ts,
    });
    snap = res.snapshot;
    for (const e of res.effects) {
      if (e.type === 'start_session') {
        snap = { ...snap, agent_command_id: `11111111-1111-4111-8111-00000000000${n % 10}` };
      }
      if (e.type === 'state_entered') {
        rows.push({
          id: String(rows.length + 1),
          session_id: SESSION,
          type: 'state.entered',
          payload: {
            from: e.from,
            to: e.to,
            visit: e.visit,
            transition: e.transition ?? null,
            cause: e.cause,
          },
          ts,
        });
      }
    }
  };
  const exit = (code: number) =>
    run({
      type: 'command.exited',
      command_id: '22222222-2222-4222-8222-000000000001',
      exit_code: code,
      timed_out: false,
      output_tail: 'ok',
    });
  run({ type: 'session.assigned', machine_id: 'mbp' });
  run({
    type: 'session.started',
    command_id: snap.agent_command_id!,
    worktree_path: '/tmp/wt',
    branch: 'b',
    port_range: { base: 41000, count: 10 },
  });
  run({ type: 'agent.complete_state', result: {} });
  exit(0);
  exit(0);
  expect(snap.status).toBe('done');
  return rows;
}

async function connect() {
  const events = recordedRun();
  const queries: string[] = [];
  const db = {
    query: (sql: string, args: unknown[] = []) => {
      queries.push(sql);
      let rows: unknown[] = [];
      if (sql.startsWith('SELECT id, title FROM ticket')) {
        rows = args[1] === TICKET ? [{ id: TICKET, title: 'Add /health' }] : [];
      } else if (sql.startsWith('SELECT * FROM ticket')) {
        rows = [
          {
            id: TICKET,
            account_id: 'acc-1',
            repo: 'github.com/acme/app',
            title: 'Add /health',
            body: '',
            external_ref: null,
            kind: 'work',
            workflow_id: m1.id,
            workflow_version: 1,
          },
        ];
      } else if (sql.includes('FROM session')) {
        rows = [
          { id: SESSION, branch: 'b', status: 'done', workflow_id: m1.id, workflow_version: 1 },
        ];
      } else if (sql.includes('FROM event')) {
        rows = events;
      }
      return Promise.resolve({ rows });
    },
  };
  const who = {
    user: { id: 'u1', email: 'ben@example.com', is_admin: false },
    account: { id: 'acc-1', name: 'Ben' },
    scope: { account_id: 'acc-1' },
    mode: 'password',
    sessionIdHash: null,
  } as unknown as RequestAuth;
  const server = buildMcpServer({ db } as unknown as ToolDeps, who);
  const client = new Client({ name: 'unit', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: 'simulate_workflow', arguments: args });
    return {
      isError: res.isError === true,
      body: JSON.parse((res.content as { text: string }[])[0]!.text) as Record<string, unknown>,
    };
  };
  return { client, call, queries };
}

describe('simulate_workflow (R17)', () => {
  it('is read-only, and a non-admin may call it', async () => {
    const { client } = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'simulate_workflow');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it('the definition the ticket ran on replays without a divergence', async () => {
    const { call, queries } = await connect();
    const { isError, body } = await call({ definition: m1, ticket_ids: [TICKET] });
    expect(isError).toBe(false);
    expect(body).toMatchObject({
      workflow_id: 'm1_basic',
      summary: { replayed: 1, diverged: 0, unreplayable: 0, unresolved: 0 },
      tickets: [
        {
          ticket_id: TICKET,
          short_id: TICKET.slice(0, 8),
          diverged: false,
          replayable: true,
          recorded_states: ['implement', 'build', 'test', 'done'],
          simulated_states: ['implement', 'build', 'test', 'done'],
        },
      ],
    });
    // Only reads.
    expect(queries.every((q) => q.trimStart().startsWith('SELECT'))).toBe(true);
  });

  it('a draft that runs the tests before the build diverges at the agent’s done', async () => {
    const draft = structuredClone(m1) as unknown as {
      states: Record<string, { on: Record<string, unknown> }>;
    };
    draft.states.implement!.on.done = 'test';
    draft.states.test!.on.exit_0 = 'build';
    draft.states.build!.on.exit_0 = 'done';
    const { body } = await (await connect()).call({ definition: draft, ticket_ids: [TICKET] });
    expect(body).toMatchObject({
      summary: { diverged: 1 },
      tickets: [
        {
          first_divergence: {
            event_type: 'agent.complete_state',
            move_index: 1,
            recorded: { from: 'implement', to: 'build' },
            simulated: { from: 'implement', to: 'test' },
          },
          simulated_states: ['implement'],
        },
      ],
    });
  });

  it('reports an unknown ticket per ticket, and refuses bad input', async () => {
    const { call } = await connect();
    const unknown = await call({
      definition: m1,
      ticket_ids: ['ffffffff-ffff-4fff-8fff-ffffffffffff'],
    });
    expect(unknown.body).toMatchObject({
      summary: { replayed: 0, unresolved: 1 },
      tickets: [{ ticket: 'ffffffff-ffff-4fff-8fff-ffffffffffff', error: { code: 'not_found' } }],
    });
    const many = await call({ definition: m1, ticket_ids: Array(11).fill(TICKET) as string[] });
    expect(many).toMatchObject({ isError: true, body: { error: { code: 'invalid_input' } } });
    const none = await call({ definition: m1, ticket_ids: [] });
    expect(none.isError).toBe(true);
    const bad = await call({ definition: { id: 'x' }, ticket_ids: [TICKET] });
    expect(bad).toMatchObject({ isError: true, body: { error: { code: 'invalid_workflow' } } });
  });
});
