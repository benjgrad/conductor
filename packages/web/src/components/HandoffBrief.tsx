// Ticket "Improved handoff" (06 §Hand-off brief): the first lines of every request card. One plain
// sentence on why the ticket stopped and, when conductor has it, what the agent did, in its own
// words. The technical text (the engine's question, a check's output) stays below, collapsed on a
// failure. `handoffBrief` (shared) derives both, so the panel and the MCP status report agree.
import type { HandoffBrief as Brief } from '@conductor/shared';
import { useState } from 'react';
import { Markdown } from './markdown.js';
import './HandoffBrief.css';

/** A summary longer than this many characters is clamped behind "More". */
const LONG_SUMMARY = 240;

export function HandoffBrief({
  brief,
  showSummary = true,
}: {
  brief: Brief;
  /** false when the card already shows the agent's own text as its body (a review, a question). */
  showSummary?: boolean;
}) {
  const [more, setMore] = useState(false);
  const summary = showSummary ? brief.summary : null;
  const long = summary !== null && summary.length > LONG_SUMMARY;
  return (
    <div className="handoff-brief" role="group" aria-label="Why it stopped">
      <p className="handoff-why">
        <span className="handoff-label">Why it stopped:</span> {brief.why}
      </p>
      {summary !== null && (
        <div className={`handoff-summary${long && !more ? ' clamped' : ''}`}>
          <span className="handoff-label">What was done:</span>
          <Markdown text={summary} />
        </div>
      )}
      {long && (
        <button
          type="button"
          className="link"
          aria-expanded={more}
          onClick={() => setMore((v) => !v)}
        >
          {more ? 'Less' : 'More'}
        </button>
      )}
    </div>
  );
}
