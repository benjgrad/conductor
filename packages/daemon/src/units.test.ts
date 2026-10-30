import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type MachineFacts } from './config.js';
import { PortPool, PortPoolExhaustedError, portEnv } from './ports.js';
import { DaemonStore } from './store.js';
import { buildAppendSystemPrompt, CONDUCTOR_INSTRUCTIONS } from './system-prompt.js';
import { cloneSource, repoSlug } from './workspace.js';
import { backoffDelay } from './ws-client.js';

const facts: MachineFacts = { cpuTotal: 8, memTotalMb: 16384, hostname: 'box', home: '/home/me' };

describe('loadConfig', () => {
  it('defaults: localhost orchestrator on CONDUCTOR_PORT, 25 % owner reserve, port pool', () => {
    const c = loadConfig({}, facts);
    expect(c.orchestratorUrl).toBe('ws://127.0.0.1:7400/ws/daemon');
    expect(c.rootDir).toBe(resolve('/home/me', '.conductor'));
    expect(c.machineId).toBe('box');
    expect(c.budgetCpu).toBe(6);
    expect(c.budgetMemMb).toBe(12288);
    expect(c.maxSessions).toBe(6); // min(6 cores / 1, 12288 MB / 2048)
    expect(c.maxConcurrentBuilds).toBe(2);
    expect(c.portPool).toEqual({ start: 41000, end: 48999, rangeSize: 10 });
  });

  it('reads env overrides and rejects bad values', () => {
    const c = loadConfig(
      {
        CONDUCTOR_PORT: '7999',
        CONDUCTOR_TAGS: 'gpu, mac ,',
        CONDUCTOR_MAX_SESSIONS: '3',
        CONDUCTOR_PORT_POOL: '50000-50099',
      },
      facts,
    );
    expect(c.orchestratorUrl).toBe('ws://127.0.0.1:7999/ws/daemon');
    expect(c.tags).toEqual(['gpu', 'mac']);
    expect(c.maxSessions).toBe(3);
    expect(c.portPool.start).toBe(50000);
    expect(() => loadConfig({ CONDUCTOR_MAX_SESSIONS: 'x' }, facts)).toThrow();
    expect(() => loadConfig({ CONDUCTOR_PORT_POOL: '5-6' }, facts)).toThrow();
    expect(() => loadConfig({ CONDUCTOR_MAX_CONCURRENT_BUILDS: '0' }, facts)).toThrow();
  });

  it('M1-T14: local repos are off by default; repo hosts are unrestricted unless listed', () => {
    const d = loadConfig({}, facts);
    expect(d.allowLocalRepos).toBe(false);
    expect(d.allowedRepoHosts).toEqual([]);
    const c = loadConfig(
      {
        CONDUCTOR_ALLOW_LOCAL_REPOS: 'true',
        CONDUCTOR_ALLOWED_REPO_HOSTS: 'GitHub.com, gitlab.example.org',
      },
      facts,
    );
    expect(c.allowLocalRepos).toBe(true);
    expect(c.allowedRepoHosts).toEqual(['github.com', 'gitlab.example.org']);
    expect(loadConfig({ CONDUCTOR_ALLOW_LOCAL_REPOS: '0' }, facts).allowLocalRepos).toBe(false);
    expect(() => loadConfig({ CONDUCTOR_ALLOW_LOCAL_REPOS: 'maybe' }, facts)).toThrow();
  });
});

describe('PortPool', () => {
  it('allocates aligned ranges, reuses a session’s range, and reports exhaustion', () => {
    const pool = new PortPool({ start: 100, end: 119, rangeSize: 10 });
    expect(pool.allocate('a')).toEqual({ base: 100, count: 10 });
    expect(pool.allocate('a')).toEqual({ base: 100, count: 10 });
    expect(pool.allocate('b')).toEqual({ base: 110, count: 10 });
    expect(() => pool.allocate('c')).toThrow(PortPoolExhaustedError);
    pool.release('a');
    expect(pool.allocate('c')).toEqual({ base: 100, count: 10 });
    expect(pool.adopt('d', { base: 110, count: 10 })).toBe(false); // owned by b
    expect(pool.adopt('b', { base: 105, count: 10 })).toBe(false); // misaligned
    expect(portEnv({ base: 100, count: 10 })).toEqual({
      CONDUCTOR_PORT_BASE: '100',
      PORT: '100',
      CONDUCTOR_PORT_COUNT: '10',
    });
  });
});

describe('DaemonStore', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ev = (sid = '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f') => ({
    type: 'session_event' as const,
    msg_id: '00000000-0000-4000-8000-000000000001',
    session_id: sid,
    fencing_token: 1,
    payload: { kind: 'heartbeat' as const, data: {} },
  });

  it('persists seq, buffered events, acks and sessions across instances', () => {
    dir = mkdtempSync(join(tmpdir(), 'conductor-store-'));
    const s = DaemonStore.forRoot(dir);
    expect(s.lastSeq).toBeNull();
    s.onRegistered(null);
    expect(s.pushEvent(ev(), true).seq).toBe(0);
    expect(s.pushEvent(ev(), false).seq).toBeNull();
    s.recordAck('c1', { accepted: false, reason: 'max_sessions' });
    const t = DaemonStore.forRoot(dir);
    expect(t.lastSeq).toBe(0);
    expect(t.events.map((e) => e.seq)).toEqual([0, null]);
    expect(t.ackFor('c1')).toEqual({ accepted: false, reason: 'max_sessions' });
  });

  it('onRegistered: drops confirmed events, sequences the rest from max(local+1, last_seq+1)', () => {
    dir = mkdtempSync(join(tmpdir(), 'conductor-store-'));
    const s = DaemonStore.forRoot(dir);
    s.onRegistered(null);
    s.pushEvent(ev(), true); // 0
    s.pushEvent(ev(), true); // 1
    s.pushEvent(ev(), true); // 2
    s.pushEvent(ev(), false);
    expect(s.onRegistered(0).map((e) => e.seq)).toEqual([1, 2, 3]);
    // orchestrator ahead of local
    s.pushEvent(ev(), false);
    expect(s.onRegistered(50).map((e) => e.seq)).toEqual([51]);
    expect(s.lastSeq).toBe(51);
    // no events, orchestrator ahead: the next assigned seq is above it
    s.onRegistered(80);
    expect(s.pushEvent(ev(), true).seq).toBe(81);
  });
});

describe('helpers', () => {
  it('cloneSource / repoSlug', () => {
    expect(cloneSource('github.com/org/app')).toBe('https://github.com/org/app.git');
    expect(cloneSource('/srv/repos/app', { allowLocalRepos: true })).toBe('/srv/repos/app');
    expect(cloneSource('git@github.com:org/app.git')).toBe('git@github.com:org/app.git');
    expect(cloneSource('file:///tmp/x', { allowLocalRepos: true })).toBe('file:///tmp/x');
    expect(repoSlug('github.com/org/app')).toMatch(/^github\.com_org_app-[0-9a-f]{8}$/);
    expect(repoSlug('a/b')).not.toBe(repoSlug('a_b'));
  });

  it('backoff grows exponentially with jitter and is capped', () => {
    const cfg = { initialMs: 100, maxMs: 1000, factor: 2 };
    expect(backoffDelay(cfg, 0, () => 0.5)).toBe(100);
    expect(backoffDelay(cfg, 3, () => 0.5)).toBe(800);
    expect(backoffDelay(cfg, 10, () => 0.5)).toBe(1000);
    expect(backoffDelay(cfg, 10, () => 1)).toBe(1200);
    expect(backoffDelay(cfg, 0, () => 0)).toBe(80);
  });

  it('appendSystemPrompt carries CLAUDE.md after the conductor instructions', () => {
    expect(buildAppendSystemPrompt(null)).toBe(CONDUCTOR_INSTRUCTIONS);
    expect(buildAppendSystemPrompt('  ')).toBe(CONDUCTOR_INSTRUCTIONS);
    expect(buildAppendSystemPrompt('use pnpm')).toMatch(
      /^You are running[\s\S]*# Repository instructions \(CLAUDE\.md[^\n]*\)\n\nuse pnpm$/,
    );
  });

  it('tells the agent to attempt commands and ask on a denial, not refuse (ADR-0023)', () => {
    expect(CONDUCTOR_INSTRUCTIONS).toMatch(/installing toolchains/);
    expect(CONDUCTOR_INSTRUCTIONS).toMatch(/If a command needs approval, just run it/);
    expect(CONDUCTOR_INSTRUCTIONS).toMatch(/If a call is denied[^\n]*`ask_user`/);
    expect(CONDUCTOR_INSTRUCTIONS).toMatch(
      /AskUserQuestion\), use a permission prompt or `ask_user`/,
    );
    expect(CONDUCTOR_INSTRUCTIONS).toMatch(/every push waits for a human to approve it/);
    expect(CONDUCTOR_INSTRUCTIONS).toMatch(/Never force-push/);
  });
});
