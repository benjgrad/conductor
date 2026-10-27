import { describe, expect, it } from 'vitest';
import { entryStateLabel, reviewStateLabel } from '../engine/review.js';
import { moveStateLabel } from '../engine/types.js';
import { BOARD_CARD_NEEDS_INPUT_FIXTURE, BOARD_SSE_FIXTURES } from './fixtures.js';
import {
  BoardCardSchema,
  BoardResponseSchema,
  InputRequestDtoSchema,
  isGateStepLabel,
  toInputRequestDto,
} from './rest.js';
import { BoardSseEventSchema } from './sse.js';

// UX-4: input_request.origin_transition / step_failed (additive; older payloads still parse).

const row = {
  id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  session_id: '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f',
  kind: 'agent_question' as const,
  question: 'TASK: UX-4\nBRANCH: x\nSTATUS: complete',
  answer: null,
  answered_by: null,
  created_at: new Date('2026-10-22T12:04:00.000Z'),
  answered_at: null,
};
const MOVE_LABEL = moveStateLabel('implementing', 'needs_input', 'personal_pr_ready_for_review');

describe('toInputRequestDto origin (UX-4)', () => {
  it('passes the opening transition through; not a failed step', () => {
    const dto = toInputRequestDto({
      ...row,
      origin_transition: 'personal_pr_ready_for_review',
      origin_from: MOVE_LABEL,
    });
    expect(dto.origin_transition).toBe('personal_pr_ready_for_review');
    expect(dto.step_failed).toBe(false);
    expect(InputRequestDtoSchema.parse(dto)).toEqual(dto);
  });

  it('step_failed: a gate-step label, no transition, a failure kind', () => {
    const failed = (kind: 'retries_exhausted' | 'timeout' | 'agent_question', from: string) =>
      toInputRequestDto({ ...row, kind, origin_transition: null, origin_from: from });
    expect(failed('retries_exhausted', MOVE_LABEL)).toMatchObject({
      origin_transition: null,
      step_failed: true,
    });
    expect(failed('timeout', entryStateLabel('implementing', 'done')).step_failed).toBe(true);
    expect(failed('agent_question', MOVE_LABEL).step_failed).toBe(false);
    expect(failed('retries_exhausted', 'implementing').step_failed).toBe(false);
    expect(
      toInputRequestDto({
        ...row,
        kind: 'retries_exhausted',
        origin_transition: 'x',
        origin_from: MOVE_LABEL,
      }).step_failed,
    ).toBe(false);
  });

  it('no origin row (null, null): origin_transition null, step_failed false', () => {
    expect(toInputRequestDto({ ...row, origin_transition: null, origin_from: null })).toMatchObject(
      { origin_transition: null, step_failed: false },
    );
  });

  it('omits both fields when the row carries no origin info', () => {
    const dto = toInputRequestDto(row);
    expect('origin_transition' in dto).toBe(false);
    expect('step_failed' in dto).toBe(false);
  });

  it('isGateStepLabel matches the engine label helpers, not plain state names', () => {
    expect(isGateStepLabel(entryStateLabel('a', 'b'))).toBe(true);
    expect(isGateStepLabel(reviewStateLabel('a', 'b'))).toBe(true);
    expect(isGateStepLabel(moveStateLabel('a', 'b', 'pr_ready_for_review'))).toBe(true);
    expect(isGateStepLabel('needs_input')).toBe(false);
    expect(isGateStepLabel('implementing')).toBe(false);
  });
});

describe('old payloads without the origin fields still parse (UX-4)', () => {
  it('BoardCard, BoardResponse and input.requested', () => {
    const card = BoardCardSchema.parse(BOARD_CARD_NEEDS_INPUT_FIXTURE);
    expect(card.input_request).not.toBeNull();
    expect('origin_transition' in card.input_request!).toBe(false);
    expect('step_failed' in card.input_request!).toBe(false);
    expect(
      BoardResponseSchema.parse({
        columns: [{ id: 'needs_input', title: 'Needs input', kind: 'human', cards: [card] }],
        last_event_id: 3,
      }).columns[0]!.cards[0]!.input_request,
    ).toEqual(card.input_request);
    expect(BoardSseEventSchema.parse(BOARD_SSE_FIXTURES['input.requested'])).toEqual(
      BOARD_SSE_FIXTURES['input.requested'],
    );
  });
});
