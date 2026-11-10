import { describe, expect, it } from 'vitest';
import { MAX_SCALE, NO_ZOOM, pan, step, swipeDirection, zoomAt } from './lightbox.js';

describe('step', () => {
  it('wraps both ways', () => {
    expect(step(0, 3, 1)).toBe(1);
    expect(step(2, 3, 1)).toBe(0);
    expect(step(0, 3, -1)).toBe(2);
  });
  it('a single item stays put', () => {
    expect(step(0, 1, 1)).toBe(0);
    expect(step(0, 1, -1)).toBe(0);
  });
});

describe('zoomAt', () => {
  it('clamps the scale to [1, MAX_SCALE]', () => {
    expect(zoomAt(NO_ZOOM, 0.5)).toEqual(NO_ZOOM);
    expect(zoomAt(NO_ZOOM, 100).scale).toBe(MAX_SCALE);
  });
  it('keeps the anchor point where it is on screen', () => {
    const p = { x: 40, y: -20 };
    const z = zoomAt(NO_ZOOM, 2, p);
    // The image point under p before (p itself at scale 1) maps back to p after.
    expect(p.x * z.scale + z.x).toBeCloseTo(p.x);
    expect(p.y * z.scale + z.y).toBeCloseTo(p.y);
    const z2 = zoomAt(z, 1.5, p);
    const imgX = (p.x - z.x) / z.scale;
    expect(imgX * z2.scale + z2.x).toBeCloseTo(p.x);
  });
  it('recentres when it comes back to scale 1', () => {
    const z = zoomAt(NO_ZOOM, 2, { x: 30, y: 30 });
    expect(zoomAt(z, 0.5, { x: -10, y: 5 })).toEqual(NO_ZOOM);
  });
});

describe('pan', () => {
  it('does nothing unzoomed and moves a zoomed image', () => {
    expect(pan(NO_ZOOM, 10, 10)).toEqual(NO_ZOOM);
    expect(pan({ scale: 2, x: 1, y: 2 }, 10, -5)).toEqual({ scale: 2, x: 11, y: -3 });
  });
});

describe('swipeDirection', () => {
  it('left is next, right is previous; short or vertical moves are not swipes', () => {
    expect(swipeDirection(-80, 10)).toBe(1);
    expect(swipeDirection(80, 10)).toBe(-1);
    expect(swipeDirection(30, 0)).toBe(0);
    expect(swipeDirection(80, 120)).toBe(0);
  });
});
