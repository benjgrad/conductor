#!/usr/bin/env node
import { createCliDriver } from './claude/cli-driver.js';
import { startOutcomeServer } from './claude/outcome-server.js';
import { configCommand, CONFIG_USAGE } from './commands/config.js';
import { enroll, ENROLL_USAGE } from './commands/enroll.js';
import { loadConfig } from './config.js';
import { Daemon } from './daemon.js';
import { watchSighup } from './inventory/report.js';
import { execFileCli, nativeExeProblem } from './platform/index.js';

// `conductor-daemon` entry: env → config, the real ADR-0005 CLI driver (its MCP outcome server on
// 127.0.0.1), signals. TD-021 resolved: a static import of the T05b driver, so tsc checks the
// `createCliDriver` signature (claudeBin ← CONDUCTOR_CLAUDE_BIN ← 'claude' inside the driver).
// M2-T04: subcommands `run` (default) and `enroll`. M2-T10: `config`; SIGHUP rescans the inventory.

const USAGE = [
  'usage: conductor-daemon [run]',
  `       ${ENROLL_USAGE.replace(/^usage: /, '')}`,
  ...CONFIG_USAGE.split('\n').map((l) => `       ${l.replace(/^usage: |^ +/, '')}`),
].join('\n');

/** `claude --version` → "2.1.308", or null when the CLI is missing (U-015). */
async function claudeCodeVersion(
  bin = process.env.CONDUCTOR_CLAUDE_BIN ?? 'claude',
): Promise<string | null> {
  const notNative = nativeExeProblem(bin);
  if (notNative !== null) {
    process.stderr.write(`[conductor-daemon] ${notNative}\n`);
    return null;
  }
  const stdout = await new Promise<string | null>((done) => {
    execFileCli(bin, ['--version'], { timeout: 10_000 }, (err, out) => done(err ? null : out));
  });
  if (stdout === null) return null;
  return /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? (stdout.trim() || null);
}

async function run(): Promise<void> {
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
    // Revoked, unauthorized or protocol too old: the daemon already logged why; exit non-zero.
    onFatal: () => shutdown(1),
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
  const unwatchSighup = watchSighup(daemon.inventory);
  process.stderr.write(
    `[conductor-daemon] ${config.machineId} → ${config.orchestratorUrl} (root ${config.rootDir}, ` +
      `${config.credential !== null ? 'enrolled' : 'local mode'})\n`,
  );
  function shutdown(code = 0): void {
    unwatchSighup();
    daemon.stop();
    void outcomeServer.close().catch(() => {});
    // Give killed children a moment to exit before the event loop ends.
    setTimeout(() => process.exit(code), config.killGraceMs).unref();
  }
  process.once('SIGINT', () => shutdown());
  process.once('SIGTERM', () => shutdown());
}

async function main(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case 'run':
      return run();
    case 'enroll':
      process.exitCode = await enroll(rest);
      return;
    case 'config':
      process.exitCode = configCommand(rest);
      return;
    case 'help':
    case '-h':
    case '--help':
      process.stdout.write(`${USAGE}\n`);
      return;
    default:
      process.stderr.write(`[conductor-daemon] unknown command: ${sub}\n${USAGE}\n`);
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  process.stderr.write(
    `[conductor-daemon] fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
  process.exit(1);
});
