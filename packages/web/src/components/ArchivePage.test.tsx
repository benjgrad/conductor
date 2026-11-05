// @vitest-environment jsdom
// UXR-85: #/archive, the done and cancelled tickets, against the mock API.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { ArchivePage } from './ArchivePage.js';

afterEach(cleanup);

const rows = () =>
  within(screen.getByRole('list'))
    .getAllByRole('button')
    .map((b) => b.querySelector('.search-result-title')?.textContent);

describe('ArchivePage', () => {
  it('lists the done and cancelled tickets, newest first, and nothing open', async () => {
    render(<ArchivePage api={createMockApi()} onOpen={() => {}} />);
    await screen.findByRole('list');
    expect(rows()).toEqual(['Rename user.fullname', 'Try a GraphQL gateway']);
    expect(screen.getByText('2 tickets')).toBeTruthy();
  });

  it('filters by Done or Cancelled, and by text', async () => {
    render(<ArchivePage api={createMockApi()} onOpen={() => {}} />);
    await screen.findByRole('list');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelled' }));
    await waitFor(() => expect(rows()).toEqual(['Try a GraphQL gateway']));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(rows()).toEqual(['Rename user.fullname']));
    fireEvent.click(screen.getByRole('button', { name: 'All closed' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter the archive' }), {
      target: { value: 'gateway' },
    });
    await waitFor(() => expect(rows()).toEqual(['Try a GraphQL gateway']));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter the archive' }), {
      target: { value: 'nothing like it' },
    });
    expect(await screen.findByText(/No closed tickets match/)).toBeTruthy();
  });

  it('loads a page at a time', async () => {
    render(<ArchivePage api={createMockApi()} onOpen={() => {}} pageSize={1} />);
    await screen.findByRole('list');
    expect(rows()).toEqual(['Rename user.fullname']);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rows()).toEqual(['Rename user.fullname', 'Try a GraphQL gateway']));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('opens a row', async () => {
    const onOpen = vi.fn();
    render(<ArchivePage api={createMockApi()} onOpen={onOpen} />);
    fireEvent.click(await screen.findByRole('button', { name: /Try a GraphQL gateway/ }));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: SEED_IDS.cancelled.ticket, status: 'cancelled' }),
    );
  });
});
