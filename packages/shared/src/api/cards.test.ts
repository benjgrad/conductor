import { describe, expect, it } from 'vitest';
import { APPLY_REJECT_REASONS } from '../engine/types.js';
import { BOARD_CARD_FIXTURE } from './fixtures.js';
import {
  API_PATHS,
  APPLY_REJECT_HTTP,
  ApproveSessionRequestSchema,
  BoardCardSchema,
  conductorPort,
  DEFAULT_CONDUCTOR_PORT,
  httpForApplyResult,
  toBoardCard,
  toInputRequestDto,
} from './rest.js';

const ticket = {
  id: BOARD_CARD_FIXTURE.ticket_id,
  title: 'Add /health',
  external_ref: null,
  repo: 'github.com/benjgrad/fixture-app',
  priority: 0,
  workflow_id: 'm1_basic',
  created_at: new Date('2026-10-22T12:00:00.000Z'),
  updated_at: new Date('2026-10-22T12:00:00.000Z'),
};
const session = {
  id: '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f',
  workflow_state: 'needs_input',
  status: 'needs_input' as const,
  machine_id: 'mbp-ben',
  spend_usd: '0.4200',
  waiting_for_build_slot: false,
  updated_at: new Date('2026-10-22T12:05:00.000Z'),
};
const input = {
  id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  session_id: session.id,
  kind: 'agent_question' as const,
  question: 'Which DB?',
  answer: null,
  answered_by: null,
  created_at: new Date('2026-10-22T12:04:00.000Z'),
  answered_at: null,
};

describe('toBoardCard / toInputRequestDto', () => {
  it('a sessionless ticket equals BOARD_CARD_FIXTURE', () => {
    expect(toBoardCard(ticket, null, null)).toEqual(BOARD_CARD_FIXTURE);
  });

  it('derives column, spend (numeric string), open input and the latest updated_at', () => {
    const card = BoardCardSchema.parse(toBoardCard(ticket, session, input));
    expect(card).toMatchObject({
      session_id: session.id,
      status: 'needs_input',
      column: 'needs_input',
      spend_usd: 0.42,
      machine_id: 'mbp-ben',
      badges: [],
      updated_at: '2026-10-22T12:05:00.000Z',
    });
    expect(card.input_request).toEqual(toInputRequestDto(input));
    expect(card.input_request?.created_at).toBe('2026-10-22T12:04:00.000Z');
  });

  it('badges the build-slot wait and drops an answered request', () => {
    const card = toBoardCard(
      ticket,
      { ...session, status: 'running', waiting_for_build_slot: true },
      { ...input, answer: 'pg', answered_by: 'ben', answered_at: '2026-10-22T12:06:00Z' },
    );
    expect(card.badges).toEqual(['waiting_for_build_slot']);
    expect(card.column).toBe('running');
    expect(card.input_request).toBeNull();
  });

  it('drops a still-open request once the session left needs_input (TD-079: cancel)', () => {
    const card = toBoardCard(ticket, { ...session, status: 'failed' }, input);
    expect(card.column).toBe('failed');
    expect(card.input_request).toBeNull();
  });
});

describe('REST error map', () => {
  it('maps every reject reason', () => {
    expect(Object.keys(APPLY_REJECT_HTTP).sort()).toEqual([...APPLY_REJECT_REASONS].sort());
    expect(
      httpForApplyResult('input', { status: 'rejected', reason: 'input_already_answered' }),
    ).toEqual({ status: 409, code: 'input_already_answered' });
    expect(httpForApplyResult('cancel', { status: 'rejected', reason: 'unknown_session' })).toEqual(
      { status: 404, code: 'not_found' },
    );
  });

  it('maps ignored per route', () => {
    expect(httpForApplyResult('input', { status: 'ignored', reason: 'wrong_status' })).toEqual({
      status: 409,
      code: 'input_not_pending',
    });
    expect(httpForApplyResult('approve', { status: 'ignored', reason: 'not_awaited' })).toEqual({
      status: 409,
      code: 'conflict',
    });
  });

  it('approve body is an optional comment', () => {
    expect(ApproveSessionRequestSchema.parse({})).toEqual({});
    expect(ApproveSessionRequestSchema.parse({ comment: 'lgtm' })).toEqual({ comment: 'lgtm' });
  });
});

describe('ports and paths', () => {
  it('reads CONDUCTOR_PORT with a default', () => {
    expect(conductorPort({})).toBe(DEFAULT_CONDUCTOR_PORT);
    expect(conductorPort({ CONDUCTOR_PORT: '8080' })).toBe(8080);
    expect(() => conductorPort({ CONDUCTOR_PORT: 'x' })).toThrow();
    expect(API_PATHS.daemonWs).toBe('/ws/daemon');
  });
});
