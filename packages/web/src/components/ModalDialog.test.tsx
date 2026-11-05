// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModalDialog } from './ModalDialog.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** An opener that unmounts itself on click (like a menu item), and a fallback to return to. */
function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(true);
  const fallback = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={fallback}>Account</button>
      <button onClick={() => setOpen(true)}>Open</button>
      {menu && (
        <button
          onClick={() => {
            setMenu(false);
            setOpen(true);
          }}
        >
          Menu item
        </button>
      )}
      {open && (
        <ModalDialog
          label="Thing"
          returnFocus={fallback}
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
        >
          <input aria-label="Field" autoFocus />
          <button onClick={() => setOpen(false)}>Done</button>
        </ModalDialog>
      )}
    </>
  );
}

describe('ModalDialog (UXR-51)', () => {
  it('opens with showModal and is an open dialog with its name', () => {
    // jsdom has no showModal: give it one, as a browser would.
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      value: showModal,
      configurable: true,
    });
    try {
      render(<Harness />);
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      const dialog = screen.getByRole<HTMLDialogElement>('dialog', { name: 'Thing' });
      expect(dialog.tagName).toBe('DIALOG');
      expect(dialog.open).toBe(true);
      expect(showModal).toHaveBeenCalledTimes(1);
    } finally {
      delete (HTMLDialogElement.prototype as { showModal?: unknown }).showModal;
    }
  });

  it('Esc (the cancel event) calls onClose and is default-prevented', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const cancel = new Event('cancel', { cancelable: true });
    fireEvent(screen.getByRole('dialog'), cancel);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(cancel.defaultPrevented).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('returns focus to the opener on close', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Field' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(document.activeElement).toBe(opener);
  });

  it('falls back to returnFocus when the opener is gone', () => {
    render(<Harness />);
    const item = screen.getByRole('button', { name: 'Menu item' });
    item.focus();
    fireEvent.click(item);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Account' }));
  });
});
