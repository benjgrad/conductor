import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

const FOCUSABLE =
  'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

interface ModalDialogProps {
  /** The dialog's name: `aria-labelledby` (a heading's id) or `aria-label`. */
  labelledBy?: string;
  label?: string;
  className?: string;
  /** Esc, through the dialog's `cancel` event. The caller's own Close/Cancel call it too. */
  onClose: () => void;
  /** Focused after close when the element focused at open is gone (e.g. a menu item). */
  returnFocus?: RefObject<HTMLElement | null> | undefined;
  children: ReactNode;
}

/**
 * UXR-51: a native `<dialog>` opened with `showModal()`. Mounted means open: the parent renders it
 * while open and unmounts it to close. `showModal()` gives the backdrop and makes the rest of the
 * page inert, so Tab stays inside; Esc fires `cancel`, which becomes `onClose`. On close, focus goes
 * back to whatever was focused when it opened, or to `returnFocus` if that element is gone.
 *
 * A click on the backdrop does not close it: a half-typed form shouldn't vanish on a stray click.
 */
export function ModalDialog({
  labelledBy,
  label,
  className = 'modal',
  onClose,
  returnFocus,
  children,
}: ModalDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  // Read at the first render: a child's autoFocus runs before this component's effects.
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null,
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // jsdom has no showModal(); `open` is what makes it rendered (and found by role) there.
    if (typeof el.showModal === 'function') {
      if (!el.open) el.showModal();
    } else {
      el.setAttribute('open', '');
    }
    // A child's autoFocus ran while the dialog was still closed (not focusable) and was lost.
    // Browsers focus the first focusable element in showModal(); do the same everywhere.
    if (!el.contains(document.activeElement)) {
      el.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }
    return () => {
      if (typeof el.close === 'function' && el.open) el.close();
      // The fallback's element at close time is the one wanted, not the one at open.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const target = opener?.isConnected ? opener : returnFocus?.current;
      target?.focus();
    };
    // `returnFocus` is a ref object: stable for the dialog's life.
  }, [opener, returnFocus]);

  return (
    <dialog
      ref={ref}
      className={className}
      {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
      {...(label ? { 'aria-label': label } : {})}
      onCancel={(e) => {
        // React state stays the one source of truth: the parent unmounts us, and that closes it.
        e.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}
