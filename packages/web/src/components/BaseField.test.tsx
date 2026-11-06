// @vitest-environment jsdom
import {
  AVAILABLE_WORKFLOW_FEATURES,
  type CreateTicketRequest,
  type WorkflowFeature,
} from '@conductor/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockApi } from '../api/mock.js';
import { SEED_IDS } from '../api/mock-data.js';
import { CreateTicketForm } from './CreateTicketForm.js';
import { TicketEditor } from './TicketEditor.js';

// ADR-0039 (B3, FR-1): the ticket's Base on the New ticket sheet and a ticket's editor. The mock's
// base-refs scene (`bases: true`) has the v7 draft's bases; `ON` is the feature switched on, as B2
// will. Without it the control is shown disabled and nothing is sent.

afterEach(cleanup);

const ON = [...AVAILABLE_WORKFLOW_FEATURES, 'bases' as const];
const SHA = 'a1b2c3d'.padEnd(40, '0');

async function setupForm(features: readonly WorkflowFeature[] = ON) {
  const api = createMockApi({ bases: true });
  const sent: CreateTicketRequest[] = [];
  const create = api.createTicket.bind(api);
  api.createTicket = (req) => {
    sent.push(req);
    return create(req);
  };
  const state = { created: 0 };
  render(
    <CreateTicketForm
      api={api}
      onCreated={() => (state.created += 1)}
      onClose={() => undefined}
      features={features}
    />,
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Fix it' } });
  fireEvent.click(screen.getByRole('radio', { name: 'Work' }));
  const base = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Base' });
  // The workflow's bases arrive from GET /api/workflows/conductor.
  await waitFor(() => expect(base.options.length).toBeGreaterThan(2));
  const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Create ticket' });
  await waitFor(() => expect(submit.disabled).toBe(false));
  return { sent, state, base, submit };
}

describe('Base on the New ticket sheet (ADR-0039, B3)', () => {
  it('offers the default (named for the kind), each base and a custom ref', async () => {
    const { base } = await setupForm();
    expect([...base.options].map((o) => o.text)).toEqual([
      'Default for this kind (sprint)',
      'default · default branch',
      'sprint · command',
      'master · master',
      'hotfix · command → PR into master',
      'Custom ref…',
    ]);
  });

  it('the default sends no base; a name sends it', async () => {
    const { sent, state, submit } = await setupForm();
    fireEvent.click(submit);
    await waitFor(() => expect(state.created).toBe(1));
    expect(sent[0]).not.toHaveProperty('base');
    // A created ticket resets the form, the Base too (a fresh control).
    const base = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Base' });
    expect(base.value).toBe('');

    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Two' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Work' }));
    fireEvent.change(base, { target: { value: 'master' } });
    fireEvent.click(submit);
    await waitFor(() => expect(state.created).toBe(2));
    expect(sent[1]).toMatchObject({ base: 'master' });
  });

  it('a custom sha needs a PR target; with one it sends {ref, pr_into}', async () => {
    const { sent, state, base, submit } = await setupForm();
    fireEvent.change(base, { target: { value: '\u0000custom' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Ref' }), { target: { value: SHA } });
    expect(screen.getByRole('alert').textContent).toMatch(/needs pr_into/);
    expect(submit.disabled).toBe(true);
    expect(screen.getByText(/Still needed: a valid base/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'PR into' }), {
      target: { value: 'master' },
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(state.created).toBe(1));
    expect(sent[0]).toMatchObject({ base: { ref: SHA, pr_into: 'master' } });
  });

  it('while bases are not available: disabled, says so, and sends nothing', async () => {
    const { sent, state, base, submit } = await setupForm(AVAILABLE_WORKFLOW_FEATURES);
    expect(base.disabled).toBe(true);
    expect(screen.getByText(/Not available yet/)).toBeTruthy();
    fireEvent.click(submit);
    await waitFor(() => expect(state.created).toBe(1));
    expect(sent[0]).not.toHaveProperty('base');
  });
});

describe('Base in the ticket editor (ADR-0039, B3)', () => {
  it('a Queued ticket’s base is editable; Save sends only the base', async () => {
    const api = createMockApi({ bases: true });
    const ticket = await api.getTicket(SEED_IDS.queuedUrgent.ticket);
    expect(ticket.base).toBe('master');
    const patches: unknown[] = [];
    const update = api.updateTicket.bind(api);
    api.updateTicket = (id, req) => {
      patches.push(req);
      return update(id, req);
    };
    let saved = false;
    render(
      <TicketEditor
        api={api}
        ticket={ticket}
        onSaved={() => (saved = true)}
        onCancel={() => undefined}
        onReload={() => undefined}
        features={ON}
      />,
    );
    const base = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Base' });
    await waitFor(() => expect(base.value).toBe('master'));
    fireEvent.change(base, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toBe(true));
    expect(patches).toEqual([{ expected_updated_at: ticket.updated_at, base: null }]);
    expect((await api.getTicket(ticket.id)).base).toBeNull();
  });

  it('a started ticket’s base is read-only, with where it started', async () => {
    const api = createMockApi({ bases: true });
    const ticket = await api.getTicket(SEED_IDS.running.ticket);
    render(
      <TicketEditor
        api={api}
        ticket={ticket}
        onSaved={() => undefined}
        onCancel={() => undefined}
        onReload={() => undefined}
        features={ON}
      />,
    );
    expect(screen.queryByRole('combobox', { name: 'Base' })).toBeNull();
    expect(screen.getByText(/Base: sprint \(ncng-26-sb-2 @ a1b2c3d\)/).textContent).toMatch(
      /fixed once the ticket started/,
    );
  });
});
