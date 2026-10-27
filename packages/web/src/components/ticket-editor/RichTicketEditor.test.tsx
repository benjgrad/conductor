// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installEditorPolyfills } from './jsdom-polyfills.js';
import RichTicketEditor, { type RichEditorHandle } from './RichTicketEditor.js';

afterEach(cleanup);

describe('RichTicketEditor export debounce (UX-3, QA #6)', () => {
  let undo = () => {};
  beforeAll(() => {
    undo = installEditorPolyfills();
  });
  afterAll(() => undo());

  async function mount() {
    const calls: string[] = [];
    const handle = createRef<RichEditorHandle>();
    const view = render(
      <RichTicketEditor
        initialMarkdown={'## Goal\n\nFirst.\n'}
        onChange={(md) => calls.push(md)}
        ref={handle}
      />,
    );
    await screen.findByRole('heading', { name: 'Goal' }, { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 300)); // the initial load's export
    calls.length = 0;
    const editor = screen.getByRole('textbox', { name: 'Description' });
    within(editor).getByText('First.').textContent = 'Second.';
    await new Promise((r) => setTimeout(r, 20)); // ProseMirror reads the DOM edit
    return { calls, handle, view };
  }

  it('a pending export is dropped on unmount, never written back later', async () => {
    const { calls, view } = await mount();
    view.unmount();
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toEqual([]);
  });

  it('flush() exports the pending edit synchronously, once', async () => {
    const { calls, handle } = await mount();
    expect(handle.current?.flush()).toBe('## Goal\n\nSecond.\n');
    expect(calls).toEqual(['## Goal\n\nSecond.\n']);
    expect(handle.current?.flush()).toBeNull();
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toHaveLength(1);
  });
});
