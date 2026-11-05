// UX-4 (FR-4): an open review request (a `*ready_for_review` move) in the session panel: the PR
// link, a one-line summary of the agent's report, and the full report collapsed.
import type { InputRequestDto, SessionDetail } from '@conductor/shared';
import type { ApiClient } from '../api/client.js';
import { AttachmentGallery } from './AttachmentGallery.js';
import { sessionCaptures } from './attachment-groups.js';
import { Markdown } from './markdown.js';
import { useTicket } from './TicketPanel.js';
import { formatSummary, previewText, summarizeReport } from './request-preview.js';
import './ReviewRequest.css';

interface ReviewRequestProps {
  detail: SessionDetail;
  request: InputRequestDto;
  agent: string;
  /** 06 §Attachments: when set, what this session's agent attached is shown with the report. */
  api?: ApiClient;
}

export function ReviewRequest({ detail, request, agent, api }: ReviewRequestProps) {
  const summary = summarizeReport(request.question);
  const line = summary ? formatSummary(summary) : previewText(request.question, 'review');
  return (
    <section aria-label="Ready for review" className="pending review-request">
      <div className="pending-head">
        <span className="action-needed">Action needed</span>
        <span className="badge badge-review">Ready for review</span>
        <span className="muted">{agent} finished</span>
      </div>
      {detail.card.pr_url && (
        <a className="review-pr-link" href={detail.card.pr_url} target="_blank" rel="noreferrer">
          Open pull request ↗
        </a>
      )}
      {line !== '' && <p className="review-summary">{line}</p>}
      {api && <SessionCaptures api={api} detail={detail} />}
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

/** The screenshots, GIFs and recordings this session's agent attached, under the summary. */
function SessionCaptures({ api, detail }: { api: ApiClient; detail: SessionDetail }) {
  const { ticket } = useTicket(api, detail.card.ticket_id, detail.card.updated_at);
  const captures = sessionCaptures(ticket?.attachments ?? [], detail.card.session_id);
  if (captures.length === 0) return null;
  return (
    <div className="review-captures" aria-label="Attached by the agent">
      <p className="muted">The agent attached:</p>
      <AttachmentGallery api={api} attachments={captures} />
    </div>
  );
}
