import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Capability, InventoryPayload, InventoryRepo } from '@conductor/shared';
import { readFileConfig, type DaemonConfig } from '../config.js';
import { scanCapabilities } from './capabilities.js';
import { scanRepos } from './repos.js';

// The `inventory` message (M2-T10; ADR-0013 §Inventory, 10-contracts §Machines protocol v2): sent
// after every `registered`, and after a rescan (every 10 minutes, and on SIGHUP) when its hash
// changed. Each one replaces the machine's previous inventory wholesale; `hash` is also
// `request_work.repos_digest`.

export interface InventoryScan {
  repos: InventoryRepo[];
  capabilities: Capability[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A capability as a string with a fixed key order (sorting and hashing). */
function capString(c: Capability): string {
  switch (c.kind) {
    case 'cli':
      return JSON.stringify(['cli', c.name, c.version, c.authed]);
    case 'mcp':
      return JSON.stringify(['mcp', c.name]);
    case 'skill':
    case 'agent':
      return JSON.stringify([c.kind, c.name, c.repo ?? null]);
    case 'claude':
      return JSON.stringify(['claude', c.version]);
  }
}

/** The payload with repos sorted by path and capabilities in a stable order. */
export function normalizeScan(scan: InventoryScan): InventoryScan {
  return {
    repos: [...scan.repos].sort((a, b) => cmp(a.path, b.path)),
    capabilities: [...scan.capabilities].sort((a, b) => cmp(capString(a), capString(b))),
  };
}

/** sha256 of the normalised inventory. Order-independent; versions count (an upgrade is re-sent). */
export function inventoryHash(scan: InventoryScan): string {
  const n = normalizeScan(scan);
  const repos = n.repos.map((r) => [r.path, r.remote, r.default_branch, r.head_commit, r.mode]);
  return createHash('sha256')
    .update(JSON.stringify({ repos, capabilities: n.capabilities.map(capString) }))
    .digest('hex');
}

export function inventoryPayload(scan: InventoryScan): InventoryPayload {
  const n = normalizeScan(scan);
  return { ...n, hash: inventoryHash(n) };
}

/** The real scan: roots from CONDUCTOR_ROOTS, else `<root>/config.json` (re-read every scan). */
export async function scanInventory(
  config: DaemonConfig,
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = () => {},
): Promise<InventoryScan> {
  let file;
  try {
    file = readFileConfig(config.rootDir);
  } catch (e) {
    log(`inventory: ${e instanceof Error ? e.message : String(e)}; using no roots`);
    file = { roots: [], repos: {} };
  }
  const modes = Object.fromEntries(Object.entries(file.repos).map(([p, r]) => [p, r.mode]));
  const repos = await scanRepos({
    roots: config.rootsOverride ?? file.roots,
    modes,
    allowedRepoHosts: config.allowedRepoHosts,
    testRemoteAliases: config.testRemoteAliases ?? {},
    env,
    log,
  });
  const claudeConfigDir = config.claudeConfigDir ?? join(homedir(), '.claude');
  const capabilities = await scanCapabilities({
    claudeConfigDir,
    // Claude Code keeps its user config (with user-scope MCP servers) next to the config dir when
    // CLAUDE_CONFIG_DIR is set, else in ~/.claude.json.
    claudeUserConfig:
      env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== ''
        ? join(claudeConfigDir, '.claude.json')
        : join(homedir(), '.claude.json'),
    claudeBin: env.CONDUCTOR_CLAUDE_BIN ?? 'claude',
    repos,
    env,
    log,
  });
  return { repos, capabilities };
}

export interface InventoryReporterOptions {
  scan: () => Promise<InventoryScan>;
  send: (payload: InventoryPayload) => void;
  /** Rescan period (ADR-0013: 10 minutes). */
  intervalMs: number;
  log?: (msg: string) => void;
}

/**
 * Scans, keeps the latest inventory and sends it: always after `registered`, otherwise only when
 * its hash changed since the last send. One scan at a time (a rescan asked for during a scan runs
 * once after it). A failed scan keeps the previous inventory.
 */
export class InventoryReporter {
  private latest: InventoryPayload | null = null;
  private lastSentHash = '';
  private connected = false;
  private scanning: Promise<void> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: InventoryReporterOptions) {
    this.log = opts.log ?? (() => {});
  }

  /** First scan now (usually done before `registered` arrives), then every intervalMs. */
  start(): void {
    void this.scanOnce();
    if (this.timer === null) {
      this.timer = setInterval(() => void this.rescan(), this.opts.intervalMs);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.connected = false;
  }

  /** The hash of the last inventory sent ('' before the first): `request_work.repos_digest`. */
  get hash(): string {
    return this.lastSentHash;
  }

  /** After `registered`: wait for a scan (the running one, or a first one), then always send. */
  async onRegistered(): Promise<void> {
    this.connected = true;
    if (this.scanning) await this.scanning;
    if (this.latest === null) await this.scanOnce();
    if (this.latest !== null && this.connected) this.sendLatest();
  }

  onDisconnected(): void {
    this.connected = false;
  }

  /** Rescan (timer, SIGHUP); send when connected and the hash changed. */
  async rescan(): Promise<void> {
    await this.scanOnce();
    if (this.connected && this.latest !== null && this.latest.hash !== this.lastSentHash) {
      this.sendLatest();
    }
  }

  private sendLatest(): void {
    const p = this.latest!;
    this.lastSentHash = p.hash;
    this.opts.send(p);
  }

  private scanOnce(): Promise<void> {
    if (this.scanning) {
      this.again = true;
      return this.scanning;
    }
    const run = async (): Promise<void> => {
      do {
        this.again = false;
        try {
          this.latest = inventoryPayload(await this.opts.scan());
        } catch (e) {
          this.log(`inventory scan failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } while (this.again);
    };
    this.scanning = run().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }
}

/** SIGHUP → rescan (ADR-0013). Returns the remover. */
export function watchSighup(reporter: Pick<InventoryReporter, 'rescan'>): () => void {
  const onHup = () => void reporter.rescan();
  process.on('SIGHUP', onHup);
  return () => process.off('SIGHUP', onHup);
}
