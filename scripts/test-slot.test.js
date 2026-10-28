// @ts-check
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELD_ENV, acquireSlot } from './test-slot.js';

const SCRIPT = fileURLToPath(new URL('./test-slot.js', import.meta.url));

/** Ports away from the real slots (54330+) and the daemon's pool (41000-48999). */
const freshBase = () => 20_000 + Math.floor(Math.random() * 900) * 20;

/** @param {Partial<import('./test-slot.js').SlotOptions>} over */
function options(over = {}) {
  /** @type {string[]} */
  const lines = [];
  return {
    lines,
    opts: {
      slots: 1,
      basePort: freshBase(),
      maxWaitMs: 10_000,
      pollMs: 20,
      reportMs: 60_000,
      label: 'test (vitest)',
      log: (/** @type {string} */ line) => lines.push(line),
      ...over,
    },
  };
}

describe('acquireSlot (M2-T31)', () => {
  it('a second run waits until the first releases, and is told who holds the slot', async () => {
    const { opts, lines } = options();
    const first = await acquireSlot(opts, {});
    let second = /** @type {(() => Promise<void>) | null} */ (null);
    const waiting = acquireSlot({ ...opts, label: 'other (eslint)' }, {}).then((r) => (second = r));
    await new Promise((r) => setTimeout(r, 200));
    expect(second).toBeNull();
    expect(lines.join('\n')).toMatch(/waiting for a free slot .*held by test \(vitest\) for \d+s/);
    await first();
    await waiting;
    expect(second).not.toBeNull();
    await second?.();
  });

  it('two slots admit two runs at once', async () => {
    const { opts } = options({ slots: 2 });
    const a = await acquireSlot(opts, {});
    const b = await acquireSlot(opts, {});
    await a();
    await b();
  });

  it('holds nothing when the parent already holds a slot, or slots is 0', async () => {
    const { opts } = options();
    const held = await acquireSlot(opts, {});
    // Both would wait forever on the held slot if they tried to take it.
    await (
      await acquireSlot(opts, { [HELD_ENV]: '1' })
    )();
    await (
      await acquireSlot({ ...opts, slots: 0 }, {})
    )();
    await held();
  });

  it('marks the environment while held, for child processes', async () => {
    const { opts } = options();
    /** @type {NodeJS.ProcessEnv} */
    const env = {};
    const release = await acquireSlot(opts, env);
    expect(env[HELD_ENV]).toBe('1');
    await release();
    expect(env[HELD_ENV]).toBeUndefined();
  });

  it('gives up after maxWaitMs with the holders in the error (every wait is bounded)', async () => {
    const { opts } = options({ maxWaitMs: 100 });
    const held = await acquireSlot(opts, {});
    await expect(acquireSlot({ ...opts, label: 'late' }, {})).rejects.toThrow(
      /every slot was held for .*test \(vitest\)/,
    );
    await held();
  });

  it('a holder killed with SIGKILL frees its slot (no stale lock)', async () => {
    const { opts } = options({ maxWaitMs: 5_000 });
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { acquireSlot } = await import(${JSON.stringify(new URL('./test-slot.js', import.meta.url).href)});
         await acquireSlot({ slots: 1, basePort: ${opts.basePort}, maxWaitMs: 1000, pollMs: 20,
           reportMs: 60000, label: 'doomed', log: () => {} }, {});
         console.log('held'); setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await new Promise((resolve) => child.stdout.once('data', resolve));
    await expect(acquireSlot({ ...opts, maxWaitMs: 100 }, {})).rejects.toThrow(/doomed/);
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    await (
      await acquireSlot(opts, {})
    )();
  });
});

describe('node scripts/test-slot.js <cmd> (the lint wrapper)', () => {
  const run = (/** @type {string} */ code, env = {}) =>
    spawnSync(process.execPath, [SCRIPT, process.execPath, '-e', code], {
      encoding: 'utf8',
      env: {
        ...process.env,
        [HELD_ENV]: '',
        CONDUCTOR_TEST_SLOT_PORT: String(freshBase()),
        ...env,
      },
    });

  it("exits with the command's code and marks it as holding a slot", () => {
    const r = run(`console.log(process.env.${HELD_ENV}); process.exit(3)`);
    expect(r.status).toBe(3);
    expect(r.stdout.trim()).toBe('1');
  });

  it('exits 0 when the command succeeds', () => {
    expect(run('').status).toBe(0);
  });
});
