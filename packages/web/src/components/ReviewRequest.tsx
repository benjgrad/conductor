// UX-4 (FR-4): an open review request (a `*ready_for_review` move) in the session panel: the PR
// link, a one-line summary of the agent's report, and the full report collapsed.
import type { InputRequestDto, SessionDetail } from '@conductor/shared';
import { Markdown } from './markdown.js';
import { formatSummary, previewText, summarizeReport } from './request-preview.js';
import './ReviewRequest.css';

interface ReviewRequestProps {
  detail: SessionDetail;
  request: InputRequestDto;
  agent: string;
}

export function ReviewRequest({ detail, request, agent }: ReviewRequestProps) {
  const summary = summarizeReport(request.question);
  const line = summary ? formatSummary(summary) : previewText(request.question, 'review');
  return (
    <section aria-label="Ready for review" className="pending review-request">
      <div className="pending-head">
        <span className="badge badge-review">Ready for review</span>
        <span className="muted">{agent} finished</span>
      </div>
      {detail.card.pr_url && (
        <a className="review-pr-link" href={detail.card.pr_url} target="_blank" rel="noreferrer">
          Open pull request ↗
        </a>
      )}
      {line !== '' && <p className="review-summary">{line}</p>}
      <details className="full-report">
        <summary>Full report</summary>
        <div className="question-text">
          <Markdown text={request.question} />
        </div>
      </details>
      <p className="pending-hint muted">Reply in the box below to answer.</p>
    </section>
  );
}
