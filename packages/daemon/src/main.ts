#!/usr/bin/env node
import { createCliDriver, probePermissionPrompts } from './claude/cli-driver.js';
import { startOutcomeServer } from './claude/outcome-server.js';
import { configCommand, CONFIG_USAGE } from './commands/config.js';
import { enroll, ENROLL_USAGE } from './commands/enroll.js';
import {
  MIN_NODE_MAJOR,
  SERVICE_USAGE,
  serviceCommand,
  stopSupervisedJob,
} from './commands/service.js';
import { loadConfig } from './config.js';
import { Daemon } from './daemon.js';
import { watchSighup } from './inventory/report.js';
import { execFileCli, nativeExeProblem } from './platform/index.js';
import { fatalExitCode } from './ws-client.js';

// `conductor-daemon` entry: env → config, the real ADR-0005 CLI driver (its MCP outcome server on
// 127.0.0.1), signals. TD-021 resolved: a static import of the T05b driver, so tsc checks the
// `createCliDriver` signature (claudeBin ← CONDUCTOR_CLAUDE_BIN ← 'claude' inside the driver).
// M2-T04: subcommands `run` (default) and `enroll`. M2-T10: `config`; SIGHUP rescans the inventory.
// M2-T18: `service`; a fatal close exits 78 (EXIT_FATAL_AUTH), which the service units don't restart.

const USAGE = [
  'usage: conductor-daemon [run]',
  `       ${ENROLL_USAGE.replace(/^usage: /, '')}`,
  ...CONFIG_USAGE.split('\n').map((l) => `       ${l.replace(/^usage: |^ +/, '')}`),
  `       ${SERVICE_USAGE.replace(/^usage: /, '')}`,
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
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < MIN_NODE_MAJOR) {
    process.stderr.write(
      `[conductor-daemon] WARNING: ${process.execPath} is Node.js ${process.versions.node}; ` +
        `conductor needs ${MIN_NODE_MAJOR}+. Put Node ${MIN_NODE_MAJOR} first on PATH, or set ` +
        `CONDUCTOR_NODE to it (the service pins it: re-run conductor-daemon service install).\n`,
    );
  }
  const config = loadConfig(process.env);
  const outcomeServer = await startOutcomeServer();
  // ADR-0023: auto mode + prompts to the board need a CLI that has them; probed once per start.
  const prompts = await probePermissionPrompts();
  if (!prompts.supported) {
    // TD-187: ADR-0023 asks for a machine alert; the alert frame has no kind for this yet.
    process.stderr.write(
      `[conductor-daemon] WARNING: this Claude Code can't send permission prompts to conductor (${prompts.reason ?? 'unknown'}); ` +
        'agents run with the old flags and anything that would prompt is denied. Update Claude Code.\n',
    );
  }
  const driver = createCliDriver({
    outcomeServer,
    killGraceMs: config.killGraceMs,
    endGraceMs: config.endGraceMs,
    permissionPrompts: prompts.supported,
  });
  const daemon = new Daemon({
    config,
    driver,
    claudeCodeVersion: await claudeCodeVersion(),
    // Revoked, unauthorized or protocol too old: the daemon already logged why. Exit 78 so the
    // service doesn't restart-loop (TD-119); under launchd also boot the job out.
    onFatal: (code) => {
      stopSupervisedJob();
      shutdown(fatalExitCode(code));
    },
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
  let exiting = false;
  function shutdown(code = 0): void {
    // Once: the launchd bootout after a fatal close sends SIGTERM, which must not turn 78 into 0.
    if (exiting) return;
    exiting = true;
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
    case 'service':
      process.exitCode = serviceCommand(rest);
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
