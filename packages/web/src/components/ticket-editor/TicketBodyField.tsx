// The ticket body field (UX-3): a rich editor loaded on demand, a "Plain markdown" toggle, and
// non-blocking requirement hints. The value is always markdown. Until the editor chunk arrives,
// or if it fails to load or render, the field is the plain textarea.
import { Component, lazy, Suspense, useId, useMemo, useState, type ReactNode } from 'react';
import { requirementHints } from './hints.js';
import './ticket-editor.css';

const RichTicketEditor = lazy(() => import('./RichTicketEditor.js'));

interface TicketBodyFieldProps {
  value: string;
  onChange: (markdown: string) => void;
  /** Bump to remount the editor with `value` (e.g. after the form resets). */
  resetKey?: number;
}

class EditorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function TicketBodyField({ value, onChange, resetKey = 0 }: TicketBodyFieldProps) {
  const [plain, setPlain] = useState(false);
  const [hintsOpen, setHintsOpen] = useState(true);
  const labelId = useId();
  const hintsId = useId();
  const hints = useMemo(() => requirementHints(value), [value]);

  const textarea = (
    <textarea
      className="ticket-body-plain"
      aria-label="Description"
      value={value}
      rows={14}
      spellCheck
      onChange={(e) => onChange(e.target.value)}
    />
  );

  return (
    <div className="ticket-body" role="group" aria-labelledby={labelId}>
      <div className="ticket-body-head">
        <span id={labelId}>Description</span>
        <button
          type="button"
          className="ticket-body-toggle"
          aria-pressed={plain}
          onClick={() => setPlain((p) => !p)}
        >
          Plain markdown
        </button>
      </div>
      {plain ? (
        textarea
      ) : (
        <EditorBoundary
          key={resetKey}
          fallback={
            <>
              {textarea}
              <p className="ticket-body-note muted">
                The rich editor didn't load; editing as markdown.
              </p>
            </>
          }
        >
          <Suspense fallback={textarea}>
            <div className="ticket-body-rich">
              <RichTicketEditor key={resetKey} initialMarkdown={value} onChange={onChange} />
            </div>
          </Suspense>
        </EditorBoundary>
      )}
      {hints.length > 0 && (
        <div className="ticket-hints">
          <button
            type="button"
            className="ticket-hints-toggle"
            aria-expanded={hintsOpen}
            aria-controls={hintsId}
            onClick={() => setHintsOpen((o) => !o)}
          >
            Hints ({hints.length})
          </button>
          <ul id={hintsId} hidden={!hintsOpen} aria-live="polite">
            {hints.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
