import { describe, expect, it } from 'vitest';
import { SessionStatusSchema } from '../domain.js';
import { BOARD_SSE_FIXTURES, OUTPUT_CHUNK_FIXTURE } from './fixtures.js';
import { BOARD_COLUMNS, columnFor, CreateTicketRequestSchema } from './rest.js';
import {
  BOARD_SSE_EVENT_TYPES,
  boardSseEventFromRow,
  boardSseEventToRow,
  BoardSseEventSchema,
  encodeSseFrame,
  OutputChunkSchema,
  type BoardSseEvent,
} from './sse.js';
import { sessionBranch } from '../domain.js';

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

describe('sessionBranch', () => {
  it('is conductor/<ticket>/<first 8 of session>', () => {
    expect(
      sessionBranch('0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2', '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f'),
    ).toBe('conductor/0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2/7d0c5b1e');
  });
});

describe('columnFor (06)', () => {
  it.each([
    ['queued', 'queued'],
    ['assigned', 'queued'],
    ['running', 'running'],
    ['needs_input', 'needs_input'],
    ['waiting_external', 'waiting_external'],
    ['done', 'done'],
    ['failed', 'failed'],
    ['lost', 'failed'],
  ] as const)('%s → %s', (status, column) => {
    expect(columnFor(status)).toBe(column);
  });

  it('maps an unclaimed ticket (no session) to queued', () => {
    expect(columnFor(null)).toBe('queued');
  });

  it('covers every status and only known columns', () => {
    for (const s of SessionStatusSchema.options) expect(BOARD_COLUMNS).toContain(columnFor(s));
  });

  it('waiting_for_build_slot is not a status', () => {
    expect(SessionStatusSchema.safeParse('waiting_for_build_slot').success).toBe(false);
  });
});

describe('REST DTO defaults', () => {
  it('fills CreateTicketRequest defaults', () => {
    expect(
      CreateTicketRequestSchema.parse({ title: 't', body: '', repo: 'r', workflow_id: 'm1_basic' }),
    ).toEqual({
      title: 't',
      body: '',
      repo: 'r',
      workflow_id: 'm1_basic',
      priority: 0,
      required_tags: [],
      repo_allow_machines: null,
      external_ref: null,
    });
  });
});
