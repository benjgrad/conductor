import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

/** How far a truncated title scrolls on hover, and how long one pass takes. */
export interface MarqueeTiming {
  shiftPx: number;
  durationS: number;
}

/** ~40 px/s, plus ~2 s for the pauses at each end, clamped to 3–20 s. */
export function marqueeTiming(overflowPx: number): MarqueeTiming {
  const durationS = Math.min(20, Math.max(3, overflowPx / 40 + 2));
  return { shiftPx: -Math.round(overflowPx), durationS: Math.round(durationS * 10) / 10 };
}

/**
 * A board card's title: one line ending in an ellipsis when it is too long, and on hover or
 * keyboard focus it scrolls to its end and back like a ticker. The text is rendered once, in
 * `.card-title`, so the tooltip, screen readers and tests read the whole title.
 */
export function CardTitle({ title }: { title: string }) {
  const clipRef = useRef<HTMLSpanElement>(null);
  const [timing, setTiming] = useState<MarqueeTiming | null>(null);

  useLayoutEffect(() => {
    const clip = clipRef.current;
    if (!clip) return;
    const measure = () => {
      // The clip hides its overflow, so its scrollWidth is the whole title's width.
      const overflow = clip.scrollWidth - clip.clientWidth;
      setTiming((prev) => {
        if (overflow <= 1) return null;
        const next = marqueeTiming(overflow);
        return prev && prev.shiftPx === next.shiftPx ? prev : next;
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(clip);
    return () => observer.disconnect();
  }, [title]);

  const style = timing
    ? ({
        '--marquee-shift': `${timing.shiftPx}px`,
        '--marquee-duration': `${timing.durationS}s`,
      } as CSSProperties)
    : undefined;
  return (
    <span
      ref={clipRef}
      className={`card-title-clip${timing ? ' is-truncated' : ''}`}
      {...(timing ? { title, style } : {})}
    >
      <span className="card-title">{title}</span>
    </span>
  );
}
