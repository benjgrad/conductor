// UX-2: the session's brief: what the agent was asked to do (goal, FR/NFR checklists with each
// requirement's verification inline, out of scope), a tally of requirements with a verification,
// the raw ticket, and the exact initial prompt. The Brief button in the panel's tab row opens it
// in a sheet (TicketStrip.tsx), at every width.
import { useId, useState } from 'react';
import { tally, verificationFor, type Brief, type Requirement } from '../brief/parse.js';
import { Markdown, renderInline } from './markdown.js';
import './BriefCard.css';

/** "FR 5 · NFR 5 · 3/10 with a verification", or the count without one in the warning colour. */
export function BriefTally({ brief }: { brief: Brief }) {
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

export function Requirements({
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

export interface BriefContentProps {
  brief: Brief | null;
  body: string | null;
  unavailable: string | null;
  promptText: string | null;
  promptReason: string | null;
  promptLoading: boolean;
  onWantPrompt: () => void;
}

/**
 * The brief itself (tally, goal, requirements, out of scope) with Full ticket and View prompt:
 * the Brief sheet's body (TicketStrip.tsx).
 */
export function BriefContent({
  brief,
  body,
  unavailable,
  promptText,
  promptReason,
  promptLoading,
  onWantPrompt,
}: BriefContentProps) {
  const ids = useId();
  const [fullTicket, setFullTicket] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  return (
    <>
      {brief && (
        <p className="brief-tally-line">
          <BriefTally brief={brief} />
        </p>
      )}
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
    </>
  );
}
