// @vitest-environment jsdom
import {
  BOARD_CARD_ALERT_FIXTURE,
  BOARD_CARD_FIXTURE,
  BOARD_CARD_ROUTING_FIXTURE,
  type BoardCard,
} from '@conductor/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardState } from '../board/board.js';
import { Board } from './Board.js';

// M2-T11: the routing badge (ADR-0013 §Routing) and the `.git` alert badge (U-060).

afterEach(cleanup);

function renderCards(cards: BoardCard[]) {
  const state: BoardState = { cards: new Map(cards.map((c) => [c.ticket_id, c])), lastEventId: 0 };
  return render(<Board board={state} selectedSessionId={null} onSelect={vi.fn()} />);
}

const article = (title: string) =>
  within(screen.getByText(title).closest('article') as HTMLElement);

const ROUTED: BoardCard = { ...BOARD_CARD_ROUTING_FIXTURE, title: 'Routed', column: 'queued' };
const ALERTED: BoardCard = {
  ...BOARD_CARD_ALERT_FIXTURE,
  ticket_id: 'a1000000-0000-4000-8000-0000000000a1',
  title: 'Alerted',
};
const PLAIN: BoardCard = {
  ...BOARD_CARD_FIXTURE,
  ticket_id: 'a1000000-0000-4000-8000-0000000000a2',
  title: 'Plain',
  column: 'queued',
};

describe('board routing and alert badges (M2-T11)', () => {
  it('a Queued card with routing names the missing repo and capabilities', () => {
    renderCards([ROUTED, PLAIN]);
    const badge = article('Routed').getByText(/needs a machine with/);
    expect(badge.textContent).toBe('needs a machine with benjgrad/fixture-app and az (signed in)');
    expect(within(badge).getByText('benjgrad/fixture-app').tagName).toBe('CODE');
    expect(article('Plain').queryByText(/needs a machine/)).toBeNull();
  });

  it('lists three needs with commas and "and"; an empty routing still says why it waits', () => {
    renderCards([
      {
        ...ROUTED,
        routing: { missing_repo: 'gitlab.com/o/r', missing_capabilities: ['cli:az', 'mcp:jira'] },
      },
      { ...PLAIN, title: 'Empty', routing: { missing_capabilities: [] } },
    ]);
    expect(article('Routed').getByText(/needs a machine with/).textContent).toBe(
      'needs a machine with gitlab.com/o/r, az and jira MCP server',
    );
    expect(article('Empty').getByText('no online machine can take it')).toBeTruthy();
  });

  it('a repo rule says which machine alone takes it, before anything it lacks', () => {
    renderCards([
      {
        ...ROUTED,
        routing: { missing_capabilities: [], exclusive_to: ['Work laptop'] },
      },
      {
        ...PLAIN,
        title: 'Two',
        routing: { missing_capabilities: [], exclusive_to: ['Work laptop', 'Mac'] },
      },
      {
        ...PLAIN,
        ticket_id: 'a1000000-0000-4000-8000-0000000000a3',
        title: 'Allow',
        routing: { missing_capabilities: ['cli:az'], excluded_by_rule: true },
      },
    ]);
    expect(article('Routed').getByText('only Work laptop takes this repo')).toBeTruthy();
    expect(article('Two').getByText('only Work laptop and Mac take this repo')).toBeTruthy();
    expect(article('Allow').getByText(/needs a machine with/).textContent).toBe(
      "left out by the machines' repo rules; needs a machine with az",
    );
  });

  it('shows routing only on Queued cards', () => {
    renderCards([{ ...ROUTED, column: 'implementing', status: 'running' }]);
    expect(screen.queryByText(/needs a machine/)).toBeNull();
  });

  it('a card with an alert shows the red ".git changed" badge and the files', () => {
    renderCards([
      {
        ...ALERTED,
        alerts: [
          ...ALERTED.alerts!,
          {
            kind: 'git_tamper',
            files: ['.git/config', '.git/hooks/pre-commit'],
            at: ALERTED.created_at,
          },
        ],
      },
      PLAIN,
    ]);
    const card = article('Alerted');
    expect(card.getByText('.git changed').className).toContain('badge-alert');
    const files = card.getByRole('list', { name: '.git files changed' });
    expect(
      within(files)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['.git/hooks/pre-commit', '.git/config']);
    expect(article('Plain').queryByText('.git changed')).toBeNull();
  });
});
