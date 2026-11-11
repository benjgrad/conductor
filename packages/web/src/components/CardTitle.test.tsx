// @vitest-environment jsdom
// Board card titles: one line with an ellipsis, scrolling like a ticker on hover when too long.
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CardTitle, marqueeTiming } from './CardTitle.js';

const LONG = 'https://method.atlassian.net/browse/NCNG-2722 rebase onto pie-sb-1';

/** jsdom does no layout: give every element this scroll/client width while the test runs. */
function stubWidths(scrollWidth: number, clientWidth: number): () => void {
  const proto = HTMLElement.prototype;
  const saved = ['scrollWidth', 'clientWidth'].map(
    (k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const,
  );
  Object.defineProperty(proto, 'scrollWidth', { configurable: true, get: () => scrollWidth });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => clientWidth });
  return () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(proto, k, d);
      else delete (proto as unknown as Record<string, unknown>)[k];
    }
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('marqueeTiming', () => {
  it('scrolls left by the overflow', () => {
    expect(marqueeTiming(120).shiftPx).toBe(-120);
  });
  it('clamps the duration to 3–20 s', () => {
    expect(marqueeTiming(5).durationS).toBe(3);
    expect(marqueeTiming(200).durationS).toBe(7);
    expect(marqueeTiming(5000).durationS).toBe(20);
  });
});

describe('CardTitle', () => {
  it('renders the title once, untruncated, when it fits', () => {
    const { container } = render(<CardTitle title="Add /health" />);
    const clip = container.querySelector('.card-title-clip')!;
    expect(container.querySelectorAll('.card-title')).toHaveLength(1);
    expect(clip.textContent).toBe('Add /health');
    expect(clip.classList.contains('is-truncated')).toBe(false);
    expect(clip.hasAttribute('title')).toBe(false);
  });

  it('marks a title that overflows and gives it the full text and scroll distance', () => {
    restore = stubWidths(400, 200);
    const { container } = render(<CardTitle title={LONG} />);
    const clip = container.querySelector<HTMLElement>('.card-title-clip')!;
    expect(clip.classList.contains('is-truncated')).toBe(true);
    expect(clip.getAttribute('title')).toBe(LONG);
    expect(clip.style.getPropertyValue('--marquee-shift')).toBe('-200px');
    expect(clip.style.getPropertyValue('--marquee-duration')).toBe('7s');
    expect(container.querySelector('.card-title')!.textContent).toBe(LONG);
  });
});
