import { useEffect, useRef, useState } from 'react';
import { FEATURES, PITCH } from '../landing/content.js';
import './tour.css';

interface TourProps {
  /** The signed-in user's display name, for the greeting. */
  name: string;
  /** Skip, Done or Escape. */
  onClose: () => void;
  /** The last step's "Set up a machine" (the guided setup, `#/setup`). */
  onSetUpMachine: () => void;
}

/** The tour's pages: a welcome, one per main feature, then the first thing to do. */
export const TOUR_PAGES = FEATURES.length + 2;

/**
 * The onboarding guide: what conductor is for and its main features, one page at a time, ending
 * at the guided machine setup. A modal dialog; Escape, Skip and Done close it.
 */
export function Tour({ name, onClose, onSetUpMachine }: TourProps) {
  const [page, setPage] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  const last = page === TOUR_PAGES - 1;

  useEffect(() => {
    dialog.current?.focus();
  }, [page]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const feature = page >= 1 && page <= FEATURES.length ? FEATURES[page - 1]! : null;

  return (
    <div className="tour-backdrop">
      <div
        className="tour"
        role="dialog"
        aria-modal="true"
        aria-label="Getting started"
        tabIndex={-1}
        ref={dialog}
      >
        <p className="tour-progress" aria-live="polite">
          {page + 1} of {TOUR_PAGES}
        </p>
        {page === 0 && (
          <>
            <h2>Welcome to Conductor{name ? `, ${name}` : ''}</h2>
            <p>{PITCH}</p>
            <p>Here is what you can do with it, in a minute.</p>
          </>
        )}
        {feature && (
          <>
            <h2>{feature.title}</h2>
            <p>{feature.body}</p>
          </>
        )}
        {last && (
          <>
            <h2>Start with a machine</h2>
            <p>
              Agents run on a machine you enroll: a laptop or server with Claude Code and git. The
              guided setup gives you one install command and waits for it to connect. Then write
              your first ticket.
            </p>
          </>
        )}
        <div className="tour-dots" aria-hidden="true">
          {Array.from({ length: TOUR_PAGES }, (_, i) => (
            <span key={i} className={i === page ? 'on' : undefined} />
          ))}
        </div>
        <div className="tour-actions">
          {!last && (
            <button type="button" className="link" onClick={onClose}>
              Skip
            </button>
          )}
          <span className="tour-spacer" />
          {page > 0 && (
            <button type="button" onClick={() => setPage((p) => p - 1)}>
              Back
            </button>
          )}
          {!last && (
            <button type="button" className="primary" onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          )}
          {last && (
            <>
              <button type="button" onClick={onClose}>
                Done
              </button>
              <button type="button" className="primary" onClick={onSetUpMachine}>
                Set up a machine
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
