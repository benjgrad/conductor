import { describe, expect, it } from 'vitest';
import { SessionStatusSchema } from '../domain.js';
import { BOARD_SSE_FIXTURES, OUTPUT_CHUNK_FIXTURE } from './fixtures.js';
import { BOARD_COLUMNS, columnFor, CreateTicketRequestSchema } from './rest.js';
import {
  BOARD_SSE_EVENT_TYPES,
  BoardSseEventSchema,
  encodeSseFrame,
  OutputChunkSchema,
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
