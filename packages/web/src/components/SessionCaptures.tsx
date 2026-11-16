// 06 §Attachments: the screenshots, GIFs and recordings this session's agent attached, under its
// open request (a question, a hand-off or a review request), so the evidence the agent mentions
// is right there, with no PR needed.
import type { SessionDetail } from '@conductor/shared';
import type { ApiClient } from '../api/client.js';
import { AttachmentGallery } from './AttachmentGallery.js';
import { sessionCaptures } from './attachment-groups.js';
import { useTicket } from './TicketPanel.js';

export function SessionCaptures({ api, detail }: { api: ApiClient; detail: SessionDetail }) {
  const { ticket } = useTicket(api, detail.card.ticket_id, detail.card.updated_at);
  const captures = sessionCaptures(ticket?.attachments ?? [], detail.card.session_id);
  if (captures.length === 0) return null;
  return (
    <div className="request-captures" role="group" aria-label="Attached by the agent">
      <p className="muted">The agent attached:</p>
      <AttachmentGallery api={api} attachments={captures} />
    </div>
  );
}
