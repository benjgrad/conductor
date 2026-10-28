import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { daemonWsUrl, loadCredential, writeCredential } from './credential.js';
import { mkdirPrivate, writePrivateFile } from './platform/index.js';

const onWin32 = process.platform === 'win32';

/** Let other users read `path`: chmod 644/755 (POSIX), or grant Everyone read (win32). */
function widen(path: string, kind: 'file' | 'dir' = 'file'): void {
  if (onWin32) execFileSync('icacls', [path, '/grant', '*S-1-1-0:R']);
  else chmodSync(path, kind === 'dir' ? 0o755 : 0o644);
}

// M2-T04: `<root>/machine.json` checks and the config it feeds.

const CRED = { url: 'https://conductor.example.com', machine_id: 'm-1', credential: 'secret-xyz' };
const FACTS = { cpuTotal: 8, memTotalMb: 16_384, hostname: 'host-a', home: '/home/x' };

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'conductor-cred-'));
  mkdirPrivate(tmp);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('loadCredential', () => {
  it('is null (local mode) without a root or a file', () => {
    expect(loadCredential(join(tmp, 'missing'))).toBeNull();
    expect(loadCredential(tmp)).toBeNull();
  });

  it('round-trips what writeCredential wrote', () => {
    const root = join(tmp, 'root');
    writeCredential(root, CRED, { force: false });
    expect(loadCredential(root)).toEqual(CRED);
  });

  it('refuses a group/other-readable file and says how to fix it', () => {
    const root = join(tmp, 'root');
    const path = writeCredential(root, CRED, { force: false });
    widen(path);
    expect(() => loadCredential(root)).toThrow(
      onWin32 ? /accessible to other users \(S-1-1-0\); run: icacls/ : `chmod 600 ${path}`,
    );
  });

  it('refuses a root other users can read (win32: any non-owner-only DACL)', () => {
    const root = join(tmp, 'root');
    writeCredential(root, CRED, { force: false });
    widen(root, 'dir');
    // POSIX checks only a root's type and owner (ADR-0010); win32 checks its DACL (ADR-0024 §3).
    if (onWin32) expect(() => loadCredential(root)).toThrow(/accessible to other users/);
    else expect(loadCredential(root)).toEqual(CRED);
  });

  it('refuses a symlinked file and a symlinked root', () => {
    const root = join(tmp, 'root');
    mkdirPrivate(root);
    const elsewhere = join(tmp, 'elsewhere.json');
    writeFileSync(elsewhere, JSON.stringify(CRED), { mode: 0o600 });
    symlinkSync(elsewhere, join(root, 'machine.json'));
    expect(() => loadCredential(root)).toThrow(/symlink/);

    const real = join(tmp, 'real');
    writeCredential(real, CRED, { force: false });
    const link = join(tmp, 'link');
    symlinkSync(real, link);
    expect(() => loadCredential(link)).toThrow(/symlink/);
  });

  it('refuses invalid content without echoing it', () => {
    const root = join(tmp, 'root');
    mkdirPrivate(root);
    writePrivateFile(join(root, 'machine.json'), JSON.stringify({ ...CRED, url: 'ftp://x' }));
    let msg = '';
    try {
      loadCredential(root);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/invalid \(url\)/);
    expect(msg).not.toContain(CRED.credential);
  });
});

describe('machine.json url', () => {
  it('rejects plain http to a non-loopback host, on load and on write', () => {
    const root = join(tmp, 'root');
    mkdirPrivate(root);
    writePrivateFile(
      join(root, 'machine.json'),
      JSON.stringify({ ...CRED, url: 'http://conductor.example.com' }),
    );
    expect(() => loadCredential(root)).toThrow(/invalid \(url\)/);
    expect(() =>
      writeCredential(
        join(tmp, 'other'),
        { ...CRED, url: 'http://conductor.example.com' },
        { force: false },
      ),
    ).toThrow();
    writeCredential(join(tmp, 'ok'), { ...CRED, url: 'http://127.0.0.1:8080' }, { force: false });
    expect(loadCredential(join(tmp, 'ok'))?.url).toBe('http://127.0.0.1:8080');
  });
});

describe('daemonWsUrl', () => {
  it('maps https → wss and http → ws on the daemon WS path', () => {
    expect(daemonWsUrl('https://conductor.example.com/')).toBe(
      'wss://conductor.example.com/ws/daemon',
    );
    expect(daemonWsUrl('http://127.0.0.1:8080/x?y=1#z')).toBe('ws://127.0.0.1:8080/ws/daemon');
  });
});

describe('loadConfig with machine.json', () => {
  it('uses the enrolled machine id, the stored url and the credential', () => {
    const c = loadConfig({ CONDUCTOR_MACHINE_ID: 'ignored' }, FACTS, () => CRED);
    expect(c.machineId).toBe('m-1');
    expect(c.orchestratorUrl).toBe('wss://conductor.example.com/ws/daemon');
    expect(c.credential).toBe('secret-xyz');
  });

  it('refuses a cleartext URL to a non-loopback host when enrolled', () => {
    expect(() =>
      loadConfig(
        { CONDUCTOR_ORCHESTRATOR_URL: 'ws://conductor.example.com/ws/daemon' },
        FACTS,
        () => CRED,
      ),
    ).toThrow(/CONDUCTOR_ORCHESTRATOR_URL .* cleartext/);
    expect(() =>
      loadConfig({}, FACTS, () => ({ ...CRED, url: 'http://conductor.example.com' })),
    ).toThrow(/machine\.json .* cleartext/);
    // Loopback and wss are fine; local mode (no credential) is never checked.
    expect(
      loadConfig({ CONDUCTOR_ORCHESTRATOR_URL: 'ws://localhost:1/ws/daemon' }, FACTS, () => CRED)
        .orchestratorUrl,
    ).toBe('ws://localhost:1/ws/daemon');
    expect(
      loadConfig(
        { CONDUCTOR_ORCHESTRATOR_URL: 'ws://conductor.example.com/ws/daemon' },
        FACTS,
        () => null,
      ).credential,
    ).toBeNull();
  });

  it('CONDUCTOR_ORCHESTRATOR_URL still wins', () => {
    const c = loadConfig(
      { CONDUCTOR_ORCHESTRATOR_URL: 'ws://127.0.0.1:1/ws/daemon' },
      FACTS,
      () => CRED,
    );
    expect(c.orchestratorUrl).toBe('ws://127.0.0.1:1/ws/daemon');
  });

  it('local mode is unchanged', () => {
    const c = loadConfig({ CONDUCTOR_MACHINE_ID: 'laptop' }, FACTS, () => null);
    expect(c.machineId).toBe('laptop');
    expect(c.credential).toBeNull();
    expect(c.orchestratorUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws\/daemon$/);
  });

  it('daemonVersion appends CONDUCTOR_BUILD_SHA', () => {
    const plain = loadConfig({}, FACTS, () => null).daemonVersion;
    expect(plain).toMatch(/^\d+\.\d+\.\d+/);
    expect(loadConfig({ CONDUCTOR_BUILD_SHA: '3b18e51' }, FACTS, () => null).daemonVersion).toBe(
      `${plain}+3b18e51`,
    );
  });
});
