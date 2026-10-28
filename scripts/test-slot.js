// @ts-check
// Machine-wide test slots (M2-T31): at most CONDUCTOR_TEST_SLOTS (default 2) vitest / eslint runs
// at once on this machine, across every worktree, conductor session and Claude subagent. Without
// it a dozen parallel gate runs pushed the load average past 40 on 4 cores and tests timed out.
//
// A slot is a localhost TCP port (CONDUCTOR_TEST_SLOT_PORT, default 54330, then +1 per slot) held
// by a listening server. The OS frees the port when the holder exits, even on SIGKILL, so there is
// no stale lock to clean up. A waiter connects to a held port to learn who holds it.
//
// Used two ways:
//   - vitest.config.ts `globalSetup` (scripts/test-slot-setup.js): every vitest run, whichever way
//     it was started (`pnpm test`, `pnpm exec vitest`, `npx vitest`), loads the config.
//   - CLI wrapper: `node scripts/test-slot.js <cmd> [args…]` (the `lint` script wraps eslint).
//
// A holder sets CONDUCTOR_TEST_SLOT_HELD=1 for its children, so a nested run (a test that spawns
// vitest, a wrapped command that runs vitest) never waits on its own parent's slot.
import { execFileSync, spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { availableParallelism } from 'node:os';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HELD_ENV = 'CONDUCTOR_TEST_SLOT_HELD';
const MAGIC = 'conductor-test-slot';

/**
 * @typedef {object} SlotOptions
 * @property {number} slots     how many runs may hold a slot at once (0 = no limit)
 * @property {number} basePort  first slot's port; slot i is basePort + i
 * @property {number} maxWaitMs give up (throw) after waiting this long
 * @property {number} pollMs    how often to retry while every slot is held
 * @property {number} reportMs  how often to print who is holding the slots
 * @property {string} label     who we are, shown to waiters (branch + tool)
 * @property {(line: string) => void} log
 */

/** @param {NodeJS.ProcessEnv} env @param {string} label @returns {SlotOptions} */
export function slotOptionsFromEnv(env, label) {
  return {
    slots: intEnv(env, 'CONDUCTOR_TEST_SLOTS', 2),
    basePort: intEnv(env, 'CONDUCTOR_TEST_SLOT_PORT', 54330),
    maxWaitMs: intEnv(env, 'CONDUCTOR_TEST_SLOT_WAIT_S', 30 * 60) * 1000,
    pollMs: 1000,
    reportMs: 30_000,
    label,
    log: (line) => process.stderr.write(`${line}\n`),
  };
}

/** Vitest workers per run, so that every slot together uses about the whole machine. */
export function workersPerSlot(env = process.env) {
  const slots = intEnv(env, 'CONDUCTOR_TEST_SLOTS', 2);
  return Math.max(1, Math.floor(availableParallelism() / Math.max(1, slots)));
}

/** "<branch or dir> (<tool>)", e.g. "m2-t31-test-slots (vitest)". @param {string} tool */
export function slotLabel(tool, cwd = process.cwd()) {
  let where = '';
  try {
    where = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // not a checkout: fall back to the directory name
  }
  if (!where || where === 'HEAD') where = basename(cwd);
  return `${where} (${tool})`;
}

/**
 * Wait for a free slot and hold it. Resolves to `release` (idempotent). With `slots` 0, or when
 * an ancestor process already holds a slot, it holds nothing and resolves at once.
 *
 * @param {SlotOptions} opts
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<() => Promise<void>>}
 */
export async function acquireSlot(opts, env = process.env) {
  if (opts.slots <= 0 || env[HELD_ENV] === '1') return async () => {};
  const started = Date.now();
  let reported = 0;
  for (;;) {
    for (let i = 0; i < opts.slots; i++) {
      const server = await tryListen(opts.basePort + i, opts.label, started);
      if (server) {
        if (reported > 0) opts.log(`test slot: got slot ${i + 1} after ${since(started)}`);
        env[HELD_ENV] = '1';
        let closed = false;
        return async () => {
          if (closed) return;
          closed = true;
          delete env[HELD_ENV];
          await new Promise((resolve) => server.close(() => resolve(undefined)));
        };
      }
    }
    const waited = Date.now() - started;
    if (waited >= opts.maxWaitMs) {
      throw new Error(
        `test slot: every slot was held for ${since(started)}: ${await holders(opts)}. ` +
          'Another run on this machine is using them; try again when it finishes.',
      );
    }
    if (reported === 0 || waited - reported >= opts.reportMs) {
      reported = Math.max(1, waited);
      opts.log(
        `test slot: waiting for a free slot (${opts.slots} on this machine, held by ` +
          `${await holders(opts)}). This is a queue, not a hang; the run starts by itself.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs));
  }
}

/**
 * Listen on 127.0.0.1:port; null if it's taken. Each connection gets one line naming the holder.
 * @param {number} port @param {string} label @param {number} started
 * @returns {Promise<import('node:net').Server | null>}
 */
function tryListen(port, label, started) {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.end(`${MAGIC} ${JSON.stringify({ label, pid: process.pid, since: started })}\n`);
    });
    server.once('error', () => resolve(null));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.unref(); // never keeps the process alive; exiting frees the slot
      resolve(server);
    });
  });
}

/** "a (vitest, 2m10s), b (eslint, 40s)" for the held slots. @param {SlotOptions} opts */
async function holders(opts) {
  const names = await Promise.all(
    Array.from({ length: opts.slots }, (_, i) => describePort(opts.basePort + i)),
  );
  return names.join(', ');
}

/** @param {number} port @returns {Promise<string>} */
function describePort(port) {
  return new Promise((resolve) => {
    let data = '';
    const socket = createConnection({ port, host: '127.0.0.1' });
    const done = (/** @type {string} */ text) => {
      socket.destroy();
      resolve(text);
    };
    socket.setTimeout(1000, () => done(`port ${port}: no answer`));
    socket.on('data', (chunk) => (data += String(chunk)));
    socket.on('error', () => done(`port ${port}: free`));
    socket.on('end', () => {
      if (!data.startsWith(`${MAGIC} `)) return done(`port ${port}: another program`);
      try {
        /** @type {unknown} */
        const raw = JSON.parse(data.slice(MAGIC.length + 1));
        const h = /** @type {{ label: string, since: number }} */ (raw);
        done(`${h.label} for ${since(h.since)}`);
      } catch {
        done(`port ${port}: unreadable`);
      }
    });
  });
}

/** @param {number} t */
function since(t) {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/** @param {NodeJS.ProcessEnv} env @param {string} name @param {number} fallback */
function intEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, got ${raw}`);
  return n;
}

// CLI: node scripts/test-slot.js <cmd> [args…] runs <cmd> inside a slot and exits with its code.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    process.stderr.write('usage: node scripts/test-slot.js <cmd> [args…]\n');
    process.exit(2);
  }
  const release = await acquireSlot(slotOptionsFromEnv(process.env, slotLabel(basename(cmd))));
  const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
    process.on(sig, () => child.kill(sig));
  }
  child.on('error', (err) => {
    process.stderr.write(`test slot: could not run ${cmd}: ${err.message}\n`);
    process.exitCode = 127;
  });
  child.on('close', (code, signal) => {
    void release().then(() => {
      if (process.exitCode === undefined) process.exitCode = code ?? (signal ? 1 : 0);
    });
  });
}
