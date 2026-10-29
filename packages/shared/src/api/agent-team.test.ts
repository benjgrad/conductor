import { describe, expect, it } from 'vitest';
import { boardColumns, CONDUCTOR_V1_DEF } from '../workflow/conductor.js';
import { BOARD_CARD_FIXTURE } from './fixtures.js';
import {
  API_PATHS,
  BoardCardSchema,
  SessionDetailSchema,
  TeamResponseSchema,
  TicketDtoSchema,
  toBoardCard,
  type CardView,
  type TeamResponse,
} from './rest.js';

// UX-13a: `agent_name` is additive and optional; payloads from older servers still parse.

const roundTrip = <T>(schema: { parse: (v: unknown) => T }, v: unknown) =>
  schema.parse(JSON.parse(JSON.stringify(v)));

const DETAIL = {
  card: BOARD_CARD_FIXTURE,
  workflow: CONDUCTOR_V1_DEF,
  workflow_version: 1,
  context: {},
  retry_counters: {},
  state_visits: {},
  return_to: null,
  state_entered_at: '2026-10-27T10:00:00.000Z',
  state_deadline: null,
  spend_usd: 0,
  wall_seconds: 0,
  budget: { usd: 2, minutes: 60 },
  branch: null,
  worktree_path: null,
  pending_input: null,
  recent_output: [],
};

const TICKET = {
  id: '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2',
  external_ref: null,
  repo: 'github.com/org/app',
  title: 't',
  body: '',
  workflow_id: 'conductor',
  workflow_version: null,
  required_tags: [],
  repo_allow_machines: null,
  status: 'ready',
  priority: 0,
  created_at: '2026-10-22T12:00:00.000Z',
};

describe('agent_name (UX-13a)', () => {
  /** Just what this test uses of a zod schema. */
  interface AnySchema {
    parse: (v: unknown) => unknown;
    safeParse: (v: unknown) => { success: boolean };
  }
  const agentName = (schema: AnySchema, v: unknown) =>
    (roundTrip(schema, v) as { agent_name?: unknown }).agent_name;
  const cases: [string, AnySchema, object][] = [
    ['BoardCard', BoardCardSchema, BOARD_CARD_FIXTURE],
    ['SessionDetail', SessionDetailSchema, DETAIL],
    ['TicketDto', TicketDtoSchema, TICKET],
  ];

  it.each(cases)(
    '%s: absent (old payloads), null and a name parse; a number does not',
    (_n, schema, old) => {
      expect(agentName(schema, old)).toBeUndefined();
      expect(agentName(schema, { ...old, agent_name: null })).toBeNull();
      expect(agentName(schema, { ...old, agent_name: 'Ada' })).toBe('Ada');
      expect(schema.safeParse({ ...old, agent_name: 7 }).success).toBe(false);
    },
  );

  it('toBoardCard carries the ticket’s agent_name, and omits it when the row has none', () => {
    const view: CardView = { columns: boardColumns(CONDUCTOR_V1_DEF), def: CONDUCTOR_V1_DEF };
    const ticket = {
      id: BOARD_CARD_FIXTURE.ticket_id,
      status: 'ready' as const,
      title: 'Add /health',
      external_ref: null,
      repo: 'github.com/benjgrad/fixture-app',
      priority: 0,
      workflow_id: 'conductor',
      created_at: new Date('2026-10-22T12:00:00.000Z'),
      updated_at: new Date('2026-10-22T12:00:00.000Z'),
    };
    expect(toBoardCard(ticket, null, null, view)).toEqual(BOARD_CARD_FIXTURE);
    expect(toBoardCard({ ...ticket, agent_name: 'Ada' }, null, null, view).agent_name).toBe('Ada');
    expect(toBoardCard({ ...ticket, agent_name: null }, null, null, view)).toEqual({
      ...BOARD_CARD_FIXTURE,
      agent_name: null,
    });
  });
});

describe('GET /api/team (UX-13a)', () => {
  it('has its path', () => {
    expect(API_PATHS.team).toBe('/api/team');
  });

  it('TeamResponse round-trips; nullable fields accept null', () => {
    const team: TeamResponse = [
      {
        name: 'Ada',
        hired_at: '2026-10-28T10:00:00.000Z',
        last_assigned_at: '2026-10-29T10:00:00.000Z',
        active_ticket_id: TICKET.id,
      },
      {
        name: 'Omar',
        hired_at: '2026-10-28T11:00:00.000Z',
        last_assigned_at: null,
        active_ticket_id: null,
      },
    ];
    expect(roundTrip(TeamResponseSchema, team)).toEqual(team);
    expect(TeamResponseSchema.safeParse([{ ...team[0], active_ticket_id: 'x' }]).success).toBe(
      false,
    );
    expect(TeamResponseSchema.safeParse([{ name: 'Ada' }]).success).toBe(false);
  });
});
