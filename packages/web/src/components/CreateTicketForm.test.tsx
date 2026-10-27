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
  beforeAll(async () => {
    undo = installEditorPolyfills();
    // QA (PR #10): a cold lazy import of BlockNote can take longer than findBy's 1 s default.
    await import('./ticket-editor/RichTicketEditor.js');
  });
  afterAll(() => undo());

  const description = () =>
    screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Description' });
  const toggle = () => screen.getByRole('button', { name: 'Plain markdown' });
  async function richEditor() {
    await screen.findByRole('heading', { name: 'Goal' }, { timeout: 10_000 });
    return screen.getByRole('textbox', { name: 'Description' });
  }
  // "Types" into a rich-editor line: ProseMirror reads DOM edits through its mutation observer.
  // The short wait lets it do so while staying well inside the 250 ms export debounce.
  async function typeLine(editor: HTMLElement, from: string, to: string) {
    within(editor).getByText(from).textContent = to;
    await new Promise((r) => setTimeout(r, 20));
  }
  const GOAL = 'One or two sentences: what changes, and for whom.';

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

  it('submit flushes the debounced export: no focus change, no stale text (QA #6)', async () => {
    const { sent, state, submit } = setup();
    fireEvent.click(screen.getByRole('radio', { name: 'Work' }));
    const editor = await richEditor();
    await new Promise((r) => setTimeout(r, 300)); // let the initial load's export settle
    await typeLine(editor, GOAL, 'Typed just before submitting.');
    fireEvent.click(submit); // no blur: jsdom doesn't move focus on click
    await waitFor(() => expect(state.created).toBe(true));
    expect((sent[0] as { body: string }).body).toContain(
      '## Goal\n\nTyped just before submitting.',
    );
  });

  it('a pending export never writes old text back after the form resets (QA #6)', async () => {
    const api = createMockApi();
    let release = () => {};
    const create = api.createTicket.bind(api);
    api.createTicket = async (req) => {
      await new Promise<void>((r) => (release = r));
      return create(req);
    };
    render(<CreateTicketForm api={api} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'T' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Work' }));
    const editor = await richEditor();
    await typeLine(editor, GOAL, 'First version.');
    fireEvent.click(screen.getByRole('button', { name: 'Create ticket' }));
    // Typing while the request is in flight leaves an export timer pending...
    await typeLine(editor, 'First version.', 'Typed while saving.');
    release();
    // ...the form resets (new editor on the template) and the old timer must not fire into it.
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Title' }).value).toBe(''),
    );
    await new Promise((r) => setTimeout(r, 400));
    fireEvent.click(toggle());
    expect(normaliseMarkdown(description().value)).toBe(normaliseMarkdown(TICKET_TEMPLATE));
  });

  it('typed <x> survives rich → plain → rich (QA #2)', async () => {
    setup();
    const editor = await richEditor();
    await typeLine(editor, GOAL, 'Continue on <machine> in C:\\tmp.');
    fireEvent.click(toggle());
    expect(description().value).toContain('## Goal\n\nContinue on \\<machine> in C:\\\\tmp.');
    fireEvent.click(toggle());
    const again = await richEditor();
    expect(within(again).getByText('Continue on <machine> in C:\\tmp.')).toBeTruthy();
    fireEvent.click(toggle());
    expect(description().value).toContain('Continue on \\<machine> in C:\\\\tmp.');
  });

  it.each([
    ['text/plain', 'Continue on <machine>'],
    ['text/markdown', 'Set <app>-ratelimit'],
  ])('pasting %s keeps <…> text (QA #2)', async (type, text) => {
    setup();
    const editor = await richEditor();
    const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { types: [type], getData: (t: string) => (t === type ? text : '') },
    });
    fireEvent(editor, paste);
    await waitFor(() => expect(editor.textContent).toContain(text));
  });
});
