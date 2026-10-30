import { describe, expect, it } from 'vitest';
import { TRUNCATED, capJson } from './cap.js';

const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

describe('capJson', () => {
  it('returns a small value as is', () => {
    const v = { a: 'x', b: [1, 2] };
    expect(capJson(v)).toEqual({ value: v, truncated: false });
  });

  it('halves the longest strings first, marking them', () => {
    const v = { title: 'short', body: 'b'.repeat(20_000) };
    const out = capJson(v, 8192);
    expect(out.truncated).toBe(true);
    expect(size(out.value)).toBeLessThanOrEqual(8192);
    expect(out.value.title).toBe('short');
    expect(out.value.body.endsWith(TRUNCATED)).toBe(true);
    expect(v.body.length).toBe(20_000); // the input is not modified
  });

  it('drops trailing array items when strings are already short', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i, title: 't'.repeat(60) }));
    const out = capJson({ tickets: rows }, 4096);
    expect(size(out.value)).toBeLessThanOrEqual(4096);
    expect(out.value.tickets[0]!.id).toBe(0);
    expect(out.value.tickets.length).toBeLessThan(200);
  });
});
