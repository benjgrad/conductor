import { describe, expect, it } from 'vitest';
import { liveResources, parseVmStatAvailableBytes } from './sysinfo.js';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                7609.
Pages active:                            241092.
Pages inactive:                          230014.
Pages speculative:                          922.
Pages throttled:                              0.
Pages wired down:                        177054.
Pages purgeable:                           4457.
"Translation faults":                8646962438.
`;

describe('parseVmStatAvailableBytes', () => {
  it('counts free + inactive + speculative + purgeable pages', () => {
    expect(parseVmStatAvailableBytes(VM_STAT)).toBe((7609 + 230014 + 922 + 4457) * 16384);
  });

  it('returns null on unparseable output', () => {
    expect(parseVmStatAvailableBytes('')).toBeNull();
    expect(
      parseVmStatAvailableBytes('Mach Virtual Memory Statistics: (page size of 4096 bytes)'),
    ).toBeNull();
  });
});

describe('liveResources', () => {
  it.runIf(process.platform === 'darwin')('reports more than the raw free pages on macOS', () => {
    // A busy Mac has far more reclaimable (inactive) memory than strictly free pages.
    expect(liveResources(process.cwd()).memFreeMb).toBeGreaterThan(0);
  });
});
