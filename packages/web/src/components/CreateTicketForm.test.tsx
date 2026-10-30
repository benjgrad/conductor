// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CreateTicketRequest, RepoSuggestion } from '@conductor/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMockApi } from '../api/mock.js';
import { CreateTicketForm } from './CreateTicketForm.js';
import ticketBody from './ticket-editor/fixtures/ux-3-ticket.md?raw';
import { installEditorPolyfills } from './ticket-editor/jsdom-polyfills.js';
import { normaliseMarkdown } from './ticket-editor/markdown-io.js';
import { TICKET_SECTIONS, TICKET_TEMPLATE } from './ticket-editor/template.js';

afterEach(cleanup);

async function setup() {
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
  // The Repo field fills in from GET /api/repos.
  await waitFor(() => expect(repoBox().value).not.toBe(''));
  return { sent, state, submit };
}

const repoBox = () => screen.getByRole<HTMLInputElement>('combobox', { name: 'Repo' });

describe('CreateTicketForm (ADR-0010, ADR-0011)', () => {
  it('has no workflow picker and creates the ticket on conductor with its kind', async () => {
    const { sent, state, submit } = await setup();
    expect(screen.queryByRole('combobox', { name: /workflow/i })).toBeNull();
    expect(screen.queryByText(/workflow/i)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Personal' }));
    fireEvent.click(submit);
    await waitFor(() => expect(state.created).toBe(true));
    expect(sent).toEqual([expect.objectContaining({ workflow_id: 'conductor', kind: 'personal' })]);
  });

  it("can't submit without a Work / Personal choice", async () => {
    const { sent, submit } = await setup();
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

const REPOS: RepoSuggestion[] = [
  { repo: 'github.com/o/top', ticket_count: 5, last_used_at: '2026-10-29T00:00:00Z' },
  { repo: 'github.com/o/second', ticket_count: 1, last_used_at: '2026-10-01T00:00:00Z' },
  { repo: 'github.com/acme/shop', ticket_count: 0, last_used_at: null },
];

/** The form on a mock whose GET /api/repos answers `list` (or never, or fails). */
function renderWith(list: Promise<RepoSuggestion[]>, opts: { sheet?: boolean } = {}) {
  const api = createMockApi();
  api.listRepos = () => list;
  const sent: CreateTicketRequest[] = [];
  const create = api.createTicket.bind(api);
  api.createTicket = (req) => {
    sent.push(req);
    return create(req);
  };
  const closed = { count: 0 };
  render(
    <CreateTicketForm api={api} sheet={opts.sheet ?? false} onClose={() => (closed.count += 1)} />,
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'T' } });
  fireEvent.click(screen.getByRole('radio', { name: 'Work' }));
  return { sent, closed };
}

const optionNames = () =>
  screen.queryAllByRole('option').map((o) => o.querySelector('.repo-name')?.textContent);

describe('Repo field (searchable, most used first)', () => {
  it('defaults to the top repo and lists every repo in ranked order', async () => {
    renderWith(Promise.resolve(REPOS));
    await waitFor(() => expect(repoBox().value).toBe('github.com/o/top'));
    fireEvent.focus(repoBox());
    expect(repoBox().getAttribute('aria-expanded')).toBe('true');
    expect(optionNames()).toEqual(REPOS.map((r) => r.repo));
    expect(screen.getByText('5 tickets')).toBeTruthy();
  });

  it('typing filters; ArrowDown + Enter picks without submitting', async () => {
    const { sent } = renderWith(Promise.resolve(REPOS));
    await waitFor(() => expect(repoBox().value).toBe('github.com/o/top'));
    fireEvent.change(repoBox(), { target: { value: 'O/SEC' } });
    expect(optionNames()).toEqual(['github.com/o/second']);
    fireEvent.keyDown(repoBox(), { key: 'ArrowDown' });
    expect(repoBox().getAttribute('aria-activedescendant')).toBe(screen.getByRole('option').id);
    fireEvent.keyDown(repoBox(), { key: 'Enter' });
    expect(repoBox().value).toBe('github.com/o/second');
    expect(screen.queryByRole('listbox')).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.repo).toBe('github.com/o/second');
  });

  it('a click picks an option', async () => {
    renderWith(Promise.resolve(REPOS));
    await waitFor(() => expect(repoBox().value).toBe('github.com/o/top'));
    fireEvent.focus(repoBox());
    fireEvent.click(screen.getByRole('option', { name: /acme\/shop/ }));
    expect(repoBox().value).toBe('github.com/acme/shop');
  });

  it('a repo not in the list submits as typed', async () => {
    const { sent } = renderWith(Promise.resolve(REPOS));
    await waitFor(() => expect(repoBox().value).toBe('github.com/o/top'));
    fireEvent.change(repoBox(), { target: { value: 'github.com/o/brand-new' } });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.repo).toBe('github.com/o/brand-new');
  });

  it('what the user typed before the list arrived is kept', async () => {
    let resolve: (list: RepoSuggestion[]) => void = () => {};
    renderWith(new Promise((r) => (resolve = r)));
    fireEvent.change(repoBox(), { target: { value: 'github.com/o/mine' } });
    resolve(REPOS);
    await waitFor(() => expect(optionNames()).toHaveLength(0));
    fireEvent.change(repoBox(), { target: { value: 'github.com/o/' } });
    expect(optionNames()).toHaveLength(2);
    expect(repoBox().value).toBe('github.com/o/');
  });

  it('works as a plain field when the list fails to load', async () => {
    const { sent } = renderWith(Promise.reject(new Error('offline')));
    await new Promise((r) => setTimeout(r, 0));
    expect(repoBox().value).toBe('');
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Create ticket' });
    expect(submit.disabled).toBe(true);
    fireEvent.change(repoBox(), { target: { value: 'github.com/o/app' } });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(submit);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.repo).toBe('github.com/o/app');
  });

  it('in the sheet, Escape closes the list first, then the sheet', async () => {
    const { closed } = renderWith(Promise.resolve(REPOS), { sheet: true });
    await waitFor(() => expect(repoBox().value).toBe('github.com/o/top'));
    fireEvent.focus(repoBox());
    fireEvent.keyDown(repoBox(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(closed.count).toBe(0);
    fireEvent.keyDown(repoBox(), { key: 'Escape' });
    expect(closed.count).toBe(1);
  });

  it('the mock ranks the seeded repos and fills the field', async () => {
    await setup();
    expect(repoBox().value).toBe((await createMockApi().listRepos())[0]!.repo);
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
    await setup();
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
    await setup();
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
    const { sent, state, submit } = await setup();
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
    const { sent, state, submit } = await setup();
    await richEditor();
    fireEvent.click(screen.getByRole('radio', { name: 'Personal' }));
    fireEvent.click(submit);
    await waitFor(() => expect(state.created).toBe(true));
    expect(sent).toEqual([expect.objectContaining({ body: '' })]);
  });

  it('shows requirement hints that never block submit (FR-4, NFR-3)', async () => {
    const { state, submit } = await setup();
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
    const { sent, state, submit } = await setup();
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
    const { sent, state, submit } = await setup();
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
    await setup();
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
    await setup();
    const editor = await richEditor();
    const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { types: [type], getData: (t: string) => (t === type ? text : '') },
    });
    fireEvent(editor, paste);
    await waitFor(() => expect(editor.textContent).toContain(text));
  });
});
