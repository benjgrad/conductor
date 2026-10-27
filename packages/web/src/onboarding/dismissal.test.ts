// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentVisit, dismiss, isDismissed, newVisitForTests } from './dismissal.js';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('setup guide dismissal (UX-8 FR-1)', () => {
  it('is per user and per visit', () => {
    dismiss('u1');
    expect(isDismissed('u1')).toBe(true);
    expect(isDismissed('u2')).toBe(false);
    const before = currentVisit();
    newVisitForTests();
    expect(currentVisit()).not.toBe(before);
    expect(isDismissed('u1')).toBe(false);
    expect(isDismissed('u1', before)).toBe(true);
  });

  it('a throwing localStorage means not dismissed, and never throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => dismiss('u1')).not.toThrow();
    expect(isDismissed('u1')).toBe(false);
  });
});
