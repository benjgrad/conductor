// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { TransitionButtons } from './transitions.js';

// ADR-0037 P5: a text button with `presets` shows them as chips that fill the box (editable); the
// post is the box's text, as for any text button.

const PRESET = {
  slug: 'resync_main',
  label: 'Resync main',
  text: 'Run git merge origin/main and finish again.',
};
const option = (presets?: (typeof PRESET)[]) => ({
  name: 'request_changes',
  title: 'Request changes',
  goto: 'implementing',
  needs_text: true,
  ...(presets ? { presets } : {}),
});

function setup(presets?: (typeof PRESET)[]) {
  const transition = vi.fn(() => Promise.resolve({}));
  const api = { transition } as unknown as ApiClient;
  render(<TransitionButtons api={api} sessionId="s1" options={[option(presets)]} />);
  fireEvent.click(screen.getByRole('button', { name: /Request changes/ }));
  return { transition, form: within(screen.getByRole('form', { name: 'Request changes' })) };
}

describe('preset chips on a text button', () => {
  afterEach(cleanup);

  it('a chip fills the box; the text stays editable and is what is posted', async () => {
    const { transition, form } = setup([PRESET]);
    const chips = form.getByRole('group', { name: 'Saved instructions' });
    fireEvent.click(within(chips).getByRole('button', { name: 'Resync main' }));
    const box = form.getByRole<HTMLTextAreaElement>('textbox');
    expect(box.value).toBe(PRESET.text);
    fireEvent.change(box, { target: { value: `${PRESET.text} Then rerun CI.` } });
    fireEvent.click(form.getByRole('button', { name: 'Request changes' }));
    await waitFor(() => expect(transition).toHaveBeenCalledTimes(1));
    expect(transition).toHaveBeenCalledWith('s1', {
      name: 'request_changes',
      text: `${PRESET.text} Then rerun CI.`,
    });
  });

  it('no presets, no chips', () => {
    const { form } = setup();
    expect(form.queryByRole('group', { name: 'Saved instructions' })).toBeNull();
  });
});
