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

describe('a queued ticket: routing, priority, cancel (UXR-34, UXR-42, UXR-86)', () => {
  async function openSeeded(title: string) {
    const api = createMockApi({ replyDelayMs: 0 });
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: title }));
    const panel = within(await screen.findByRole('complementary', { name: 'Ticket detail' }));
    await panel.findByText('Repo');
    return { api, panel };
  }

  it('says why no machine can take it, links to Machines, and shows no empty description', async () => {
    const { panel } = await openSeeded('Hotfix: crash on empty cart');
    const note = panel.getByRole('status');
    expect(note.textContent).toBe(
      'No machine can take this: needs acme/shop and az (signed in). Machines ›',
    );
    expect(within(note).getByRole('link', { name: 'Machines ›' }).getAttribute('href')).toBe(
      '#/machines',
    );
    expect(panel.queryByText('(no description)')).toBeNull();
    expect(panel.queryByRole('heading', { name: 'Description' })).toBeNull();
  });

  it('raises and lowers the priority through PATCH', async () => {
    const patches: unknown[] = [];
    const { panel } = await openQueued((api) => {
      const update = api.updateTicket.bind(api);
      api.updateTicket = (id, req) => {
        patches.push(req);
        return update(id, req);
      };
    });
    // ADR-0036: a new ticket is P3; raising makes it more urgent (a lower number).
    await panel.findByText('P3');
    fireEvent.click(panel.getByRole('button', { name: 'Raise priority' }));
    await panel.findByText('P2');
    fireEvent.click(panel.getByRole('button', { name: 'Lower priority' }));
    await panel.findByText('P3');
    expect(patches).toEqual([
      { expected_updated_at: expect.any(String) as string, priority: 2 },
      { expected_updated_at: expect.any(String) as string, priority: 3 },
    ]);
  });

  it('stops at P1 (P0 is reserved, ADR-0036) and at P4', async () => {
    const { panel } = await openQueued();
    const raise = () => panel.getByRole<HTMLButtonElement>('button', { name: 'Raise priority' });
    const lower = () => panel.getByRole<HTMLButtonElement>('button', { name: 'Lower priority' });
    fireEvent.click(raise());
    await panel.findByText('P2');
    fireEvent.click(raise());
    await panel.findByText('P1');
    await waitFor(() => expect(raise().disabled).toBe(true));
    fireEvent.click(lower());
    await panel.findByText('P2');
    fireEvent.click(lower());
    await panel.findByText('P3');
    fireEvent.click(lower());
    await panel.findByText('P4');
    await waitFor(() => expect(lower().disabled).toBe(true));
  });

  it('cancels with a reason after a confirmation, then reopens', async () => {
    const cancels: unknown[] = [];
    const reopens: string[] = [];
    const { api, panel } = await openQueued((api) => {
      const cancel = api.cancelTicket.bind(api);
      const reopen = api.reopenTicket.bind(api);
      api.cancelTicket = (id, req) => {
        cancels.push([id, req]);
        return cancel(id, req);
      };
      api.reopenTicket = (id, req) => {
        reopens.push(id);
        return reopen(id, req);
      };
    });

    // Keep ticket closes the confirmation without a call.
    fireEvent.click(panel.getByRole('button', { name: 'Cancel ticket…' }));
    fireEvent.click(panel.getByRole('button', { name: 'Keep ticket' }));
    expect(panel.queryByRole('alertdialog', { name: 'Cancel ticket' })).toBeNull();
    expect(cancels).toEqual([]);

    fireEvent.click(panel.getByRole('button', { name: 'Cancel ticket…' }));
    const confirm = within(panel.getByRole('alertdialog', { name: 'Cancel ticket' }));
    fireEvent.change(confirm.getByLabelText('Reason (optional)'), {
      target: { value: '  Duplicate  ' },
    });
    fireEvent.click(confirm.getByRole('button', { name: 'Cancel ticket' }));
    await panel.findByText('Cancelled.');
    const id = (cancels[0] as [string])[0];
    expect(cancels).toEqual([[id, { reason: 'Duplicate' }]]);
    // A cancelled ticket has no stepper and no Cancel.
    expect(panel.queryByRole('button', { name: 'Raise priority' })).toBeNull();
    expect(panel.queryByRole('button', { name: 'Cancel ticket…' })).toBeNull();

    fireEvent.click(panel.getByRole('button', { name: 'Reopen ticket' }));
    await panel.findByRole('button', { name: 'Cancel ticket…' });
    expect(reopens).toEqual([id]);
    expect((await api.getTicket(id)).status).toBe('ready');
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
