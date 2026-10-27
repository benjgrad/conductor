// UX-2: the session's brief, pinned above the Messages thread: what the agent was asked to do
// (goal, FR/NFR checklists with each requirement's verification inline, out of scope), a tally
// of requirements with a verification, the raw ticket, and the exact initial prompt.
import { memo, useEffect, useId, useState } from 'react';
import { tally, verificationFor, type Brief, type Requirement } from '../brief/parse.js';
import { Markdown, renderInline } from './markdown.js';
import './BriefCard.css';

export interface BriefCardProps {
  sessionId: string;
  /** The parsed body; null while it isn't available. */
  brief: Brief | null;
  /** The raw ticket body (Full ticket); null while it isn't available. */
  body: string | null;
  /** Why `body` is null (shown as "brief unavailable: …"); null while loading. */
  unavailable: string | null;
  promptText: string | null;
  promptReason: string | null;
  promptLoading: boolean;
  /** Asks for the initial prompt (fetched on demand: View prompt, or the body fallback). */
  onWantPrompt: () => void;
}

const storageKey = (sessionId: string) => `conductor.brief.open.${sessionId}`;

function readOpen(sessionId: string): boolean {
  try {
    return localStorage.getItem(storageKey(sessionId)) !== 'closed';
  } catch {
    return true;
  }
}

function writeOpen(sessionId: string, open: boolean) {
  try {
    localStorage.setItem(storageKey(sessionId), open ? 'open' : 'closed');
  } catch {
    // Private mode or a full quota: the choice just isn't remembered.
  }
}

function Tally({ brief }: { brief: Brief }) {
  const t = tally(brief);
  if (t.total === 0) return null;
  return (
    <span className="brief-tally">
      FR {t.fr} · NFR {t.nfr} ·{' '}
      {t.missing.length === 0 ? (
        `${t.verified}/${t.total} with a verification`
      ) : (
        <span className="brief-tally-warn" title={t.missing.join(', ')}>
          {t.missing.length} without verification
        </span>
      )}
    </span>
  );
}

function Requirements({
  title,
  reqs,
  brief,
}: {
  title: string;
  reqs: Requirement[];
  brief: Brief;
}) {
  if (reqs.length === 0) return null;
  return (
    <div className="brief-section">
      <h4>{title}</h4>
      <ul className="brief-reqs" aria-label={title}>
        {reqs.map((r, i) => {
          const hows = verificationFor(brief, r.id);
          return (
            <li key={`${r.id}-${i}`}>
              <label>
                <input type="checkbox" disabled />
                <code className="brief-id">{r.id}</code>{' '}
                <span className="brief-text">{renderInline(r.text, `${r.id}-${i}`)}</span>
              </label>
              {hows.length > 0 ? (
                hows.map((how, j) => (
                  <span key={j} className="brief-how muted">
                    → {renderInline(how, `${r.id}-${i}-h${j}`)}
                  </span>
                ))
              ) : (
                <span className="brief-how brief-tally-warn">no verification</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function BriefBody({ brief }: { brief: Brief }) {
  const structured = brief.functional.length + brief.nonFunctional.length > 0;
  return (
    <>
      {brief.goal && (
        <div className="brief-section brief-goal">
          <h4>Goal</h4>
          <Markdown text={brief.goal} />
        </div>
      )}
      <Requirements title="Functional" reqs={brief.functional} brief={brief} />
      <Requirements title="Non-functional" reqs={brief.nonFunctional} brief={brief} />
      {brief.outOfScope && (
        <div className="brief-section">
          <h4>Out of scope</h4>
          <Markdown text={brief.outOfScope} />
        </div>
      )}
      {/* A legacy ticket (no requirements) shows as written; else the rest is in Full ticket. */}
      {!structured &&
        brief.other.map((s, i) => (
          <div key={i} className="brief-section">
            {s.heading && <h4>{s.heading}</h4>}
            <Markdown text={s.markdown} />
          </div>
        ))}
      {brief.warnings.length > 0 && (
        <p className="brief-warnings muted">{brief.warnings.join(' · ')}</p>
      )}
    </>
  );
}

export const BriefCard = memo(function BriefCard({
  sessionId,
  brief,
  body,
  unavailable,
  promptText,
  promptReason,
  promptLoading,
  onWantPrompt,
}: BriefCardProps) {
  const ids = useId();
  const [open, setOpen] = useState(() => readOpen(sessionId));
  const [fullTicket, setFullTicket] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  // An older server sends no ticket_body: the body then comes from the prompt.
  const waiting = open && body === null && unavailable === null;
  useEffect(() => {
    if (waiting) onWantPrompt();
  }, [waiting, onWantPrompt]);

  function toggle() {
    const next = !open;
    setOpen(next);
    writeOpen(sessionId, next);
  }

  return (
    <section className="brief" aria-label="Brief">
      <button
        type="button"
        className="brief-head"
        aria-expanded={open}
        aria-controls={`${ids}-body`}
        onClick={toggle}
      >
        <span className="brief-chevron" aria-hidden="true">
          ▸
        </span>
        <span className="brief-title">Brief</span>
        {brief && <Tally brief={brief} />}
      </button>
      <div id={`${ids}-body`} className="brief-body" hidden={!open}>
        {brief ? (
          <BriefBody brief={brief} />
        ) : (
          <p className="muted brief-unavailable">
            {unavailable === null ? 'Loading the brief…' : `brief unavailable: ${unavailable}`}
          </p>
        )}
        <div className="brief-actions">
          {body !== null && (
            <button
              type="button"
              className="link"
              aria-expanded={fullTicket}
              aria-controls={`${ids}-ticket`}
              onClick={() => setFullTicket((v) => !v)}
            >
              Full ticket {fullTicket ? '▾' : '▸'}
            </button>
          )}
          <button
            type="button"
            className="link"
            aria-expanded={showPrompt}
            aria-controls={`${ids}-prompt`}
            onClick={() => {
              if (!showPrompt) onWantPrompt();
              setShowPrompt((v) => !v);
            }}
          >
            View prompt {showPrompt ? '▾' : '▸'}
          </button>
        </div>
        {fullTicket && body !== null && (
          <div id={`${ids}-ticket`} className="brief-ticket" aria-label="Full ticket">
            <Markdown text={body} />
          </div>
        )}
        {showPrompt && (
          <div id={`${ids}-prompt`} aria-label="Initial prompt">
            {promptText !== null ? (
              <pre className="brief-prompt">{promptText}</pre>
            ) : (
              <p className="muted">
                {promptLoading || promptReason === null
                  ? 'Loading the prompt…'
                  : `prompt unavailable: ${promptReason}`}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
});
