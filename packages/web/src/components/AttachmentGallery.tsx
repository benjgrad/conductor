// 06 §Attachments: a ticket's images and videos, as a grid of thumbnails; one opens full size in
// a lightbox (Escape or Close closes it). Who attached each is shown ("you" for a human; the
// agent's attachments, a follow-up, carry the workflow state they were captured in).
import { isVideoMime, type AttachmentDto } from '@conductor/shared';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client.js';
import { AttachmentThumb } from './AttachmentPicker.js';
import './Attachments.css';

interface AttachmentGalleryProps {
  api: ApiClient;
  attachments: readonly AttachmentDto[];
}

const byline = (a: AttachmentDto) =>
  a.source === 'human'
    ? 'you'
    : `the agent${a.workflow_state !== null ? ` (${a.workflow_state})` : ''}`;

export function AttachmentGallery({ api, attachments }: AttachmentGalleryProps) {
  const [open, setOpen] = useState<AttachmentDto | null>(null);
  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (attachments.length === 0) return null;
  return (
    <>
      <ul className="attachment-gallery">
        {attachments.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              className="attachment-tile"
              onClick={() => setOpen(a)}
              aria-label={`Open ${a.name}`}
            >
              <AttachmentThumb api={api} attachment={a} />
            </button>
            <span className="attachment-caption" title={a.name}>
              {a.caption ?? a.name}
            </span>
            <span className="attachment-by muted">by {byline(a)}</span>
          </li>
        ))}
      </ul>
      {open && (
        <div
          className="attachment-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={open.name}
          onClick={() => setOpen(null)}
        >
          <div className="attachment-lightbox-body" onClick={(e) => e.stopPropagation()}>
            <header>
              <span>{open.caption ?? open.name}</span>
              <a href={api.attachmentUrl(open)} target="_blank" rel="noreferrer">
                Open original
              </a>
              <button type="button" onClick={() => setOpen(null)} aria-label="Close">
                <X size={20} aria-hidden="true" />
              </button>
            </header>
            {isVideoMime(open.mime) ? (
              <video src={api.attachmentUrl(open)} controls autoPlay />
            ) : (
              <img src={api.attachmentUrl(open)} alt={open.caption ?? open.name} />
            )}
          </div>
        </div>
      )}
    </>
  );
}
