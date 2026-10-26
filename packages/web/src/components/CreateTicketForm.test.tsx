// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockApi } from '../api/mock.js';
import { CreateTicketForm } from './CreateTicketForm.js';

afterEach(cleanup);

function setup() {
  const api = createMockApi();
  const sent: unknown[] = [];
  const create = api.createTicket.bind(api);
  api.createTicket = (req) => {
    sent.push(req);
    return create(req);
  };
  const state = { created: false };
  render(<CreateTicketForm api={api} onCreated={() => (state.created = true)} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
    target: { value: 'Fix the login bug' },
  });
  const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Create ticket' });
  return { sent, state, submit };
}

describe('CreateTicketForm (ADR-0010, ADR-0011)', () => {
  it('has no workflow picker and creates the ticket on conductor with its kind', async () => {
    const { sent, state, submit } = setup();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(/workflow/i)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Personal' }));
    fireEvent.click(submit);
    await waitFor(() => expect(state.created).toBe(true));
    expect(sent).toEqual([expect.objectContaining({ workflow_id: 'conductor', kind: 'personal' })]);
  });

  it("can't submit without a Work / Personal choice", async () => {
    const { sent, submit } = setup();
    const radios = screen.getAllByRole<HTMLInputElement>('radio');
    expect(radios.map((r) => r.labels?.[0]?.textContent)).toEqual(['Work', 'Personal']);
    expect(radios.every((r) => !r.checked && r.required)).toBe(true);
    expect(submit.disabled).toBe(true);
    // Even a forced submit (Enter in a field) sends nothing.
    fireEvent.submit(screen.getByRole('form', { name: 'Create ticket' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole('radio', { name: 'Work' }));
    expect(submit.disabled).toBe(false);
  });
});
