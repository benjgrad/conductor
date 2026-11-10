// 06 §Attachments: the lightbox's previous/next and zoom/pan maths, kept pure so it is tested
// without a DOM (AttachmentGallery.tsx wires it to keys, buttons, the wheel and pointers).

/** The index `delta` steps from `index` in a list of `length`, wrapping around both ends. */
export function step(index: number, length: number, delta: number): number {
  if (length <= 1) return index;
  return (((index + delta) % length) + length) % length;
}

/** The image's zoom: a scale and a translation in px, about the media box's centre. */
export interface Zoom {
  scale: number;
  x: number;
  y: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 5;
/** What one press of Zoom in / Zoom out multiplies the scale by. */
export const ZOOM_STEP = 1.5;
/** The scale a click or tap on an unzoomed image zooms to. */
export const TOGGLE_SCALE = 2.5;
export const NO_ZOOM: Zoom = { scale: 1, x: 0, y: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The zoom multiplied by `factor`, clamped to [MIN_SCALE, MAX_SCALE], keeping `point` (relative
 * to the media box's centre; the centre when omitted) where it is on screen. Back at scale 1 the
 * image is recentred.
 */
export function zoomAt(
  z: Zoom,
  factor: number,
  point: { x: number; y: number } = { x: 0, y: 0 },
): Zoom {
  const scale = clamp(z.scale * factor, MIN_SCALE, MAX_SCALE);
  if (scale <= MIN_SCALE) return NO_ZOOM;
  const r = scale / z.scale;
  return { scale, x: point.x - (point.x - z.x) * r, y: point.y - (point.y - z.y) * r };
}

/** The zoom moved by a drag of (dx, dy); an unzoomed image doesn't move. */
export function pan(z: Zoom, dx: number, dy: number): Zoom {
  if (z.scale <= MIN_SCALE) return z;
  return { ...z, x: z.x + dx, y: z.y + dy };
}

/** A horizontal swipe of (dx, dy): +1 (left: next), -1 (right: previous) or 0 (not a swipe). */
export function swipeDirection(dx: number, dy: number, threshold = 50): -1 | 0 | 1 {
  if (Math.abs(dx) <= threshold || Math.abs(dx) <= Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}

export const transformOf = (z: Zoom) => `translate(${z.x}px, ${z.y}px) scale(${z.scale})`;
