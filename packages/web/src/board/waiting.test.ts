import {
  BOARD_CARD_FIXTURE,
  BOARD_CARD_NEEDS_INPUT_FIXTURE,
  BOARD_CARD_NEEDS_PERMISSION_FIXTURE,
  type BoardCard,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { hasPendingPermission, waitingOnYou } from './waiting.js';

const PERM = BOARD_CARD_NEEDS_PERMISSION_FIXTURE;
const held = (n: number, expires: string): BoardCard => ({
  ...PERM,
  ticket_id: `a1000000-0000-4000-8000-00000000000${n}`,
  permission: { ...PERM.permission!, expires_at: expires },
});

describe('waitingOnYou (UXR-32)', () => {
  it('counts questions and permission cards, oldest permission first', () => {
    const later = held(1, '2026-10-22T12:40:00.000Z');
    const sooner = held(2, '2026-10-22T12:10:00.000Z');
    const w = waitingOnYou([BOARD_CARD_FIXTURE, later, BOARD_CARD_NEEDS_INPUT_FIXTURE, sooner]);
    expect(w.questions).toEqual([BOARD_CARD_NEEDS_INPUT_FIXTURE]);
    expect(w.permissions).toEqual([sooner, later]);
    expect(w.total).toBe(3);
  });

  it('a card with both counts once, as a question', () => {
    const both = { ...PERM, input_request: BOARD_CARD_NEEDS_INPUT_FIXTURE.input_request };
    expect(waitingOnYou([both])).toMatchObject({ questions: [both], permissions: [], total: 1 });
  });

  it('the sub-status without a permission (or the reverse) is not a pending permission', () => {
    const noPermission: BoardCard = { ...PERM };
    delete noPermission.permission;
    const noSub: BoardCard = { ...PERM, sub_status: null };
    expect(hasPendingPermission(PERM)).toBe(true);
    expect(hasPendingPermission(noPermission)).toBe(false);
    expect(hasPendingPermission(noSub)).toBe(false);
    expect(waitingOnYou([noPermission, noSub]).total).toBe(0);
  });
});
