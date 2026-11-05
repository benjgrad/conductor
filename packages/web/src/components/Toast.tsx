import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import './Toast.css';

// UXR-55: one shared confirmation for completed actions ("Copied", "Invite created", "Saved as
// v4"). A single `role=status` region lives at the app root, so the live region exists before any
// text arrives. Success only: errors stay inline as `role=alert` next to what failed.

/** How long a toast stays up. */
export const TOAST_MS = 3000;

type Show = (text: string) => void;

const noop: Show = () => undefined;
const ToastContext = createContext<Show>(noop);

/** Shows a toast. Outside a `ToastProvider` it does nothing. */
export function useToast(): Show {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  // `n` re-keys the toast, so the same text twice (Copy, Copy) is announced again.
  const [toast, setToast] = useState<{ text: string; n: number } | null>(null);
  const show = useCallback<Show>((text) => {
    setToast((prev) => ({ text, n: (prev?.n ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    if (toast === null) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        className="toast-region"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label="Notifications"
      >
        {toast && (
          <div className="toast" key={toast.n}>
            {toast.text}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
