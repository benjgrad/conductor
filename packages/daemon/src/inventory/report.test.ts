import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryPayloadSchema, type Capability, type InventoryRepo } from '@conductor/shared';
import { FakeClaudeDriver } from '../claude/fake-driver.js';
import { FakeCommandRunner } from '../commands/fake-runner.js';
import { loadConfig } from '../config.js';
import { Daemon } from '../daemon.js';
import { mkdirPrivate } from '../platform/index.js';
import { FakeOrchestrator } from '../test-support/fake-orchestrator.js';
import {
  inventoryHash,
  inventoryPayload,
  InventoryReporter,
  inventorySummary,
  onceLog,
  repoWarnings,
  watchSighup,
  type InventoryScan,
} from './report.js';

// M2-T10 acceptance: `inventory` is sent after `registered`, not re-sent when unchanged, and
// re-sent on SIGHUP after a change.

const REPO: InventoryRepo = {
  path: '/Users/ben/code/app',
  remote: 'github.com/org/app',
  default_branch: 'main',
  head_commit: 'a'.repeat(40),
  mode: 'reference',
};
const GH: Capability = { kind: 'cli', name: 'gh', version: '2.50.0', authed: true };
const SLACK: Capability = { kind: 'mcp', name: 'slack' };

describe('inventoryHash', () => {
  it('is stable under reordering and changes with a version or a repo', () => {
    const b: InventoryRepo = { ...REPO, path: '/Users/ben/code/b' };
    const h = inventoryHash({ repos: [REPO, b], capabilities: [GH, SLACK] });
    expect(inventoryHash({ repos: [b, REPO], capabilities: [SLACK, GH] })).toBe(h);
    expect(
      inventoryHash({ repos: [REPO, b], capabilities: [{ ...GH, version: '2.51.0' }, SLACK] }),
    ).not.toBe(h);
    expect(
      inventoryHash({
        repos: [REPO, { ...b, head_commit: 'b'.repeat(40) }],
        capabilities: [GH, SLACK],
      }),
    ).not.toBe(h);
  });

  it('WF-T02: the payload carries git_identity_missing, which the hash ignores', () => {
    const scan = { repos: [REPO], capabilities: [GH] };
    const missing = inventoryPayload({ ...scan, gitIdentityMissing: true });
    expect(missing.git_identity_missing).toBe(true);
    expect(inventoryPayload(scan).git_identity_missing).toBe(false);
    expect(missing.hash).toBe(inventoryHash(scan));
    expect(InventoryPayloadSchema.parse(missing)).toEqual(missing);
  });
});

describe('inventory log lines (why no tickets reach a machine)', () => {
  it('repoWarnings: no roots, no repos, or a repo without a routable remote', () => {
    expect(repoWarnings([], [])).toEqual([
      'inventory: no repo roots configured, so no tickets can be routed here; run: conductor-daemon config roots <dir>',
    ]);
    expect(repoWarnings(['/a', '/b'], [])).toEqual([
      'inventory: no git repos found under /a, /b (searched 6 levels deep)',
    ]);
    const local = { ...REPO, path: '/Users/ben/code/local', remote: null };
    expect(repoWarnings(['/Users/ben/code'], [REPO, local])).toEqual([
      "inventory: /Users/ben/code/local has no usable origin remote; tickets can't be routed to it",
    ]);
  });

  it('inventorySummary names the routable remotes, de-duplicated and cut at 10', () => {
    const local = { ...REPO, path: '/l', remote: null };
    const twin = { ...REPO, path: '/twin' };
    expect(
      inventorySummary(inventoryPayload({ repos: [REPO, twin, local], capabilities: [GH] })),
    ).toBe('inventory: sent 3 repos (1 routable: github.com/org/app) and 1 capabilities');
    expect(inventorySummary(inventoryPayload({ repos: [], capabilities: [] }))).toBe(
      'inventory: sent 0 repos (0 routable) and 0 capabilities',
    );
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...REPO,
      path: `/r${String(i).padStart(2, '0')}`,
      remote: `github.com/org/r${String(i).padStart(2, '0')}`,
    }));
    const line = inventorySummary(inventoryPayload({ repos: many, capabilities: [] }));
    expect(line).toMatch(/^inventory: sent 12 repos \(12 routable: github\.com\/org\/r00, .*, …\)/);
    expect(line).toContain('github.com/org/r09');
    expect(line).not.toContain('github.com/org/r10');
  });

  it('onceLog prints each message once, and forgets everything at its cap', () => {
    const lines: string[] = [];
    const log = onceLog((m) => lines.push(m), 2);
    log('a');
    log('a');
    log('b');
    expect(lines).toEqual(['a', 'b']);
    log('c'); // cap reached: forgets a and b
    log('a');
    expect(lines).toEqual(['a', 'b', 'c', 'a']);
  });

  it('the reporter logs the summary once per distinct inventory, not on every resend', async () => {
    let scan: InventoryScan = { repos: [REPO], capabilities: [GH] };
    const lines: string[] = [];
    const r = new InventoryReporter({
      scan: () => Promise.resolve(scan),
      send: () => {},
      intervalMs: 600_000,
      log: (m) => lines.push(m),
    });
    await r.onRegistered();
    r.onDisconnected();
    await r.onRegistered(); // a reconnect re-sends the same inventory
    expect(lines).toEqual([
      'inventory: sent 1 repos (1 routable: github.com/org/app) and 1 capabilities',
    ]);
    scan = { repos: [REPO], capabilities: [GH, SLACK] };
    await r.rescan();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('and 2 capabilities');
    r.stop();
  });
});

describe('InventoryReporter', () => {
  afterEach(() => vi.useRealTimers());

  it('sends on registered; the 10-minute rescan sends only when the hash changed', async () => {
    vi.useFakeTimers();
    let scan: InventoryScan = { repos: [REPO], capabilities: [GH] };
    const sent: string[] = [];
    const r = new InventoryReporter({
      scan: () => Promise.resolve(scan),
      send: (p) => sent.push(p.hash),
      intervalMs: 600_000,
    });
    r.start();
    await r.onRegistered();
    expect(sent).toHaveLength(1);
    expect(r.hash).toBe(sent[0]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toHaveLength(1); // unchanged: not re-sent
    scan = { repos: [REPO], capabilities: [GH, SLACK] };
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toHaveLength(2);
    // A reconnect always re-sends, changed or not.
    r.onDisconnected();
    await r.rescan();
    expect(sent).toHaveLength(2); // not connected: nothing sent
    await r.onRegistered();
    expect(sent).toHaveLength(3);
    r.stop();
  });

  it('a failed scan keeps the previous inventory', async () => {
    let fail = false;
    const sent: string[] = [];
    const r = new InventoryReporter({
      scan: () =>
        fail
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({ repos: [], capabilities: [GH] }),
      send: (p) => sent.push(p.hash),
      intervalMs: 600_000,
    });
    await r.onRegistered();
    fail = true;
    await r.rescan();
    expect(sent).toHaveLength(1);
    expect(r.hash).toBe(sent[0]);
    r.stop();
  });
});

describe('daemon inventory over the link (M2-T10)', () => {
  let tmp: string;
  let orch: FakeOrchestrator;
  let daemon: Daemon | null = null;
  let scan: InventoryScan;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'conductor-report-'));
    mkdirPrivate(tmp); // win32: the daemon makes its root private, which needs a private parent
    orch = await FakeOrchestrator.start();
    scan = { repos: [REPO], capabilities: [GH] };
  });

  afterEach(async () => {
    daemon?.stop();
    daemon = null;
    await orch.close();
    expect(orch.invalid).toEqual([]);
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function start(): Daemon {
    const config = loadConfig({
      CONDUCTOR_ORCHESTRATOR_URL: orch.url,
      CONDUCTOR_ROOT: join(tmp, 'root'),
      CONDUCTOR_MACHINE_ID: 'test-machine',
      CONDUCTOR_MAX_SESSIONS: '1',
      CONDUCTOR_PORT_POOL: '43000-43009',
      CONDUCTOR_MIN_FREE_MEM_MB: '0',
      CONDUCTOR_WORK_POLL_MS: '60000',
    });
    config.reconnect = { initialMs: 20, maxMs: 100, factor: 2 };
    daemon = new Daemon({
      config,
      driver: new FakeClaudeDriver({ turns: [] }),
      createCommandRunner: () => new FakeCommandRunner(1, true),
      sysinfo: () => ({ cpuFree: 4, memFreeMb: 8000, diskFreeMb: 50_000 }),
      claudeCodeVersion: '2.1.308',
      log: () => {},
      scanInventory: () => Promise.resolve(scan),
    });
    daemon.start();
    return daemon;
  }

  const inventories = () => orch.ofType('inventory');

  it('sent after registered (before request_work), with the legacy repo_inventory too', async () => {
    start();
    await orch.until(() => orch.ofType('request_work')[0]);
    const types = orch.received.map((m) => m.type);
    expect(types.indexOf('inventory')).toBeGreaterThan(types.indexOf('register'));
    expect(types.indexOf('inventory')).toBeLessThan(types.indexOf('request_work'));
    expect(types).toContain('repo_inventory'); // TD-110 until M2-T21
    const inv = inventories()[0]!;
    expect(InventoryPayloadSchema.parse(inv.payload)).toEqual({
      repos: [REPO],
      capabilities: [GH],
      hash: inventoryHash(scan),
      git_identity_missing: false,
    });
    expect(orch.ofType('request_work')[0]!.payload.repos_digest).toBe(inv.payload.hash);
  });

  it('not re-sent when unchanged; re-sent on SIGHUP after a change', async () => {
    const d = start();
    await orch.until(() => inventories()[0]);
    const unwatch = watchSighup(d.inventory);
    try {
      await d.rescanInventory();
      expect(inventories()).toHaveLength(1);

      process.emit('SIGHUP', 'SIGHUP');
      // Let the SIGHUP-triggered rescan finish: still one inventory (nothing changed).
      await d.rescanInventory();
      expect(inventories()).toHaveLength(1);

      scan = { repos: [REPO], capabilities: [GH, SLACK] };
      process.emit('SIGHUP', 'SIGHUP');
      const second = await orch.until(() => inventories()[1]);
      expect(second.payload.capabilities).toEqual([GH, SLACK]);
      expect(second.payload.hash).not.toBe(inventories()[0]!.payload.hash);
    } finally {
      unwatch();
    }
  });
});
