// The ticket body field (UX-3): a rich editor loaded on demand, a "Plain markdown" toggle, and
// non-blocking requirement hints. The value is always markdown. Until the editor chunk arrives,
// or if it fails to load or render, the field is the plain textarea.
//
// On a phone (MOBILE_QUERY) the field is a tappable preview; the editor opens full screen above
// the keyboard (11-web-ui §Phone layout), so it isn't a half-height scroller inside the sheet.
import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useIsMobile } from '../useMediaQuery.js';
import { requirementHints } from './hints.js';
import type { RichEditorHandle } from './RichTicketEditor.js';
import './ticket-editor.css';

const RichTicketEditor = lazy(() => import('./RichTicketEditor.js'));

interface TicketBodyFieldProps {
  value: string;
  onChange: (markdown: string) => void;
  /** Bump to remount the editor with `value` (e.g. after the form resets). */
  resetKey?: number;
  /** Filled while the rich editor is mounted; the form flushes it on submit. */
  editorHandle?: RefObject<RichEditorHandle | null>;
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

/**
 * The phone preview's text: the body with markdown syntax (headings, list markers, emphasis,
 * table rules, HTML comments) dropped and blank lines removed. '' when there is nothing to show.
 */
export function previewText(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
        .replace(/^\s*\|?\s*:?-{3,}.*$/, '')
        .replace(/\s*\|\s*/g, ' · ')
        .replace(/^ · | · $/g, '')
        .replace(/(\*\*|__|`)/g, '')
        .trim(),
    )
    .filter((line) => line !== '')
    .join('\n');
}

export function TicketBodyField({
  value,
  onChange,
  resetKey = 0,
  editorHandle,
}: TicketBodyFieldProps) {
  const ownHandle = useRef<RichEditorHandle | null>(null);
  const handle = editorHandle ?? ownHandle;
  const mobile = useIsMobile();
  const [plain, setPlain] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [hintsOpen, setHintsOpen] = useState(true);
  const labelId = useId();
  const fullLabelId = useId();
  const hintsId = useId();
  const hints = useMemo(() => requirementHints(value), [value]);
  const preview = useRef<HTMLButtonElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const previewLines = useMemo(() => previewText(value), [value]);

  // A reset (the form cleared) closes the full-screen editor too.
  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    setExpanded(false);
  }, [resetKey]);

  // Focus lands in the dialog on open, and back on the preview when it closes.
  const wasExpanded = useRef(false);
  useEffect(() => {
    if (expanded) done.current?.focus();
    else if (wasExpanded.current) preview.current?.focus();
    wasExpanded.current = expanded;
  }, [expanded]);

  function close() {
    handle.current?.flush();
    setExpanded(false);
  }

  function onFullKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    // The sheet's own Escape (close / discard) checks defaultPrevented: only this layer closes.
    e.preventDefault();
    e.stopPropagation();
    close();
  }

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

  const toggle = (
    <button
      type="button"
      className="ticket-body-toggle"
      aria-pressed={plain}
      onClick={() => {
        handle.current?.flush();
        setPlain((p) => !p);
      }}
    >
      Plain markdown
    </button>
  );

  const editorArea = plain ? (
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
          <RichTicketEditor
            key={resetKey}
            initialMarkdown={value}
            onChange={onChange}
            ref={handle}
          />
        </div>
      </Suspense>
    </EditorBoundary>
  );

  return (
    <div className="ticket-body" role="group" aria-labelledby={labelId}>
      <div className="ticket-body-head">
        <span id={labelId}>Description</span>
        {!mobile && toggle}
      </div>
      {!mobile ? (
        editorArea
      ) : (
        <>
          <button
            ref={preview}
            type="button"
            className={`ticket-body-preview${previewLines === '' ? ' empty' : ''}`}
            aria-label="Edit description"
            aria-haspopup="dialog"
            onPointerDown={() => void import('./RichTicketEditor.js').catch(() => undefined)}
            onClick={() => setExpanded(true)}
          >
            <span className="ticket-body-preview-text">
              {previewLines === '' ? 'Add a description' : previewLines}
            </span>
          </button>
          {expanded && (
            // Not portaled: a Sheet closes on a pointerdown outside its panel, so this layer stays
            // inside it and covers the screen with position: fixed.
            <div
              className="ticket-body-full"
              role="dialog"
              aria-modal="true"
              aria-labelledby={fullLabelId}
              onKeyDown={onFullKeyDown}
            >
              <div className="ticket-body-full-head">
                <h2 id={fullLabelId}>Description</h2>
                {toggle}
                <button ref={done} type="button" className="ticket-body-done" onClick={close}>
                  Done
                </button>
              </div>
              {editorArea}
            </div>
          )}
        </>
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
