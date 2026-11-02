import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileConfig, writeFileConfig, type DaemonFileConfig } from './config.js';
import { loadCredential, writeCredential, type MachineCredential } from './credential.js';
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
