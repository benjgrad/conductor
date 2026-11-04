// @ts-check
// `pnpm test:e2e` (M1-T10; a node entry since MR-T16b so Windows needs no bash): Postgres up,
// build the orchestrator bin (tsc -b, incremental), build the Rust daemon (`cargo build --release`,
// incremental), then the E2E suite. Extra args go to vitest.
//   CONDUCTOR_E2E_DAEMON_BIN=<path>    run another daemon instead of target/release/conductor-daemon
//                                     (no daemon cargo build), e.g. the TS one,
//                                     packages/daemon/dist/main.js (built by tsc -b), until MR-T18b
//   E2E_REAL_CLAUDE=1 pnpm test:e2e   the ask/answer scenario against the installed `claude` on
//                                     haiku (spends money; never in CI)
// On Windows, `scripts/db.sh` (Homebrew / docker) doesn't apply: Postgres must already run, at
// DATABASE_URL (the daemon-rust `e2e-windows` job starts the runner's service). The fakes there
// go through the native launcher (crates/conductor-e2e-launcher), so it is always built.
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {{ name: string, cmd: string, args: string[], shell?: boolean }} Step
 */

/** What cmd.exe would treat specially in a forwarded argument (the pnpm step runs through it). */
const CMD_META = /[\s"&|<>^%!()]/;

/**
 * The steps of an e2e run. Pure.
 * @param {{ platform: NodeJS.Platform, env: Record<string, string | undefined>, args?: string[] }} o
 * @returns {Step[]}
 */
export function e2eSteps({ platform, env, args = [] }) {
  const win = platform === 'win32';
  /** @type {Step[]} */
  const steps = [];
  if (!win) steps.push({ name: 'db up', cmd: 'bash', args: ['scripts/db.sh', 'up'] });
  // pnpm is pnpm.cmd on Windows: it only starts through the shell there.
  steps.push({ name: 'tsc -b', cmd: 'pnpm', args: ['exec', 'tsc', '-b'], shell: win });
  const packages = [];
  if (!env.CONDUCTOR_E2E_DAEMON_BIN) packages.push('-p', 'conductor-daemon');
  if (win) packages.push('-p', 'conductor-e2e-launcher');
  if (packages.length > 0) {
    steps.push({
      name: 'cargo build',
      cmd: 'cargo',
      args: ['build', '--release', '--locked', ...packages],
    });
  }
  if (win) {
    const bad = args.find((a) => CMD_META.test(a));
    if (bad !== undefined) {
      throw new Error(
        `e2e: on Windows a vitest argument can't hold spaces or shell characters: ${bad}`,
      );
    }
  }
  steps.push({
    name: 'vitest',
    cmd: 'pnpm',
    args: ['exec', 'vitest', 'run', '--config', 'e2e/vitest.config.ts', ...args],
    shell: win,
  });
  return steps;
}

/** The PATH to run the steps with: rustup's ~/.cargo/bin appended (a non-login shell may lack it). */
function pathWithCargo() {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { key, value: [process.env[key] ?? '', join(homedir(), '.cargo', 'bin')].join(delimiter) };
}

function isMain() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const arg = resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
}

if (isMain()) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const { key, value } = pathWithCargo();
  const env = { ...process.env, [key]: value };
  for (const step of e2eSteps({
    platform: process.platform,
    env: process.env,
    args: process.argv.slice(2),
  })) {
    const r = spawnSync(step.cmd, step.args, {
      cwd: root,
      env,
      stdio: 'inherit',
      shell: step.shell ?? false,
    });
    if (r.error) {
      console.error(`e2e: ${step.name}: ${r.error.message}`);
      process.exit(1);
    }
    if (r.status !== 0) {
      if (r.status === null) console.error(`e2e: ${step.name} was killed (${r.signal})`);
      process.exit(r.status ?? 1);
    }
  }
}
