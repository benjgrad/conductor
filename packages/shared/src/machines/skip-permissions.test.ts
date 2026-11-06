import { describe, expect, it } from 'vitest';
import { effectiveSkipPermissions } from './skip-permissions.js';

describe('effectiveSkipPermissions (ADR-0039)', () => {
  it.each([
    [true, false, false, true],
    [true, true, false, true],
    [false, true, false, false],
    [false, false, false, false],
    [null, true, false, true],
    [null, false, false, false],
    [null, null, false, false],
    [undefined, true, false, true],
    // A reviewer or QA session never skips permissions.
    [true, true, true, false],
    [null, true, true, false],
  ] as const)('ticket %s, machine %s, review %s → %s', (ticket, machine, review, want) => {
    expect(effectiveSkipPermissions(ticket, machine, review)).toBe(want);
  });
});
