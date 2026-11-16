// @vitest-environment jsdom
// The description field's phone layout: a preview that opens the editor full screen. BlockNote is
// stubbed (RichTicketEditor.test.tsx and CreateTicketForm.test.tsx cover the real one), so this
// only tests the field's own behaviour.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockViewport, type MockViewport } from '../../test/match-media.js';
import type { RichEditorHandle } from './RichTicketEditor.js';
import { previewText, TicketBodyField } from './TicketBodyField.js';

vi.mock('./RichTicketEditor.js', () => ({
  default: function StubEditor({
    initialMarkdown,
    onChange,
    ref,
  }: {
    initialMarkdown: string;
    onChange: (md: string) => void;
    ref?: Ref<RichEditorHandle>;
  }) {
    const text = useRef(initialMarkdown);
    const pending = useRef(false);
    useImperativeHandle(ref, () => ({
      flush() {
        if (!pending.current) return null;
        pending.current = false;
        onChange(text.current);
        return text.current;
      },
    }));
    return (
      <div className="ticket-body-rich-stub">
        <textarea
          aria-label="Rich description"
          defaultValue={initialMarkdown}
          onChange={(e) => {
            text.current = e.target.value;
            pending.current = true;
          }}
        />
      </div>
    );
  },
}));

let viewport: MockViewport | null = null;
afterEach(() => {
  cleanup();
  viewport?.restore();
  viewport = null;
});

function Field({ initial = '', resetKey = 0 }: { initial?: string; resetKey?: number }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <TicketBodyField value={value} onChange={setValue} resetKey={resetKey} />
      <output data-testid="value">{value}</output>
    </>
  );
}

describe('previewText', () => {
  it('drops markdown syntax and blank lines', () => {
    expect(
      previewText(
        '<!-- hint -->\n## Goal\n\nShip **it**.\n\n- one\n- [ ] two\n1. three\n\n| a | b |\n| --- | --- |\n| c | d |\n',
      ),
    ).toBe('Goal\nShip it.\none\ntwo\nthree\na · b\nc · d');
  });
  it('is empty for an empty or whitespace body', () => {
    expect(previewText('')).toBe('');
    expect(previewText('\n  \n<!-- x -->\n')).toBe('');
  });
});

describe('TicketBodyField on desktop', () => {
  it('shows the editor inline with the Plain markdown toggle, and no preview', async () => {
    viewport = mockViewport(1200);
    render(<Field initial="## Goal" />);
    expect(await screen.findByRole('textbox', { name: 'Rich description' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Plain markdown' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit description' })).toBeNull();
  });
});

describe('TicketBodyField on a phone', () => {
  it('shows a preview of the body instead of an inline editor', () => {
    viewport = mockViewport(375);
    render(<Field initial={'## Goal\n\nShip it.'} />);
    const preview = screen.getByRole('button', { name: 'Edit description' });
    expect(preview.textContent).toBe('Goal\nShip it.');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Plain markdown' })).toBeNull();
  });

  it('an empty body says "Add a description"', () => {
    viewport = mockViewport(375);
    render(<Field />);
    expect(screen.getByRole('button', { name: 'Edit description' }).textContent).toBe(
      'Add a description',
    );
  });

  it('opens the editor full screen; Done saves the edit, closes, and refocuses the preview', async () => {
    viewport = mockViewport(375);
    render(<Field initial="Old." />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit description' }));
    const dialog = screen.getByRole('dialog', { name: 'Description' });
    expect(dialog.className).toBe('ticket-body-full');
    const done = screen.getByRole('button', { name: 'Done' });
    expect(document.activeElement).toBe(done);
    expect(screen.getByRole('button', { name: 'Plain markdown' })).toBeTruthy();
    const editor = await screen.findByRole('textbox', { name: 'Rich description' });
    fireEvent.change(editor, { target: { value: 'New.' } });
    fireEvent.click(done);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('value').textContent).toBe('New.');
    const preview = screen.getByRole('button', { name: 'Edit description' });
    expect(preview.textContent).toBe('New.');
    expect(document.activeElement).toBe(preview);
  });

  it('Escape saves and closes only the editor: the event is marked handled for the sheet', async () => {
    viewport = mockViewport(375);
    const outer = vi.fn((e: KeyboardEvent) => e.defaultPrevented);
    window.addEventListener('keydown', outer);
    try {
      render(<Field initial="Old." />);
      fireEvent.click(screen.getByRole('button', { name: 'Edit description' }));
      const editor = await screen.findByRole('textbox', { name: 'Rich description' });
      fireEvent.change(editor, { target: { value: 'Esc.' } });
      fireEvent.keyDown(editor, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByTestId('value').textContent).toBe('Esc.');
      // stopPropagation: a sheet's window-level Escape never sees it.
      expect(outer).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', outer);
    }
  });

  it('Plain markdown in the full-screen header swaps to the textarea', async () => {
    viewport = mockViewport(375);
    render(<Field initial="Body." />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit description' }));
    await screen.findByRole('textbox', { name: 'Rich description' });
    fireEvent.click(screen.getByRole('button', { name: 'Plain markdown' }));
    const plain = screen.getByRole('textbox', { name: 'Description' });
    expect(plain.tagName).toBe('TEXTAREA');
    expect((plain as HTMLTextAreaElement).value).toBe('Body.');
    expect(plain.closest('.ticket-body-full')).not.toBeNull();
  });

  it('a form reset closes the full-screen editor', async () => {
    viewport = mockViewport(375);
    const view = render(<Field initial="Body." resetKey={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit description' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => view.rerender(<Field initial="Body." resetKey={1} />));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('ticket-editor.css on a phone', () => {
  // UXR-02: iOS zooms into any editable under 16 px, which leaves the page off-centre.
  it('the full-screen editor and the preview use 16 px text', () => {
    const css = readFileSync(join(import.meta.dirname, 'ticket-editor.css'), 'utf8');
    const phone = css.slice(css.indexOf('@media (max-width: 899.98px)'));
    expect(phone).toMatch(
      /\.ticket-body-full \.ticket-body-rich,\s*\.ticket-body-full \.ticket-body-plain \{[^}]*font-size: var\(--text-lg\)/,
    );
    expect(phone).toMatch(/\.ticket-body-rich \.bn-editor \{[^}]*font-size: var\(--text-lg\)/);
    expect(phone).toMatch(/\.ticket-body-preview \{[^}]*font-size: var\(--text-lg\)/);
  });
});
