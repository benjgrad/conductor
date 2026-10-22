// FIFO counting semaphore for the per-machine build slots (07 §Compute, `max_concurrent_builds`).

export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly size: number) {
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError(`semaphore size must be a positive integer, got ${size}`);
    }
  }

  get inUse(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /** Take a slot now if one is free. */
  tryAcquire(): boolean {
    if (this.active >= this.size) return false;
    this.active++;
    return true;
  }

  /**
   * Wait for a slot (FIFO). Resolves `true` with the slot held, or `false` if `signal` aborted
   * first (no slot held; the queue position is given up).
   */
  acquire(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (this.tryAcquire()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve(true);
      };
      const onAbort = (): void => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(false);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(grant);
    });
  }

  /** Free a slot; the oldest waiter (if any) inherits it. */
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else if (this.active > 0) this.active--;
  }
}
