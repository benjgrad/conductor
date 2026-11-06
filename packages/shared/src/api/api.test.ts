import { describe, expect, it } from 'vitest';
import { SessionStatusSchema } from '../domain.js';
import { BOARD_CARD_FIXTURE, BOARD_SSE_FIXTURES, OUTPUT_CHUNK_FIXTURE } from './fixtures.js';
import { CONDUCTOR_V1_DEF, boardColumns } from '../workflow/conductor.js';
import {
  BoardCardSchema,
  CreateTicketRequestSchema,
  UpdateTicketRequestSchema,
} from './rest.js';
import { CreateScheduleRequestSchema } from './schedules.js';
import {
  BOARD_SSE_EVENT_TYPES,
  boardSseEventFromRow,
  boardSseEventToRow,
  BoardSseEventSchema,
  encodeSseFrame,
  OutputChunkSchema,
  type BoardSseEvent,
} from './sse.js';

describe('SSE fixtures', () => {
  it('has one fixture per board event type', () => {
    expect(Object.keys(BOARD_SSE_FIXTURES).sort()).toEqual([...BOARD_SSE_EVENT_TYPES].sort());
  });

  it.each(Object.entries(BOARD_SSE_FIXTURES))('%s round-trips', (_t, fixture) => {
    expect(BoardSseEventSchema.parse(JSON.parse(JSON.stringify(fixture)))).toEqual(fixture);
  });

  it('output chunk round-trips', () => {
    const json = JSON.stringify(OUTPUT_CHUNK_FIXTURE);
    expect(OutputChunkSchema.parse(JSON.parse(json))).toEqual(OUTPUT_CHUNK_FIXTURE);
  });

  it('encodes SSE frames with id/event/data', () => {
    expect(encodeSseFrame('card.moved', { a: 1 }, 7)).toBe(
      'id: 7\nevent: card.moved\ndata: {"a":1}\n\n',
    );
    expect(encodeSseFrame('output', { a: 1 })).toBe('event: output\ndata: {"a":1}\n\n');
  });
});

describe('board event ⇄ event row (one row per SSE event)', () => {
  it.each(Object.entries(BOARD_SSE_FIXTURES))('%s survives toRow → INSERT → fromRow', (_t, fx) => {
    const { id, ts, ...draft }: BoardSseEvent = fx;
    const row = boardSseEventToRow(draft);
    expect(row.type).toBe(fx.type);
    expect(row.session_id).toBe(fx.session_id);
    expect(row.payload).not.toHaveProperty('id');
    expect(row.payload).not.toHaveProperty('ts');
    expect(row.payload).not.toHaveProperty('session_id');
    expect(row.payload).not.toHaveProperty('type');
    // As node-postgres returns it: bigserial → string, timestamptz → Date, jsonb → object.
    const pgRow = {
      ...row,
      id: String(id),
      ts: new Date(ts),
      payload: JSON.parse(JSON.stringify(row.payload)) as unknown,
    };
    expect(boardSseEventFromRow(pgRow)).toEqual(fx);
  });

  it('returns null for non-board rows', () => {
    expect(
      boardSseEventFromRow({
        id: '1',
        session_id: null,
        type: 'state.entered',
        payload: {},
        ts: new Date(),
      }),
    ).toBeNull();
  });

  it('throws on a malformed board row', () => {
    expect(() =>
      boardSseEventFromRow({
        id: '1',
        session_id: null,
        type: 'card.badge',
        payload: {},
        ts: new Date(),
      }),
    ).toThrow();
  });

  it('allows a sessionless card.upserted but not a sessionless card.moved', () => {
    expect(BOARD_SSE_FIXTURES['card.upserted'].session_id).toBeNull();
    expect(
      BoardSseEventSchema.safeParse({ ...BOARD_SSE_FIXTURES['card.moved'], session_id: null })
        .success,
    ).toBe(false);
    expect(
      BoardSseEventSchema.safeParse({ ...BOARD_SSE_FIXTURES['card.moved'], from: null }).success,
    ).toBe(false);
  });
});

describe('board columns (ADR-0010)', () => {
  it('Queued first, then conductor v1 columns in order; null falls back to v1', () => {
    const cols = boardColumns(null);
    expect(cols.map((c) => [c.id, c.title, c.kind])).toEqual([
      ['queued', 'Queued', 'queued'],
      ['planning', 'Planning', 'agent'],
      ['implementing', 'Implementing', 'agent'],
      ['needs_input', 'Needs input', 'human'],
      ['waiting_external', 'Waiting external', 'event'],
      ['done', 'Done', 'terminal'],
    ]);
    expect(boardColumns(CONDUCTOR_V1_DEF)).toEqual(cols);
  });

  it('waiting_for_build_slot is not a status', () => {
    expect(SessionStatusSchema.safeParse('waiting_for_build_slot').success).toBe(false);
  });
});

describe('REST DTO defaults', () => {
  it('fills CreateTicketRequest defaults', () => {
    expect(
      CreateTicketRequestSchema.parse({
        title: 't',
        body: '',
        repo: 'r',
        workflow_id: 'm1_basic',
        kind: 'work',
      }),
    ).toEqual({
      kind: 'work',
      title: 't',
      body: '',
      repo: 'r',
      workflow_id: 'm1_basic',
      priority: 3,
      required_tags: [],
      repo_allow_machines: null,
      external_ref: null,
      size: null,
    });
  });

  it('priority is P0–P4 on create, PATCH and schedules (ADR-0036)', () => {
    const create = { title: 't', body: '', repo: 'r', kind: 'work' as const };
    const schedule = { name: 'n', cron: '0 9 * * *', title: 't', repo: 'r', kind: 'work' as const };
    const patch = { expected_updated_at: '2026-11-05T00:00:00.000Z' };
    expect(CreateScheduleRequestSchema.parse(schedule).priority).toBe(3);
    for (const priority of [0, 4]) {
      expect(CreateTicketRequestSchema.safeParse({ ...create, priority }).success).toBe(true);
      expect(UpdateTicketRequestSchema.safeParse({ ...patch, priority }).success).toBe(true);
    }
    for (const priority of [-1, 5, 1.5]) {
      expect(CreateTicketRequestSchema.safeParse({ ...create, priority }).success).toBe(false);
      expect(UpdateTicketRequestSchema.safeParse({ ...patch, priority }).success).toBe(false);
      expect(CreateScheduleRequestSchema.safeParse({ ...schedule, priority }).success).toBe(false);
    }
  });

  it('defaults workflow_id to conductor (ADR-0010)', () => {
    expect(
      CreateTicketRequestSchema.parse({ title: 't', body: '', repo: 'r', kind: 'personal' })
        .workflow_id,
    ).toBe('conductor');
  });

  it('size is an optional S/M/L (ADR-0037 §4, C2); a card without one reads null', () => {
    const create = { title: 't', body: '', repo: 'r', kind: 'work' as const };
    for (const size of ['S', 'M', 'L'] as const) {
      expect(CreateTicketRequestSchema.parse({ ...create, size }).size).toBe(size);
    }
    expect(CreateTicketRequestSchema.parse(create).size).toBeNull();
    expect(CreateTicketRequestSchema.safeParse({ ...create, size: 'XL' }).success).toBe(false);
    const { size: _omit, ...older } = BOARD_CARD_FIXTURE;
    expect(BoardCardSchema.parse(older).size).toBeNull();
  });

  it('kind is optional: the server defaults it from the repo (WF-T03)', () => {
    const res = CreateTicketRequestSchema.safeParse({ title: 't', body: '', repo: 'r' });
    expect(res.success).toBe(true);
    expect(res.data?.kind).toBeUndefined();
  });
});
