// 06 §Attachments: a ticket's images and videos, as a grid of thumbnails; one opens full size in
// a lightbox (Escape or Close closes it). The lightbox steps through the gallery (← / →, its
// Previous / Next buttons, a swipe) and zooms an image (a click or tap, the wheel, a pinch, its
// Zoom buttons, + / - / 0), panned by dragging while zoomed. Who attached each is shown ("you"
// for a human; an agent's attachments carry the workflow state they were captured in).
// `AgentAttachments` shows what the agents attached (their screenshots, GIFs and recordings),
// grouped by that state, with one lightbox that steps across every group.
import { isVideoMime, type AttachmentDto } from '@conductor/shared';
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ApiClient } from '../api/client.js';
import { AttachmentThumb } from './AttachmentPicker.js';
import { groupByState } from './attachment-groups.js';
import {
  NO_ZOOM,
  TOGGLE_SCALE,
  ZOOM_STEP,
  pan,
  step,
  swipeDirection,
  transformOf,
  zoomAt,
  type Zoom,
} from './lightbox.js';
import './Attachments.css';

interface AttachmentGalleryProps {
  api: ApiClient;
  attachments: readonly AttachmentDto[];
  /** Open an item in a lightbox owned by the caller; without it the gallery has its own. */
  onOpen?: (a: AttachmentDto) => void;
}

const byline = (a: AttachmentDto) =>
  a.source === 'human'
    ? 'you'
    : `the agent${a.workflow_state !== null ? ` (${a.workflow_state})` : ''}`;

export function AttachmentGallery({ api, attachments, onOpen }: AttachmentGalleryProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (attachments.length === 0) return null;
  return (
    <>
      <ul className="attachment-gallery">
        {attachments.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              className="attachment-tile"
              onClick={() => (onOpen ? onOpen(a) : setOpenId(a.id))}
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
      {!onOpen && (
        <Lightbox
          api={api}
          items={attachments}
          openId={openId}
          onOpen={setOpenId}
          onClose={() => setOpenId(null)}
        />
      )}
    </>
  );
}

/**
 * The agents' attachments of a ticket under "From the agent", one group per workflow state (the
 * latest first). Nothing when there are none. Previous / next steps through every group, in the
 * order they are shown.
 */
export function AgentAttachments({ api, attachments }: AttachmentGalleryProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const groups = groupByState(attachments);
  if (groups.length === 0) return null;
  const all = groups.flatMap((g) => g.items);
  return (
    <section className="agent-attachments" aria-label="From the agent">
      <h3>From the agent</h3>
      {groups.map((g) => (
        <div key={g.state ?? ''} className="agent-attachments-group">
          {groups.length > 1 && g.state !== null && <h4 className="muted">{g.state}</h4>}
          <AttachmentGallery api={api} attachments={g.items} onOpen={(a) => setOpenId(a.id)} />
        </div>
      ))}
      <Lightbox
        api={api}
        items={all}
        openId={openId}
        onOpen={setOpenId}
        onClose={() => setOpenId(null)}
      />
    </section>
  );
}

interface LightboxProps {
  api: ApiClient;
  items: readonly AttachmentDto[];
  /** The open item, by id so a refreshed list doesn't move it; nothing renders when it's gone. */
  openId: string | null;
  onOpen: (id: string) => void;
  onClose: () => void;
}

/** A click that moved further than this (px) was a drag, not a zoom toggle. */
const CLICK_SLOP = 5;

function Lightbox({ api, items, openId, onOpen, onClose }: LightboxProps) {
  const index = openId === null ? -1 : items.findIndex((a) => a.id === openId);
  const open = index >= 0 ? items[index]! : null;
  // The zoom belongs to one item: moving to another starts unzoomed.
  const [zoomed, setZoomed] = useState<{ id: string; z: Zoom } | null>(null);
  const zoom = open !== null && zoomed?.id === open.id ? zoomed.z : NO_ZOOM;
  const isImage = open !== null && !isVideoMime(open.mime);
  const many = items.length > 1;

  const setZoom = (f: (z: Zoom) => Zoom) => {
    if (open === null) return;
    const id = open.id;
    setZoomed((prev) => ({ id, z: f(prev?.id === id ? prev.z : NO_ZOOM) }));
  };
  const go = (delta: number) => {
    if (index >= 0 && many) onOpen(items[step(index, items.length, delta)]!.id);
  };

  // Close when the open item leaves the list (it was deleted).
  useEffect(() => {
    if (openId !== null && index < 0) onClose();
  }, [openId, index, onClose]);

  // The latest handlers for the window listener, which is attached once per open lightbox.
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  const onKeyNow = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'Escape') return onClose();
    // A focused video seeks with the arrow keys.
    const onVideo = document.activeElement?.tagName === 'VIDEO';
    if (e.key === 'ArrowRight' && !onVideo) return go(1);
    if (e.key === 'ArrowLeft' && !onVideo) return go(-1);
    if (!isImage) return;
    if (e.key === '+' || e.key === '=') setZoom((z) => zoomAt(z, ZOOM_STEP));
    else if (e.key === '-') setZoom((z) => zoomAt(z, 1 / ZOOM_STEP));
    else if (e.key === '0') setZoom(() => NO_ZOOM);
  };
  const isOpen = open !== null;
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen]);

  // The wheel zooms at the cursor. React's onWheel is passive, so it can't stop the page scroll.
  const media = useRef<HTMLDivElement | null>(null);
  const wheel = useRef<(e: WheelEvent) => void>(() => undefined);
  const wheelListener = useRef<(e: WheelEvent) => void>(() => undefined);
  const onWheelNow = (e: WheelEvent) => {
    if (!isImage) return;
    e.preventDefault();
    const p = pointIn(media.current, e.clientX, e.clientY);
    setZoom((z) => zoomAt(z, e.deltaY < 0 ? 1.15 : 1 / 1.15, p));
  };
  useLayoutEffect(() => {
    keys.current = onKeyNow;
    wheel.current = onWheelNow;
  });
  const mediaRef = useCallback((el: HTMLDivElement | null) => {
    const onWheel = (e: WheelEvent) => wheel.current(e);
    media.current?.removeEventListener('wheel', wheelListener.current);
    media.current = el;
    wheelListener.current = onWheel;
    el?.addEventListener('wheel', onWheel, { passive: false });
  }, []);

  // Pointers: one drags (a pan when zoomed, else a swipe to the next / previous), two pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ startX: 0, startY: 0, moved: false, pinch: 0 });
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: ReactPointerEvent<HTMLImageElement>) => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (pointers.current.size === 1) {
      g.startX = e.clientX;
      g.startY = e.clientY;
      g.moved = false;
      g.pinch = 0;
    } else if (pointers.current.size === 2) {
      g.pinch = spread(pointers.current);
      g.moved = true;
    }
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLImageElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const now = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, now);
    const g = gesture.current;
    if (Math.hypot(now.x - g.startX, now.y - g.startY) > CLICK_SLOP) g.moved = true;
    if (pointers.current.size === 2) {
      const d = spread(pointers.current);
      if (g.pinch > 0 && d > 0) {
        const [a, b] = [...pointers.current.values()];
        const mid = pointIn(media.current, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
        setZoom((z) => zoomAt(z, d / g.pinch, mid));
      }
      g.pinch = d;
    } else if (pointers.current.size === 1 && zoom.scale > 1) {
      setZoom((z) => pan(z, now.x - prev.x, now.y - prev.y));
    }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLImageElement>) => {
    const wasPinch = pointers.current.size > 1 || gesture.current.pinch > 0;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size > 0) return;
    setDragging(false);
    if (!wasPinch && zoom.scale <= 1) {
      const dir = swipeDirection(
        e.clientX - gesture.current.startX,
        e.clientY - gesture.current.startY,
      );
      if (dir !== 0) go(dir);
    }
  };
  const onImageClick = (e: ReactMouseEvent<HTMLImageElement>) => {
    if (gesture.current.moved) {
      gesture.current.moved = false;
      return;
    }
    const p = pointIn(media.current, e.clientX, e.clientY);
    setZoom((z) => (z.scale > 1 ? NO_ZOOM : zoomAt(z, TOGGLE_SCALE, p)));
  };

  if (open === null) return null;
  const url = api.attachmentUrl(open);
  const zoomedIn = zoom.scale > 1;
  return (
    <div
      className="attachment-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={open.name}
      onClick={onClose}
    >
      <div className="attachment-lightbox-body" onClick={(e) => e.stopPropagation()}>
        <header>
          <span>{open.caption ?? open.name}</span>
          {many && (
            <output className="attachment-lightbox-counter muted" aria-label="Position">
              {index + 1} / {items.length}
            </output>
          )}
          {isImage && (
            <>
              <button
                type="button"
                className="attachment-lightbox-zoom"
                onClick={() => setZoom((z) => zoomAt(z, 1 / ZOOM_STEP))}
                disabled={!zoomedIn}
                aria-label="Zoom out"
              >
                <ZoomOut size={20} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="attachment-lightbox-zoom attachment-lightbox-reset"
                onClick={() => setZoom(() => NO_ZOOM)}
                aria-label="Reset zoom"
              >
                {Math.round(zoom.scale * 100)}%
              </button>
              <button
                type="button"
                className="attachment-lightbox-zoom"
                onClick={() => setZoom((z) => zoomAt(z, ZOOM_STEP))}
                aria-label="Zoom in"
              >
                <ZoomIn size={20} aria-hidden="true" />
              </button>
            </>
          )}
          <a href={url} target="_blank" rel="noreferrer">
            Open original
          </a>
          <button
            type="button"
            className="attachment-lightbox-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        {/* Its own box, so the media shrinks to fit and the header stays on screen. */}
        <div className="attachment-lightbox-media" ref={mediaRef}>
          {isImage ? (
            <img
              key={open.id}
              src={url}
              alt={open.caption ?? open.name}
              draggable={false}
              className={
                [zoomedIn ? 'zoomed' : '', dragging ? 'dragging' : ''].join(' ').trim() || undefined
              }
              style={{ transform: transformOf(zoom) }}
              onClick={onImageClick}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          ) : (
            <video key={open.id} src={url} controls autoPlay />
          )}
          {many && (
            <>
              <button
                type="button"
                className="attachment-lightbox-nav prev"
                onClick={() => go(-1)}
                aria-label="Previous"
              >
                <ChevronLeft size={24} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="attachment-lightbox-nav next"
                onClick={() => go(1)}
                aria-label="Next"
              >
                <ChevronRight size={24} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** (clientX, clientY) relative to the centre of `el`; the centre itself when it has no size. */
function pointIn(el: HTMLElement | null, clientX: number, clientY: number) {
  const r = el?.getBoundingClientRect();
  if (!r || r.width === 0 || r.height === 0) return { x: 0, y: 0 };
  return { x: clientX - (r.left + r.width / 2), y: clientY - (r.top + r.height / 2) };
}

/** The distance between the first two pointers. */
function spread(pointers: Map<number, { x: number; y: number }>) {
  const [a, b] = [...pointers.values()];
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}
