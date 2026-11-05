// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sheet } from './Sheet.js';

afterEach(cleanup);

function Harness({ onClose, ariaLabel }: { onClose?: () => void; ariaLabel?: string | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        opener
      </button>
      {open && (
        <Sheet
          title="Things"
          ariaLabel={ariaLabel}
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
        >
          <button type="button">first</button>
          <input
            aria-label="field"
            onKeyDown={(e) => {
              if (e.key === 'Escape') e.preventDefault();
            }}
          />
          <button type="button">last</button>
        </Sheet>
      )}
    </>
  );
}

function openSheet(props: Parameters<typeof Harness>[0] = {}) {
  render(<Harness {...props} />);
  const opener = screen.getByRole('button', { name: 'opener' });
  opener.focus();
  fireEvent.click(opener);
  return { opener, dialog: screen.getByRole('dialog') };
}

describe('Sheet (UXR-47)', () => {
  it('is a modal dialog named by its heading, or by ariaLabel', () => {
    const { dialog } = openSheet();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'Things' })).toBe(dialog);
    cleanup();
    openSheet({ ariaLabel: 'Machine x' });
    expect(screen.getByRole('dialog', { name: 'Machine x' })).toBeTruthy();
  });

  it('focuses Close on open and gives focus back to the opener on close', () => {
    const { opener } = openSheet();
    const close = screen.getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('Escape closes it, unless an inner widget took the Escape', () => {
    const onClose = vi.fn();
    openSheet({ onClose });
    fireEvent.keyDown(screen.getByLabelText('field'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('button', { name: 'first' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a pointerdown outside the panel closes it; one inside does not', () => {
    const onClose = vi.fn();
    openSheet({ onClose });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'first' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.querySelector('.side-sheet-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
    const again = vi.fn();
    openSheet({ onClose: again });
    fireEvent.pointerDown(document.body);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('keeps focus inside: Tab wraps from last to Close, Shift+Tab from Close to last', () => {
    const { dialog } = openSheet();
    const close = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: 'last' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
