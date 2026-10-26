// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockApi } from '../api/mock.js';
import { CreateTicketForm } from './CreateTicketForm.js';

afterEach(cleanup);

describe('CreateTicketForm (ADR-0010)', () => {
  it('has no workflow picker and creates the ticket on conductor', async () => {
    const api = createMockApi();
    const sent: unknown[] = [];
    const create = api.createTicket.bind(api);
    api.createTicket = (req) => {
      sent.push(req);
      return create(req);
    };
    let created = false;
    render(<CreateTicketForm api={api} onCreated={() => (created = true)} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(/workflow/i)).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Fix the login bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => expect(created).toBe(true));
    expect(sent).toEqual([expect.objectContaining({ workflow_id: 'conductor' })]);
  });
});
