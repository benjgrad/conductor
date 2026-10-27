import { describe, expect, it } from 'vitest';
import type { InputRequestKind, TicketStatus } from '../domain.js';
import { MACHINE_LOST_MARK_FIXTURE } from '../engine/fixtures.js';
import { MACHINE_LOST_CONTEXT_KEY, type MachineLostMark } from '../engine/types.js';
import { boardColumns } from '../workflow/conductor.js';
import { CONDUCTOR_V2_DRAFT_DEF } from '../workflow/fixtures.js';
import {
  BoardCardSchema,
  humanTransitionsOfCard,
  toBoardCard,
  type CardView,
  type InputRequestLike,
} from './rest.js';

// M2-T06 (U-068): the card of a session parked by a lost machine (10-contracts §Machines
// protocol v2, "Lost machines"): "Continue on <machine>" for `$return_to`; revoked = Cancel only.

const V2: CardView = { columns: boardColumns(CONDUCTOR_V2_DRAFT_DEF), def: CONDUCTOR_V2_DRAFT_DEF };
const AT = new Date('2026-10-22T12:10:00.000Z');

const ticket = {
  id: '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2',
  status: 'in_progress' as TicketStatus,
  kind: 'work' as const,
  title: 'Add /health',
  external_ref: null,
  repo: 'github.com/benjgrad/fixture-app',
  priority: 0,
  workflow_id: 'conductor',
  created_at: AT,
  updated_at: AT,
};

const parked = (mark: MachineLostMark | null) => ({
  id: '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f',
  workflow_state: 'needs_input',
  status: 'needs_input' as const,
  machine_id: 'mbp-ben',
  spend_usd: 0,
  waiting_for_build_slot: false,
  context: mark === null ? {} : { [MACHINE_LOST_CONTEXT_KEY]: mark },
  return_to: 'implementing',
  updated_at: AT,
});

const request = (kind: InputRequestKind, answer: string | null = null): InputRequestLike => ({
  id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  session_id: '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f',
  kind,
  question: "Ben's MacBook stopped responding",
  answer,
  answered_by: null,
  created_at: AT,
  answered_at: null,
});

const buttons = (mark: MachineLostMark | null, openInput: InputRequestLike | null) => {
  const card = toBoardCard(ticket, parked(mark), openInput, V2);
  expect(BoardCardSchema.parse(card)).toEqual(card);
  return card.human_transitions.map((h) => [h.name, h.title, h.goto]);
};

describe('BoardCard.human_transitions for a lost machine (M2-T06)', () => {
  it('lease_expired: $return_to reads "Continue on <machine>"; the others are unchanged', () => {
    expect(buttons(MACHINE_LOST_MARK_FIXTURE, request('machine_lost'))).toEqual([
      ['answer', "Continue on Ben's MacBook", 'implementing'],
      ['waiting_on_someone', 'Waiting on someone else', 'waiting_external'],
      ['done', 'Done', 'done'],
    ]);
    const offline = { ...MACHINE_LOST_MARK_FIXTURE, reason: 'pinned_machine_offline' as const };
    expect(buttons(offline, request('machine_lost'))[0]?.[1]).toBe("Continue on Ben's MacBook");
  });

  it('revoked: no transitions (Cancel stays an operator action)', () => {
    const revoked = { ...MACHINE_LOST_MARK_FIXTURE, reason: 'revoked' as const };
    expect(buttons(revoked, request('machine_lost'))).toEqual([]);
    expect(buttons(revoked, null)).toEqual([]);
  });

  it('the title only changes while the open request is machine_lost', () => {
    const normal = [
      ['answer', 'Back with this answer', 'implementing'],
      ['waiting_on_someone', 'Waiting on someone else', 'waiting_external'],
      ['done', 'Done', 'done'],
    ];
    expect(buttons(MACHINE_LOST_MARK_FIXTURE, request('agent_question'))).toEqual(normal);
    expect(buttons(MACHINE_LOST_MARK_FIXTURE, request('machine_lost', 'go'))).toEqual(normal);
    expect(buttons(MACHINE_LOST_MARK_FIXTURE, null)).toEqual(normal);
    expect(buttons(null, request('machine_lost'))).toEqual(normal);
  });

  it('humanTransitionsOfCard without the request kind keeps the plain titles', () => {
    const opts = humanTransitionsOfCard(ticket, parked(MACHINE_LOST_MARK_FIXTURE), V2);
    expect(opts[0]?.title).toBe('Back with this answer');
    expect(
      humanTransitionsOfCard(ticket, parked(MACHINE_LOST_MARK_FIXTURE), V2, 'machine_lost')[0]
        ?.title,
    ).toBe("Continue on Ben's MacBook");
  });
});
