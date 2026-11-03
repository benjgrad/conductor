import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileConfig, writeFileConfig, type DaemonFileConfig } from './config.js';
import { loadCredential, writeCredential, type MachineCredential } from './credential.js';
import { inventoryPayload, type InventoryScan } from './inventory/report.js';
import { mkdirPrivate, writePrivateFile } from './platform/index.js';
import { DaemonStore, type DurableMessage, type PersistedSession } from './store.js';

// MR-T05 FR-5 (the one test-only addition to packages/daemon during the freeze): the TS daemon and
// the Rust daemon (crates/conductor-daemon) read each other's machine.json, config.json and store
// file, so a machine upgrades in place without re-enrolling (ADR-0026 §4).
//
// - `tests/fixtures/ts/*` are written by this file: `UPDATE_TS_FIXTURES=1 pnpm vitest run
//   --project daemon src/rust-compat.test.ts` regenerates them; otherwise this test checks they
//   are still what the TS code writes. `crates/conductor-daemon/tests/compat_ts_files.rs` reads
//   them.
// - `tests/fixtures/rust/*` are written by that Rust test (`UPDATE_RUST_FIXTURES=1`); this file
//   reads them. Both sides build the same content (keep SAMPLE_* in step with the Rust test).

const FIXTURES = fileURLToPath(
  new URL('../../../crates/conductor-daemon/tests/fixtures/', import.meta.url),
);
const TS_DIR = join(FIXTURES, 'ts');
const RUST_DIR = join(FIXTURES, 'rust');

const SAMPLE_CRED: MachineCredential = {
  url: 'https://conductor.example.com',
  machine_id: 'm-1',
  credential: 'secret-xyz',
};

const SAMPLE_CONFIG: DaemonFileConfig = {
  roots: ['/src/a', '/src/b'],
  repos: {
    'github.com/org/app': { mode: 'checkout' },
    'github.com/org/lib': { mode: 'reference' },
  },
};

const SID = '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f';

const HEARTBEAT: DurableMessage = {
  type: 'session_event',
  msg_id: '00000000-0000-4000-8000-000000000001',
  session_id: SID,
  fencing_token: 1,
  payload: { kind: 'heartbeat', data: {} },
};

const PERMISSION: DurableMessage = {
  type: 'permission_request',
  msg_id: '00000000-0000-4000-8000-0000000a0001',
  session_id: SID,
  fencing_token: 1,
  payload: {
    request_id: '4f3e2d1c-0b9a-4876-9543-210fedcba987',
    session_id: SID,
    tool: 'Bash',
    input: { command: 'pnpm exec tsc -b' },
    expires_at: '2026-10-22T12:30:00.000Z',
  },
};

const session = (over: Partial<PersistedSession>): PersistedSession => ({
  ticketId: 'b1d1f6a2-6c8e-4f3a-9d2b-0e1f2a3b4c5d',
  repo: 'github.com/org/app',
  worktreePath: '/home/me/.conductor/wt/s',
  branch: 'conductor/t/s',
  portRange: { base: 41000, count: 10 },
  claudeSessionId: '3c1f7a52-2b9e-4d61-8f04-6e5d4c3b2a19',
  lastUsedAt: 1_793_095_872_000,
  ...over,
});

const SESSIONS: Record<string, PersistedSession> = {
  'session-a': session({ portRange: null, claudeSessionId: null }),
  'session-b': session({ agent: null }),
  'session-c': session({
    agent: {
      commandId: '11111111-1111-4111-8111-111111111111',
      fencingToken: 2,
      pid: 4242,
      claudeSessionId: '3c1f7a52-2b9e-4d61-8f04-6e5d4c3b2a19',
      startedAt: 1_793_095_872_000,
    },
  }),
};

/** The sample store, built through the store's own API. */
function buildStore(file: string): DaemonStore {
  const s = new DaemonStore(file);
  s.onRegistered(null);
  s.pushEvent(HEARTBEAT, true); // seq 0
  s.pushEvent(PERMISSION, false); // unsequenced
  s.recordAck('c1', { accepted: false, reason: 'max_sessions' });
  s.recordAck('c2', { accepted: true });
  for (const [id, sess] of Object.entries(SESSIONS)) s.putSession(id, sess);
  s.putRepo('github.com/org/app', '/home/me/.conductor/repos/github.com_org_app-0a1b2c3d');
  return s;
}

/** A private copy of a fixture (git checks files out world-readable). */
function privateCopy(src: string, dir: string, name: string): string {
  mkdirPrivate(dir);
  const path = join(dir, name);
  writePrivateFile(path, readFileSync(src, 'utf8'));
  return path;
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'conductor-compat-'));
  // win32: %TEMP% is not owner-only, and mkdirPrivate refuses to create under it.
  mkdirPrivate(tmp);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('Rust daemon file compatibility (MR-T05)', () => {
  it('the TS fixtures are what the TS daemon writes', () => {
    const root = join(tmp, 'root');
    writeCredential(root, SAMPLE_CRED, { force: false });
    writeFileConfig(root, SAMPLE_CONFIG);
    buildStore(join(root, 'state', 'daemon.json'));
    const written: Record<string, string> = {
      'machine.json': readFileSync(join(root, 'machine.json'), 'utf8'),
      'config.json': readFileSync(join(root, 'config.json'), 'utf8'),
      'daemon.json': readFileSync(join(root, 'state', 'daemon.json'), 'utf8'),
    };
    for (const [name, text] of Object.entries(written)) {
      if (process.env.UPDATE_TS_FIXTURES === '1') writeFileSync(join(TS_DIR, name), text);
      expect(readFileSync(join(TS_DIR, name), 'utf8').replace(/\r\n/g, '\n'), name).toBe(text);
    }
  });

  it('reads the machine.json, config.json and store the Rust daemon wrote', () => {
    const root = join(tmp, 'root');
    privateCopy(join(RUST_DIR, 'machine.json'), root, 'machine.json');
    privateCopy(join(RUST_DIR, 'config.json'), root, 'config.json');
    expect(loadCredential(root)).toEqual(SAMPLE_CRED);
    expect(readFileConfig(root)).toEqual(SAMPLE_CONFIG);

    const store = new DaemonStore(join(RUST_DIR, 'daemon.json'));
    expect(store.lastSeq).toBe(0);
    expect(store.events).toEqual([
      { seq: 0, msg: HEARTBEAT },
      { seq: null, msg: PERMISSION },
    ]);
    expect(store.ackFor('c1')).toEqual({ accepted: false, reason: 'max_sessions' });
    expect(store.ackFor('c2')).toEqual({ accepted: true });
    expect(store.sessions).toEqual(SESSIONS);
    expect('agent' in store.sessions['session-a']!).toBe(false);
    expect(store.repos).toEqual({
      'github.com/org/app': '/home/me/.conductor/repos/github.com_org_app-0a1b2c3d',
    });
  });
});

// MR-T11 FR-3: the Rust inventory payload and hash are identical to TS's for the same scan, so a
// machine moving from TS to Rust doesn't look changed. `tests/fixtures/ts/inventory-payload.json`
// is written here (`UPDATE_TS_FIXTURES=1`, as above) and read by `inventory/report/tests.rs`.
// The cases cover the string-order and escaping edges: a `"` and `\\` in a path, non-ASCII, a
// non-BMP emoji against U+FF01 (UTF-16 order differs from UTF-8 byte order there), and a Windows
// path.
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(64);
const INVENTORY_CASES: { name: string; scan: InventoryScan }[] = [
  { name: 'empty', scan: { repos: [], capabilities: [] } },
  {
    name: 'every kind, out of order',
    scan: {
      repos: [
        {
          path: '/Users/ben/code/zeta',
          remote: null,
          default_branch: 'master',
          head_commit: SHA_B,
          mode: 'checkout',
        },
        {
          path: '/Users/ben/code/app',
          remote: 'github.com/org/app',
          default_branch: 'main',
          head_commit: SHA_A,
          mode: 'reference',
        },
      ],
      capabilities: [
        { kind: 'skill', name: 'review', repo: 'github.com/org/app' },
        { kind: 'claude', version: '2.1.308' },
        { kind: 'cli', name: 'gh', version: '2.50.0', authed: true },
        { kind: 'cli', name: 'az', version: null, authed: false },
        { kind: 'agent', name: 'planner' },
        { kind: 'mcp', name: 'slack' },
        { kind: 'skill', name: 'review' },
        { kind: 'agent', name: 'planner', repo: 'github.com/org/app' },
      ],
    },
  },
  {
    name: 'awkward strings',
    scan: {
      repos: [
        {
          path: '/tmp/\uff01-full-width',
          remote: 'gitlab.example.com/Group/Sub/Repo',
          default_branch: 'release/2.0',
          head_commit: SHA_A,
          mode: 'reference',
        },
        {
          path: '/tmp/\u{1f600}-emoji',
          remote: null,
          default_branch: 'main',
          head_commit: SHA_A,
          mode: 'reference',
        },
        {
          path: '/tmp/quote"back\\slash/caf\u00e9',
          remote: null,
          default_branch: 'main',
          head_commit: SHA_A,
          mode: 'reference',
        },
        {
          path: 'C:\\Users\\ben\\code\\app',
          remote: 'github.com/org/app',
          default_branch: 'main',
          head_commit: SHA_A,
          mode: 'checkout',
        },
      ],
      capabilities: [
        { kind: 'mcp', name: '\uff01x' },
        { kind: 'mcp', name: '\u{1f600}x' },
        { kind: 'skill', name: 'caf\u00e9' },
        { kind: 'cli', name: 'jira', version: '1.5.1-rc.1', authed: false },
      ],
    },
  },
];

describe('Rust inventory payload compatibility (MR-T11)', () => {
  it('the TS inventory vector is what the TS daemon computes', () => {
    const cases = INVENTORY_CASES.map(({ name, scan }) => ({
      name,
      scan,
      payload: inventoryPayload(scan),
    }));
    const text = `${JSON.stringify(cases, null, 2)}\n`;
    const file = join(TS_DIR, 'inventory-payload.json');
    if (process.env.UPDATE_TS_FIXTURES === '1') writeFileSync(file, text);
    expect(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).toBe(text);
  });
});
