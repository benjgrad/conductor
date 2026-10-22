import type { PortPoolConfig } from './config.js';
import type { PortRange } from './store.js';

// Per-session port ranges from a fixed pool (07 §Ports). Ranges are aligned to `rangeSize`
// from `start`. The env passed to the session is CONDUCTOR_PORT_BASE, PORT, CONDUCTOR_PORT_COUNT.

export class PortPoolExhaustedError extends Error {
  constructor() {
    super('port pool exhausted');
  }
}

export class PortPool {
  private readonly owners = new Map<number, string>(); // base → session_id

  constructor(private readonly cfg: PortPoolConfig) {}

  get capacity(): number {
    return Math.floor((this.cfg.end - this.cfg.start + 1) / this.cfg.rangeSize);
  }

  /** Re-adopt a range persisted for a session (after a daemon restart). False if unusable. */
  adopt(sessionId: string, range: PortRange): boolean {
    const off = range.base - this.cfg.start;
    if (
      range.count !== this.cfg.rangeSize ||
      off < 0 ||
      off % this.cfg.rangeSize !== 0 ||
      range.base + range.count - 1 > this.cfg.end
    ) {
      return false;
    }
    const owner = this.owners.get(range.base);
    if (owner !== undefined && owner !== sessionId) return false;
    this.owners.set(range.base, sessionId);
    return true;
  }

  /** The session's existing range, else the first free one. Throws PortPoolExhaustedError. */
  allocate(sessionId: string): PortRange {
    const existing = this.rangeOf(sessionId);
    if (existing) return existing;
    for (let i = 0; i < this.capacity; i++) {
      const base = this.cfg.start + i * this.cfg.rangeSize;
      if (!this.owners.has(base)) {
        this.owners.set(base, sessionId);
        return { base, count: this.cfg.rangeSize };
      }
    }
    throw new PortPoolExhaustedError();
  }

  rangeOf(sessionId: string): PortRange | undefined {
    for (const [base, owner] of this.owners) {
      if (owner === sessionId) return { base, count: this.cfg.rangeSize };
    }
    return undefined;
  }

  release(sessionId: string): void {
    for (const [base, owner] of [...this.owners]) {
      if (owner === sessionId) this.owners.delete(base);
    }
  }

  get allocated(): number {
    return this.owners.size;
  }
}

export function portEnv(range: PortRange): Record<string, string> {
  return {
    CONDUCTOR_PORT_BASE: String(range.base),
    PORT: String(range.base),
    CONDUCTOR_PORT_COUNT: String(range.count),
  };
}
