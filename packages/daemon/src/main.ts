#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ClaudeDriver } from './claude/driver.js';
import { loadConfig } from './config.js';
import { Daemon } from './daemon.js';

// `conductor-daemon` entry: env → config, the real ADR-0005 CLI driver, signals.

/**
 * The real driver's module (M1-T05b creates `src/claude/cli-driver.ts` in parallel). Loaded by a
 * computed specifier so this package typechecks before T05b merges.
 * TD: the integrator replaces this with a static `import { createCliDriver } from
 * './claude/cli-driver.js'` once both branches are on main, and settles its options type.
 */
const CLI_DRIVER_MODULE = './claude/cli-driver.js';

interface CliDriverModule {
  createCliDriver(opts?: { claudeBin?: string }): ClaudeDriver;
}

async function loadCliDriver(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeDriver> {
  const mod = (await import(CLI_DRIVER_MODULE)) as CliDriverModule;
  const claudeBin = env.CONDUCTOR_CLAUDE_BIN;
  return mod.createCliDriver(claudeBin ? { claudeBin } : {});
}

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
  const daemon = new Daemon({
    config,
    driver: await loadCliDriver(),
    claudeCodeVersion: await claudeCodeVersion(),
  });
  daemon.start();
  process.stderr.write(
    `[conductor-daemon] ${config.machineId} → ${config.orchestratorUrl} (root ${config.rootDir})\n`,
  );
  const shutdown = () => {
    daemon.stop();
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
