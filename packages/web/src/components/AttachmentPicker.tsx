// 06 §Attachments: pick, drop or paste images and videos into a ticket form. Each file is checked
// here first (type and size, `attachmentProblem`) and uploaded at once (POST /api/attachments);
// the form links the uploaded ids when it saves. The server re-checks everything from the bytes.
import {
  ATTACHMENT_ACCEPT,
  attachmentProblem,
  isVideoMime,
  type AttachmentDto,
} from '@conductor/shared';
import { ImagePlus, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import './Attachments.css';

export interface UploadItem {
  key: string;
  name: string;
  status: 'uploading' | 'done' | 'error';
  error: string | null;
  dto: AttachmentDto | null;
}

export interface AttachmentUploads {
  items: UploadItem[];
  /** Upload each file (refused ones show their reason and are not sent). */
  add: (files: Iterable<File>) => void;
  /** Drop an item; a finished upload is deleted on the server (best effort). */
  remove: (key: string) => void;
  /** Forget everything (after the form saved: the uploads are linked now). */
  reset: () => void;
  /** Ids of the finished uploads, in the order they were added. */
  ids: string[];
  uploading: boolean;
  /** For the body field's wrapper: pasted image files are uploaded, not pasted as text. */
  onPaste: (e: ClipboardEvent) => void;
}

let seq = 0;

/** The upload state of one form. */
export function useAttachmentUploads(api: ApiClient): AttachmentUploads {
  const [items, setItems] = useState<UploadItem[]>([]);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const patch = useCallback((key: string, next: Partial<UploadItem>) => {
    if (!live.current) return;
    setItems((list) => list.map((it) => (it.key === key ? { ...it, ...next } : it)));
  }, []);

  const add = useCallback(
    (files: Iterable<File>) => {
      for (const file of files) {
        const key = `u${++seq}`;
        const problem = attachmentProblem(file);
        setItems((list) => [
          ...list,
          {
            key,
            name: file.name || 'pasted image',
            status: problem === null ? 'uploading' : 'error',
            error: problem,
            dto: null,
          },
        ]);
        if (problem !== null) continue;
        api.uploadAttachment(file).then(
          (dto) => patch(key, { status: 'done', dto, name: dto.name }),
          (err: unknown) => patch(key, { status: 'error', error: errorMessage(err) }),
        );
      }
    },
    [api, patch],
  );

  const remove = useCallback(
    (key: string) => {
      setItems((list) => {
        const it = list.find((x) => x.key === key);
        if (it?.dto) void api.deleteAttachment(it.dto.id).catch(() => undefined);
        return list.filter((x) => x.key !== key);
      });
    },
    [api],
  );

  const reset = useCallback(() => setItems([]), []);

  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      // Text-only pastes (and some synthetic events) carry no `files`: leave those alone.
      const list = (e.clipboardData as Partial<DataTransfer> | null)?.files;
      const files = Array.from(list ?? []).filter((f) => f.type.startsWith('image/'));
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      add(files);
    },
    [add],
  );

  return {
    items,
    add,
    remove,
    reset,
    ids: items.flatMap((it) => (it.dto ? [it.dto.id] : [])),
    uploading: items.some((it) => it.status === 'uploading'),
    onPaste,
  };
}

interface AttachmentPickerProps {
  api: ApiClient;
  uploads: AttachmentUploads;
}

/** The file button, the drop zone and the list of this form's uploads. */
export function AttachmentPicker({ api, uploads }: AttachmentPickerProps) {
  const input = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    uploads.add(e.dataTransfer.files);
  };
  return (
    <div
      className={`attachment-picker${over ? ' drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className="attachment-picker-row">
        <button type="button" onClick={() => input.current?.click()}>
          <ImagePlus size={18} aria-hidden="true" /> Attach images or videos
        </button>
        <span className="muted">or drop or paste them here</span>
        <input
          ref={input}
          type="file"
          accept={ATTACHMENT_ACCEPT}
          multiple
          hidden
          aria-label="Attach files"
          onChange={(e) => {
            if (e.target.files) uploads.add(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {uploads.items.length > 0 && (
        <ul className="attachment-uploads" aria-label="Attachments to add">
          {uploads.items.map((it) => (
            <li key={it.key} className={`attachment-upload ${it.status}`}>
              {it.dto ? (
                <AttachmentThumb api={api} attachment={it.dto} />
              ) : (
                <span className="attachment-thumb placeholder" aria-hidden="true" />
              )}
              <span className="attachment-name">{it.name}</span>
              {it.status === 'uploading' && <span className="muted">uploading…</span>}
              {it.status === 'error' && (
                <span role="alert" className="error">
                  {it.error}
                </span>
              )}
              <button
                type="button"
                className="attachment-remove"
                aria-label={`Remove ${it.name}`}
                onClick={() => uploads.remove(it.key)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A small preview: the image itself, or a video's first frame. */
export function AttachmentThumb({
  api,
  attachment,
}: {
  api: ApiClient;
  attachment: AttachmentDto;
}) {
  const src = api.attachmentUrl(attachment);
  return isVideoMime(attachment.mime) ? (
    <video className="attachment-thumb" src={src} preload="metadata" muted aria-hidden="true" />
  ) : (
    <img className="attachment-thumb" src={src} alt="" loading="lazy" />
  );
}
