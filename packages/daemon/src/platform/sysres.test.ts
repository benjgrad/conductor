import type { CpuInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { busyCores, busyCoresBetween } from './sysres.js';

const core = (busy: number, idle: number): CpuInfo => ({
  model: 'x',
  speed: 1,
  times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
});

describe('busyCoresBetween (win32 CPU, ADR-0024 §8)', () => {
  it('is the busy share of the elapsed time times the cores', () => {
    const prev = [core(100, 100), core(100, 100)];
    // core 1: 100 busy of 200 elapsed; core 2: 0 busy of 200 → 25 % of 2 cores
    const now = [core(200, 200), core(100, 300)];
    expect(busyCoresBetween(prev, now)).toBeCloseTo(0.5);
    expect(busyCoresBetween(now, now)).toBe(0);
  });

  it('busyCores is a number between 0 and the core count on every OS', () => {
    for (let i = 0; i < 2; i++) {
      const b = busyCores();
      expect(b).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(b)).toBe(true);
    }
  });
});
