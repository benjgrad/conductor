// The iOS 26 status-bar blur and the lightbox's safe-area layout can't be seen in jsdom or
// Chromium, only on a real iPhone, so these read the source to keep the fixes from being dropped.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const rule = (css: string, selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
};

describe('status-bar backdrop (iOS 26 top-edge blur)', () => {
  it('index.html has the backdrop before #root and still covers the safe areas', () => {
    const html = read('../index.html');
    const backdrop = html.indexOf('<div id="status-bar-backdrop" aria-hidden="true"></div>');
    expect(backdrop).toBeGreaterThanOrEqual(0);
    expect(backdrop).toBeLessThan(html.indexOf('<div id="root">'));
    expect(html).toContain('viewport-fit=cover');
  });

  it('is a fixed, opaque, click-through band the height of the top inset, above every overlay', () => {
    const css = read('./styles.css');
    const r = rule(css, '#status-bar-backdrop');
    expect(r).toContain('position: fixed');
    expect(r).toContain('top: 0');
    expect(r).toContain('height: env(safe-area-inset-top');
    expect(r).toContain('background: var(--panel)');
    expect(r).toContain('pointer-events: none');
    expect(r).toContain('z-index: var(--z-status-bar)');
    const z = (name: string) => Number(new RegExp(`--z-${name}: (\\d+);`).exec(css)?.[1]);
    expect(z('status-bar')).toBeGreaterThan(z('sheet'));
  });
});

describe('attachment lightbox', () => {
  it('stays inside the visual viewport and the safe areas', () => {
    const css = read('./components/Attachments.css');
    expect(css).not.toContain('100vh - 120px');
    const r = rule(css, '.attachment-lightbox');
    expect(r).toContain('top: var(--vvt, 0)');
    expect(r).toContain('height: var(--vvh, 100dvh)');
    expect(r).toContain('env(safe-area-inset-top');
    expect(r).toContain('env(safe-area-inset-bottom');
  });
});
