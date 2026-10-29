// @vitest-environment jsdom
import {
  BOARD_CARD_FIXTURE,
  BOARD_CARD_NEEDS_INPUT_FIXTURE,
  type BoardCard,
  type BoardSseEvent,
} from '@conductor/shared';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyBoardEvent,
  boardFromResponse,
  EMPTY_BOARD,
  type BoardState,
} from '../board/board.js';
import { agentName } from '../components/agent-identity.js';
import { FAVICON_DOT, FAVICON_PLAIN } from './favicon.js';
import { stubNotification } from './notification-stub.js';
import { clip, useNeedsInputNotifications } from './useNeedsInputNotifications.js';

const RUNNING: BoardCard = {
  ...BOARD_CARD_FIXTURE,
  ticket_id: '11111111-1111-4111-8111-111111111111',
  session_id: '22222222-2222-4222-8222-222222222222',
  title: 'Add pagination',
  status: 'running',
  column: 'implementing',
};
const ASKING = BOARD_CARD_NEEDS_INPUT_FIXTURE;
const REQ = '33333333-3333-4333-8333-333333333333';

function loaded(cards: BoardCard[], lastEventId = 10): BoardState {
  return boardFromResponse({
    columns: [{ id: 'queued', title: 'Queued', kind: 'queued', cards }],
    last_event_id: lastEventId,
  });
}

function asked(id: number, question = 'Which DB should I target?', reqId = REQ): BoardSseEvent {
  return {
    type: 'input.requested',
    id,
    ts: '2026-10-29T12:00:00.000Z',
    session_id: RUNNING.session_id!,
    input_request_id: reqId,
    kind: 'agent_question',
    question,
    created_at: '2026-10-29T12:00:00.000Z',
  };
}

function answered(id: number, reqId = REQ, sessionId = RUNNING.session_id!): BoardSseEvent {
  return {
    type: 'input.answered',
    id,
    ts: '2026-10-29T12:01:00.000Z',
    session_id: sessionId,
    input_request_id: reqId,
    answered_by: 'ben',
  };
}

const favicon = () => document.querySelector('link#favicon')?.getAttribute('href');

let N: ReturnType<typeof stubNotification>;
const onSelect = vi.fn();

function mount(board: BoardState) {
  return renderHook(({ b }) => useNeedsInputNotifications(b, onSelect), {
    initialProps: { b: board },
  });
}

beforeEach(() => {
  N = stubNotification('granted');
  localStorage.setItem('conductor.notifications', 'on');
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  onSelect.mockReset();
  document.title = 'Conductor';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  document.querySelector('link#favicon')?.remove();
});

describe('useNeedsInputNotifications', () => {
  it('fires once for a new request, with the agent, ticket title, question and tag', () => {
    const start = loaded([RUNNING]);
    const { rerender } = mount(start);
    expect(N.instances).toHaveLength(0);

    const next = applyBoardEvent(start, asked(11));
    rerender({ b: next });
    expect(N.instances).toHaveLength(1);
    const n = N.instances[0]!;
    expect(n.title).toBe(`${agentName(RUNNING.ticket_id)} needs input`);
    expect(n.options.body).toBe('Add pagination: Which DB should I target?');
    expect(n.options.tag).toBe(REQ);

    // A re-render, a replayed event and a reconnect (a fresh GET /api/board) don't fire again.
    rerender({ b: next });
    rerender({ b: applyBoardEvent(next, asked(11)) });
    rerender({ b: loaded([next.cards.get(RUNNING.ticket_id)!], 11) });
    expect(N.instances).toHaveLength(1);
  });

  it('clips the body to 120 characters', () => {
    const start = loaded([RUNNING]);
    const { rerender } = mount(start);
    rerender({ b: applyBoardEvent(start, asked(11, 'x'.repeat(300))) });
    const body = N.instances[0]!.options.body!;
    expect(body).toHaveLength(120);
    expect(body.endsWith('…')).toBe(true);
    expect(clip('short')).toBe('short');
  });

  it('counts but does not fire a request already open at load', () => {
    const { rerender } = mount(EMPTY_BOARD);
    expect(document.title).toBe('Conductor');
    rerender({ b: loaded([RUNNING, ASKING]) });
    expect(N.instances).toHaveLength(0);
    expect(document.title).toBe('(1) Conductor');
    expect(favicon()).toBe(FAVICON_DOT);
  });

  it('the title count and favicon dot follow the cards and clear at zero', () => {
    const start = loaded([RUNNING, ASKING]);
    const { rerender, unmount } = mount(start);
    expect(document.title).toBe('(1) Conductor');

    const two = applyBoardEvent(start, asked(11));
    rerender({ b: two });
    expect(document.title).toBe('(2) Conductor');
    expect(favicon()).toBe(FAVICON_DOT);

    const one = applyBoardEvent(two, answered(12));
    rerender({ b: one });
    expect(document.title).toBe('(1) Conductor');
    // The answered request's notification goes with it.
    expect(N.instances[0]!.close).toHaveBeenCalled();

    const none = applyBoardEvent(one, answered(13, ASKING.input_request!.id, ASKING.session_id!));
    rerender({ b: none });
    expect(document.title).toBe('Conductor');
    expect(favicon()).toBe(FAVICON_PLAIN);

    rerender({
      b: applyBoardEvent(none, asked(14, 'Again?', '44444444-4444-4444-8444-444444444444')),
    });
    unmount();
    expect(document.title).toBe('Conductor');
    expect(favicon()).toBe(FAVICON_PLAIN);
  });

  it('clicking the notification focuses the tab and selects the session', () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const start = loaded([RUNNING]);
    const { rerender } = mount(start);
    rerender({ b: applyBoardEvent(start, asked(11)) });
    N.instances[0]!.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(RUNNING.session_id);
    expect(N.instances[0]!.close).toHaveBeenCalled();
  });

  it("doesn't fire while the page is focused and visible", () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const start = loaded([RUNNING]);
    const { rerender } = mount(start);
    rerender({ b: applyBoardEvent(start, asked(11)) });
    expect(N.instances).toHaveLength(0);
    expect(document.title).toBe('(1) Conductor');
  });

  it("doesn't fire when the setting is off or the permission isn't granted", () => {
    localStorage.setItem('conductor.notifications', 'off');
    const start = loaded([RUNNING]);
    const { rerender } = mount(start);
    rerender({ b: applyBoardEvent(start, asked(11)) });
    expect(N.instances).toHaveLength(0);

    localStorage.setItem('conductor.notifications', 'on');
    N.permission = 'default';
    const next = applyBoardEvent(start, asked(11));
    rerender({
      b: applyBoardEvent(next, asked(12, 'Other?', '55555555-5555-4555-8555-555555555555')),
    });
    expect(N.instances).toHaveLength(0);
  });

  it('without Notification, nothing throws and the title count still works', () => {
    vi.stubGlobal('Notification', undefined);
    const start = loaded([RUNNING]);
    const { rerender } = mount(start);
    rerender({ b: applyBoardEvent(start, asked(11)) });
    expect(document.title).toBe('(1) Conductor');
  });
});
