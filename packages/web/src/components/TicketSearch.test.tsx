// @vitest-environment jsdom
// UXR-85: the top bar's ticket search, against the mock API.
import type { TicketSearchResponse, TicketSearchResult } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { groupResults, TicketSearch } from './TicketSearch.js';

afterEach(cleanup);

const field = () => screen.getByRole('combobox', { name: 'Search tickets' });
const type = (text: string) => fireEvent.change(field(), { target: { value: text } });
const group = (name: string) => screen.getByRole('group', { name });
const titlesIn = (name: string) =>
  within(group(name))
    .getAllByRole('option')
    .map((o) => o.querySelector('.search-result-title')?.textContent);

function result(id: string, status: TicketSearchResult['status']): TicketSearchResult {
  return {
    id,
    title: id,
    external_ref: null,
    status,
    kind: 'work',
    repo: 'github.com/acme/app',
    snippet: null,
    session_id: null,
    created_at: '2026-10-22T12:00:00.000Z',
    updated_at: '2026-10-22T12:00:00.000Z',
  };
}

describe('groupResults', () => {
  it('groups Open (failed included), Done, Cancelled, keeping the order and dropping empty ones', () => {
    const groups = groupResults([
      result('c', 'cancelled'),
      result('a', 'failed'),
      result('b', 'ready'),
    ]);
    expect(groups.map((g) => [g.title, g.tickets.map((t) => t.id)])).toEqual([
      ['Open', ['a', 'b']],
      ['Cancelled', ['c']],
    ]);
  });
});

describe('TicketSearch', () => {
  it('shows results as you type, grouped Open / Done / Cancelled', async () => {
    render(<TicketSearch api={createMockApi()} onOpen={() => {}} />);
    field().focus();
    type('a1000000');
    expect(await screen.findByRole('group', { name: 'Cancelled' })).toBeTruthy();
    expect(titlesIn('Done')).toEqual(['Rename user.fullname']);
    expect(titlesIn('Cancelled')).toEqual(['Try a GraphQL gateway']);
    expect(titlesIn('Open')).toContain('Upgrade webpack');
    expect(screen.getByRole('link', { name: 'Browse the archive' }).getAttribute('href')).toBe(
      '#/archive',
    );
  });

  it('says when nothing matches', async () => {
    render(<TicketSearch api={createMockApi()} onOpen={() => {}} />);
    type('zzz-no-such-ticket');
    expect(await screen.findByText(/No tickets match/)).toBeTruthy();
  });

  it('opens a result by click, and by arrow keys and Enter', async () => {
    const onOpen = vi.fn();
    render(<TicketSearch api={createMockApi()} onOpen={onOpen} />);
    type('graphql');
    fireEvent.click(await screen.findByRole('option', { name: /Try a GraphQL gateway/ }));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        id: SEED_IDS.cancelled.ticket,
        session_id: SEED_IDS.cancelled.session,
        status: 'cancelled',
      }),
    );
    expect((field() as HTMLInputElement).value).toBe('');

    type('Rename user');
    await screen.findByRole('option', { name: /Rename user.fullname/ });
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(field().getAttribute('aria-activedescendant')).toBeTruthy();
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: SEED_IDS.done.ticket }));
  });

  it('Escape clears and closes the list', async () => {
    render(<TicketSearch api={createMockApi()} onOpen={() => {}} />);
    type('graphql');
    await screen.findByRole('listbox');
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect((field() as HTMLInputElement).value).toBe('');
  });

  it('/ focuses the field, but not while typing elsewhere', () => {
    render(
      <>
        <textarea aria-label="Answer" />
        <TicketSearch api={createMockApi()} onOpen={() => {}} />
      </>,
    );
    const answer = screen.getByRole('textbox', { name: 'Answer' });
    answer.focus();
    fireEvent.keyDown(answer, { key: '/' });
    expect(document.activeElement).toBe(answer);

    answer.blur();
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(field());
  });

  it('a slow, older answer never replaces a newer one', async () => {
    const pending: ((r: TicketSearchResponse) => void)[] = [];
    const api = {
      searchTickets: () =>
        new Promise<TicketSearchResponse>((resolve) => {
          pending.push(resolve);
        }),
    } as unknown as ApiClient;
    render(<TicketSearch api={api} onOpen={() => {}} />);
    type('first');
    await waitFor(() => expect(pending).toHaveLength(1));
    type('second');
    await waitFor(() => expect(pending).toHaveLength(2));
    const page = (title: string): TicketSearchResponse => ({
      tickets: [{ ...result(SEED_IDS.done.ticket, 'done'), title }],
      next_cursor: null,
      total: 1,
    });
    pending[1]!(page('Newer'));
    expect(await screen.findByRole('option', { name: /Newer/ })).toBeTruthy();
    pending[0]!(page('Older'));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('option', { name: /Older/ })).toBeNull();
  });

  it('on a phone, an icon opens the field', () => {
    render(<TicketSearch api={createMockApi()} onOpen={() => {}} mobile />);
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Search tickets' }));
    expect(document.activeElement).toBe(field());
    fireEvent.click(screen.getByRole('button', { name: 'Close search' }));
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
