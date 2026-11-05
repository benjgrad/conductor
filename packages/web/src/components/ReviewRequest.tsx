// UX-4 (FR-4), UXR-36: an open review request (a `*ready_for_review` move) in the session panel:
// a one-line summary of the agent's report, then Approve (the review state's approving
// transition, `reviewApproveOption`), Request changes… (focuses the composer, which answers the
// request), the PR link and the full report.
import type { InputRequestDto, SessionDetail } from '@conductor/shared';
import { useId, useRef, useState } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { Markdown } from './markdown.js';
import { RequestCard } from './RequestCard.js';
import {
  formatSummary,
  previewText,
  reviewApproveOption,
  summarizeReport,
} from './request-preview.js';
import './ReviewRequest.css';

export const REVIEW_LABEL = 'Ready for review';

interface ReviewRequestProps {
  api: ApiClient;
  detail: SessionDetail;
  request: InputRequestDto;
  agent: string;
  onDone: () => void;
  /** Request changes…: put the cursor in the composer. */
  onRequestChanges: () => void;
}

export function ReviewRequest({
  api,
  detail,
  request,
  agent,
  onDone,
  onRequestChanges,
}: ReviewRequestProps) {
  const summary = summarizeReport(request.question);
  const line = summary ? formatSummary(summary) : previewText(request.question, 'review');
  const sessionId = detail.card.session_id;
  const approve = reviewApproveOption(detail.card.human_transitions, detail.workflow);
  const [report, setReport] = useState(false);
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const reportId = useId();

  async function onApprove() {
    if (inflight.current || sessionId === null || !approve) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.transition(sessionId, { name: approve.name });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  return (
    <RequestCard
      tone="review"
      label={REVIEW_LABEL}
      who={`${agent} finished`}
      ariaLabel={REVIEW_LABEL}
      className="review-request"
    >
      {line !== '' && <p className="review-summary">{line}</p>}
      <div className="request-actions" role="group" aria-label="Review">
        {approve && sessionId !== null && (
          <button
            type="button"
            className="primary review-approve"
            disabled={busy}
            title={approve.title}
            onClick={() => void onApprove()}
          >
            Approve
          </button>
        )}
        <button type="button" disabled={busy} onClick={onRequestChanges}>
          Request changes…
        </button>
        {detail.card.pr_url && (
          <a className="review-pr-link" href={detail.card.pr_url} target="_blank" rel="noreferrer">
            Open PR ↗
          </a>
        )}
        <button
          type="button"
          className="link"
          aria-expanded={report}
          aria-controls={reportId}
          onClick={() => setReport((v) => !v)}
        >
          Full report
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div
        id={reportId}
        className="full-report question-text"
        role="region"
        aria-label="Full report"
        hidden={!report}
      >
        <Markdown text={request.question} />
      </div>
    </RequestCard>
  );
}
