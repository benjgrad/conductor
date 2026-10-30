// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiRequestError } from '../api/client.js';
import { createMockApi } from '../api/mock.js';
import { App } from '../App.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function openQueued(patch?: (api: ReturnType<typeof createMockApi>) => void) {
  const api = createMockApi({ replyDelayMs: 0 });
  await api.createTicket({
    title: 'Queued idea',
    body: 'The first description',
    repo: 'github.com/acme/app',
    kind: 'work',
  });
  patch?.(api);
  render(<App api={api} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Queued idea' }));
  const panel = within(await screen.findByRole('complementary', { name: 'Ticket detail' }));
  await panel.findByText('The first description');
  return { api, panel };
}

describe('a queued ticket', () => {
  it('opens read-only with its description, and edits through PATCH', async () => {
    const { api, panel } = await openQueued();
    fireEvent.click(panel.getByRole('button', { name: 'Edit ticket' }));
    const form = within(panel.getByRole('form', { name: 'Edit ticket' }));
    fireEvent.change(form.getByLabelText('Title'), { target: { value: 'Sharper idea' } });
    fireEvent.click(form.getByRole('button', { name: 'Save' }));
    await panel.findByRole('heading', { name: 'Sharper idea' });
    const board = await api.getBoard();
    expect(board.columns[0]!.cards.some((c) => c.title === 'Sharper idea')).toBe(true);
  });

  it('says so when the ticket changed since it was opened', async () => {
    const { panel } = await openQueued((api) => {
      api.updateTicket = () => Promise.reject(new ApiRequestError(409, 'conflict', 'changed'));
    });
    fireEvent.click(panel.getByRole('button', { name: 'Edit ticket' }));
    const form = within(panel.getByRole('form', { name: 'Edit ticket' }));
    fireEvent.change(form.getByLabelText('Title'), { target: { value: 'Other' } });
    fireEvent.click(form.getByRole('button', { name: 'Save' }));
    expect(await form.findByText(/This ticket changed since you opened it/)).toBeTruthy();
    expect(form.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('has no Edit when the Queued column is read-only', async () => {
    const { panel } = await openQueued((api) => {
      const get = api.getTicket.bind(api);
      api.getTicket = async (id) => ({ ...(await get(id)), editable: false });
    });
    expect(panel.queryByRole('button', { name: 'Edit ticket' })).toBeNull();
    expect(panel.getByText("The Queued column doesn't allow editing the ticket.")).toBeTruthy();
  });
});

describe('a session panel', () => {
  async function open(title: string) {
    const api = createMockApi({ replyDelayMs: 0 });
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: title }));
    return within(await screen.findByRole('complementary', { name: 'Session detail' }));
  }

  it('offers Edit ticket in a human column', async () => {
    const panel = await open('Add audit log table');
    fireEvent.click(await panel.findByRole('button', { name: 'Edit ticket' }));
    await waitFor(() => expect(panel.getByRole('form', { name: 'Edit ticket' })).toBeTruthy());
  });

  it('not in an agent column (the default)', async () => {
    const panel = await open('Add pagination to /orders');
    await panel.findByRole('log');
    expect(panel.queryByRole('button', { name: 'Edit ticket' })).toBeNull();
  });
});
