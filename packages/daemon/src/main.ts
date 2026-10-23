#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCliDriver } from './claude/cli-driver.js';
import { startOutcomeServer } from './claude/outcome-server.js';
import { loadConfig } from './config.js';
import { Daemon } from './daemon.js';

// `conductor-daemon` entry: env → config, the real ADR-0005 CLI driver (its MCP outcome server on
// 127.0.0.1), signals. TD-021 resolved: a static import of the T05b driver, so tsc checks the
// `createCliDriver` signature (claudeBin ← CONDUCTOR_CLAUDE_BIN ← 'claude' inside the driver).

/** `claude --version` → "2.1.308", or null when the CLI is missing (U-015). */
async function claudeCodeVersion(
  bin = process.env.CONDUCTOR_CLAUDE_BIN ?? 'claude',
): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)(bin, ['--version'], { timeout: 10_000 });
    return /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? (stdout.trim() || null);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const outcomeServer = await startOutcomeServer();
  const driver = createCliDriver({
    outcomeServer,
    killGraceMs: config.killGraceMs,
    endGraceMs: config.endGraceMs,
  });
  const daemon = new Daemon({
    config,
    driver,
    claudeCodeVersion: await claudeCodeVersion(),
  });
  // TD-077: Claude Code treats any `.claude` directory as protected config, so a Write/Edit inside a
  // worktree under such a path is denied (dontAsk/manual) or left to auto mode's classifier.
  if (/(^|\/)\.claude(\/|$)/.test(config.rootDir)) {
    process.stderr.write(
      `[conductor-daemon] WARNING: CONDUCTOR_ROOT (${config.rootDir}) is inside a .claude directory; ` +
        'Claude Code will deny agent file writes there. Use a root outside .claude (default ~/.conductor).\n',
    );
  }
  daemon.start();
  process.stderr.write(
    `[conductor-daemon] ${config.machineId} → ${config.orchestratorUrl} (root ${config.rootDir})\n`,
  );
  const shutdown = () => {
    daemon.stop();
    void outcomeServer.close().catch(() => {});
    // Give killed children a moment to exit before the event loop ends.
    setTimeout(() => process.exit(0), config.killGraceMs).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((e: unknown) => {
  process.stderr.write(
    `[conductor-daemon] fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
  process.exit(1);
});
