// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMockApi } from '../api/mock.js';
import { CreateTicketForm } from './CreateTicketForm.js';
import ticketBody from './ticket-editor/fixtures/ux-3-ticket.md?raw';
import { installEditorPolyfills } from './ticket-editor/jsdom-polyfills.js';
import { normaliseMarkdown } from './ticket-editor/markdown-io.js';
import { TICKET_SECTIONS, TICKET_TEMPLATE } from './ticket-editor/template.js';

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

describe('ticket body editor (UX-3)', () => {
  let undo = () => {};
  beforeAll(() => {
    undo = installEditorPolyfills();
  });
  afterAll(() => undo());

  const description = () =>
    screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Description' });
  const toggle = () => screen.getByRole('button', { name: 'Plain markdown' });
  async function richEditor() {
    await screen.findByRole('heading', { name: 'Goal' });
    return screen.getByRole('textbox', { name: 'Description' });
  }

  it('starts from the template in the rich editor, with the six section headings (FR-2)', async () => {
    setup();
    const editor = await richEditor();
    expect(editor.tagName).not.toBe('TEXTAREA');
    expect(editor.getAttribute('contenteditable')).toBe('true');
    for (const name of TICKET_SECTIONS) {
      expect(within(editor).getByRole('heading', { name })).toBeTruthy();
    }
    expect(within(editor).getAllByRole('table')).toHaveLength(1);
    // Placeholders are greyed by a decoration, not stored as styling.
    expect(editor.querySelector('.ticket-placeholder')?.textContent).toBe(
      'One or two sentences: what changes, and for whom.',
    );
  });

  it('"Plain markdown" switches to a textarea with the same markdown, and back (FR-2)', async () => {
    setup();
    await richEditor();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    const plain = description();
    expect(plain.tagName).toBe('TEXTAREA');
    expect(normaliseMarkdown(plain.value)).toBe(normaliseMarkdown(TICKET_TEMPLATE));

    // Markdown in: this ticket's own body, then back to the rich editor and out again.
    fireEvent.change(plain, { target: { value: ticketBody } });
    fireEvent.click(toggle());
    const editor = await screen.findByRole('heading', { name: 'Verification' });
    expect(editor).toBeTruthy();
    expect(screen.getByText("NFR-8 Works with the app's dark theme.")).toBeTruthy();
    fireEvent.click(toggle());
    expect(normaliseMarkdown(description().value)).toBe(normaliseMarkdown(ticketBody));
  });

  it('submits markdown, without the untouched placeholders (FR-3)', async () => {
    const { sent, state, submit } = setup();
    await richEditor();
    fireEvent.click(toggle());
    const md = TICKET_TEMPLATE.replace('- FR-1 …', '- FR-1 **Bold** `code` [link](https://x.dev)');
    fireEvent.change(description(), { target: { value: md } });
    fireEvent.click(screen.getByRole('radio', { name: 'Work' }));
    fireEvent.click(submit);
    await waitFor(() => expect(state.created).toBe(true));
    const body = (sent[0] as { body: string }).body;
    expect(body).toContain(
      '## Functional requirements\n- FR-1 **Bold** `code` [link](https://x.dev)',
    );
    expect(body).not.toContain('NFR-1 …');
  });

  it('an untouched template submits an empty body', async () => {
    const { sent, state, submit } = setup();
    await richEditor();
    fireEvent.click(screen.getByRole('radio', { name: 'Personal' }));
    fireEvent.click(submit);
    await waitFor(() => expect(state.created).toBe(true));
    expect(sent).toEqual([expect.objectContaining({ body: '' })]);
  });

  it('shows requirement hints that never block submit (FR-4, NFR-3)', async () => {
    const { state, submit } = setup();
    const hintsButton = screen.getByRole('button', { name: 'Hints (1)' });
    expect(screen.getByText('No functional requirements yet')).toBeTruthy();
    expect(hintsButton.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(hintsButton);
    expect(hintsButton.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('No functional requirements yet').closest('ul')?.hidden).toBe(true);
    fireEvent.click(hintsButton);

    await richEditor();
    fireEvent.click(toggle());
    fireEvent.change(description(), {
      target: {
        value: TICKET_TEMPLATE.replace('- FR-1 …', '- FR-1 a\n- FR-2 b'),
      },
    });
    expect(screen.getByText('FR-2 has no verification')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Work' }));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(state.created).toBe(true));
  });

  it('edits in the rich editor reach the submitted body', async () => {
    const { sent, state, submit } = setup();
    const editor = await richEditor();
    const goal = within(editor).getByText('One or two sentences: what changes, and for whom.');
    goal.textContent = 'Make tickets easy to write.';
    // ProseMirror picks up DOM edits through its mutation observer; leaving the editor flushes.
    await waitFor(() =>
      expect(within(editor).queryByText('Make tickets easy to write.')).toBeTruthy(),
    );
    fireEvent.blur(editor);
    fireEvent.click(screen.getByRole('radio', { name: 'Work' }));
    fireEvent.click(submit);
    await waitFor(() => expect(state.created).toBe(true));
    expect((sent[0] as { body: string }).body).toContain('## Goal\n\nMake tickets easy to write.');
  });
});
