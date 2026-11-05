// UXR-47 (11-web-ui §Sheet): the shared side panel. Right-hand below the top bar on desktop, with
// a backdrop; full screen on a phone. A modal dialog: focus moves to Close and stays inside, Esc
// and a pointerdown outside the panel close it, and focus returns to the opener.
import { X } from 'lucide-react';
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './Sheet.css';

export interface SheetProps {
  /** The visible heading. */
  title: ReactNode;
  onClose: () => void;
  /** Overrides the accessible name (default: the heading). */
  ariaLabel?: string | undefined;
  /** Extra class on the panel, for its content's styles. */
  className?: string | undefined;
  children: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The panel's focusable elements, in DOM order (hidden ones are skipped where layout exists). */
function focusables(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest('[hidden]'),
  );
}

export function Sheet({ title, onClose, ariaLabel, className, children }: SheetProps) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const target = e.target;
      if (target instanceof Node && panel.current?.contains(target)) return;
      onCloseRef.current();
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      if (e.defaultPrevented) return;
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !panel.current) return;
    const items = focusables(panel.current);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (!panel.current.contains(active)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="side-sheet-root">
      <div className="side-sheet-backdrop" aria-hidden="true" />
      <div
        ref={panel}
        className={className ? `side-sheet ${className}` : 'side-sheet'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabel === undefined ? id : undefined}
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
      >
        <div className="side-sheet-head">
          <h2 id={id}>{title}</h2>
          <button
            ref={close}
            type="button"
            className="side-sheet-close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div className="side-sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
