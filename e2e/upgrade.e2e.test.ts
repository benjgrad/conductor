// MR-T16c (MR-T16 FR-4; ADR-0026 §4, ADR-0017 §Daemon distribution): the move from the TS daemon
// to the Rust one on an enrolled machine, the way a user makes it. A TS install root enrolls and
// runs a ticket; the orchestrator's rendered /install.sh is re-run (`curl | sh`, no token) and
// installs the Rust tarball; the daemon restarts and must come back as the same machine with the
// same credential (no re-enroll), and take the next ticket.
//
// The orchestrator runs in password mode: in local mode the gateway ignores the credential, so a
// daemon that dropped it would still register. Here the WS upgrade needs the Bearer credential the
// TS daemon wrote to machine.json.
//
// The TS daemon runs from the repo build (packages/daemon/dist/main.js), through a wrapper laid
// out where the M2-T14 TS install.sh put its version dir: MR-T15 removed the TS tarball builder,
// so there is no TS tarball to install. The Rust tarball is packed (package-daemon.sh) from the
// release binary e2e/run.sh built, so the test costs no extra cargo build. Linux/macOS only
// (install.sh is POSIX; Windows is MR-T16b).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Api, BoardWatcher, signUp } from './harness/api.js';
import { createFixtureRepo } from './harness/fixture-repo.js';
import { REPO_ROOT, RUST_DAEMON_BIN, Stack, waitFor } from './harness/stack.js';

const TS_DAEMON_MAIN = join(REPO_ROOT, 'packages/daemon/dist/main.js');
const ADMIN_CLI = join(REPO_ROOT, 'packages/orchestrator/dist/admin-cli.js');
const PACKAGE_DAEMON = join(REPO_ROOT, 'packages/orchestrator/scripts/package-daemon.sh');
const LAUNCHER = join(REPO_ROOT, 'crates/conductor-daemon/assets/conductor-launch.sh');
const TS_SHA = 'ts00e2e';
const TS_VERSION = `0.0.0+${TS_SHA}`;

const M1_BASIC = JSON.parse(
  readFileSync(join(REPO_ROOT, 'docs/design/workflows/m1_basic.v1.json'), 'utf8'),
) as { id: string };
const HAPPY = {
  turns: [
    [
      { say: 'Implementing /health.' },
      { write_file: { path: 'src/health.txt', content: 'ok\n' } },
      { complete_state: { summary: 'added /health' } },
    ],
  ],
};

const skipReason =
  process.platform === 'win32'
    ? 'Windows (MR-T16b)'
    : !existsSync(RUST_DAEMON_BIN)
      ? `${RUST_DAEMON_BIN} is missing (CONDUCTOR_E2E_DAEMON_BIN skips the cargo build)`
      : !existsSync(TS_DAEMON_MAIN)
        ? `${TS_DAEMON_MAIN} is missing (run tsc -b)`
        : null;
if (skipReason !== null) console.warn(`upgrade.e2e: skipped: ${skipReason}`);

/** The process env without CONDUCTOR_* / FAKE_CLAUDE_* (the stack's own rule). */
function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('CONDUCTOR_') || k.startsWith('FAKE_CLAUDE_')) continue;
    out[k] = v;
  }
  return out;
}

let stack: Stack;
let api: Api;
let board: BoardWatcher;
let repo: string;
let workflowId: string;
let rustVersion: string;

describe.skipIf(skipReason !== null)('TS → Rust upgrade (MR-T16c)', () => {
  beforeAll(async () => {
    stack = new Stack({ auth: 'password', startDaemon: false });
    // The orchestrator reads its downloads dir at startup: pack the tarball first.
    const downloads = join(stack.tmp, 'downloads');
    stack.orchestratorEnv.CONDUCTOR_DOWNLOADS_DIR = downloads;
    // The served build is the release binary as built: its own --version (no runtime sha) is the
    // served version, so the upgraded daemon is not outdated.
    rustVersion = execFileSync(RUST_DAEMON_BIN, ['--version'], {
      cwd: stack.tmp,
      env: { PATH: '/usr/bin:/bin', HOME: stack.tmp },
      encoding: 'utf8',
    }).trim();
    const sha = rustVersion.includes('+') ? rustVersion.split('+')[1]! : 'unknown';
    const host = /^host: (\S+)$/m.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))![1]!;
    const packed = spawnSync(
      'bash',
      [PACKAGE_DAEMON, '--verify', host, RUST_DAEMON_BIN, downloads],
      {
        env: { ...cleanEnv(), CONDUCTOR_BUILD_SHA: sha },
        encoding: 'utf8',
      },
    );
    expect(packed.status, packed.stderr + packed.stdout).toBe(0);

    mkdirSync(stack.scenarioDir);
    writeFileSync(join(stack.scenarioDir, 'happy.json'), JSON.stringify(HAPPY));
    repo = createFixtureRepo(stack.fixtureRepo);
    try {
      await stack.start();
    } catch (err) {
      console.error(stack.logs());
      throw err;
    }

    // The first user (`conductor-admin bootstrap` → sign-up), who owns the `local` account.
    const boot = spawnSync(process.execPath, [ADMIN_CLI, 'bootstrap'], {
      env: { ...cleanEnv(), DATABASE_URL: stack.db.url, CONDUCTOR_PUBLIC_URL: stack.baseUrl },
      encoding: 'utf8',
    });
    expect(boot.status, boot.stderr).toBe(0);
    const invite = new URL(/https?:\/\/\S+/.exec(boot.stdout)![0]).searchParams.get('invite')!;
    const cookie = await signUp(stack.baseUrl, invite);
    api = new Api(stack.baseUrl, { cookie, origin: stack.baseUrl });
    board = new BoardWatcher(stack.baseUrl, { cookie });
    workflowId = (await api.saveWorkflow(M1_BASIC)).id;
  }, 120_000);

  afterAll(async () => {
    board?.close();
    await stack?.stop();
  }, 60_000);

  beforeEach(({ onTestFailed }) => {
    onTestFailed(() => {
      console.error(`E2E failure: process logs\n${stack.logs()}`);
    });
  });

  /**
   * A `happy` ticket on the fixture repo, run to Done. Password mode takes only a canonical
   * host/org/repo (U-048), which the claim then routes only to a machine whose repo inventory has
   * it, a real clone of a real remote. The claim still runs a non-canonical repo as local mode
   * does (gateway/claim.ts), so the ticket is created canonical, which no machine here can claim,
   * and its stored repo is then pointed at the local fixture repo.
   */
  async function runTicket(title: string): Promise<{ machine_id: string | null }> {
    const t = await api.createTicket({
      title,
      body: 'Add a /health endpoint that returns 200.\n\nfake-scenario: happy',
      repo: 'github.com/benjgrad/fixture-app',
      workflow_id: workflowId,
    });
    await stack.db.pool.query('UPDATE ticket SET repo = $1 WHERE id = $2', [repo, t.id]);
    return board.card(t.id, 'done', (c) => c.column === 'done', 60_000);
  }

  const counts = async () => {
    const q = (sql: string) => stack.db.pool.query<{ n: string }>(sql).then((r) => r.rows[0]!.n);
    return {
      machines: await q('SELECT count(*) AS n FROM machine'),
      credentials: await q('SELECT count(*) AS n FROM machine_credential'),
      tokens: await q('SELECT count(*) AS n FROM enrollment_token'),
    };
  };

  it('a TS-enrolled machine upgrades to the Rust daemon in place: same id, same credential, next ticket runs', async () => {
    // ---- 1. a TS install (the M2-T14 layout), enrolled, running a ticket ----
    const root = join(stack.tmp, 'daemon-root');
    const home = join(stack.tmp, 'home');
    mkdirSync(home);
    const tsDir = join(root, 'daemon', TS_VERSION);
    mkdirSync(join(tsDir, 'bin'), { recursive: true });
    mkdirSync(join(tsDir, 'assets'));
    chmodSync(root, 0o700);
    const tsWrapper = `#!/bin/sh\nexec '${process.execPath}' '${TS_DAEMON_MAIN}' "$@"\n`;
    writeFileSync(join(tsDir, 'bin', 'conductor-daemon'), tsWrapper, { mode: 0o755 });
    writeFileSync(join(tsDir, 'assets', 'conductor-launch.sh'), readFileSync(LAUNCHER), {
      mode: 0o755,
    });
    symlinkSync(TS_VERSION, join(root, 'daemon', 'current'));
    mkdirSync(join(root, 'bin'));
    symlinkSync('../daemon/current/bin/conductor-daemon', join(root, 'bin', 'conductor-daemon'));
    writeFileSync(join(root, 'bin', 'conductor-launch'), readFileSync(LAUNCHER), { mode: 0o755 });
    const daemon = join(root, 'bin', 'conductor-daemon');

    const { token } = await api.enrollmentToken();
    const enroll = spawnSync(daemon, ['enroll', '--url', stack.baseUrl], {
      env: { ...cleanEnv(), HOME: home, CONDUCTOR_ROOT: root, CONDUCTOR_ENROLL_TOKEN: token },
      encoding: 'utf8',
    });
    expect(enroll.status, enroll.stderr + enroll.stdout).toBe(0);
    const machineFile = join(root, 'machine.json');
    const credentialBytes = readFileSync(machineFile, 'utf8');
    const machineMode = statSync(machineFile).mode & 0o777;
    const machineId = (JSON.parse(credentialBytes) as { machine_id: string }).machine_id;

    // Both daemons find the orchestrator, their id and their credential in machine.json only.
    const env = stack.daemonEnv();
    delete env.CONDUCTOR_MACHINE_ID;
    delete env.CONDUCTOR_ORCHESTRATOR_URL;
    env.CONDUCTOR_ROOT = root;
    env.HOME = home;
    stack.startDaemon(daemon, ['run'], { ...env, CONDUCTOR_BUILD_SHA: TS_SHA }, 'daemon-ts');
    await waitFor('the TS daemon to register', async () =>
      (await api.machines()).find(
        (m) => m.id === machineId && m.status === 'online' && m.daemon_version === TS_VERSION,
      ),
    );
    expect((await runTicket('Before the upgrade')).machine_id).toBe(machineId);
    expect(await counts()).toEqual({ machines: '1', credentials: '1', tokens: '1' });
    const cred = await stack.db.pool.query<{ id: string; machine_id: string }>(
      'SELECT id, machine_id FROM machine_credential WHERE revoked_at IS NULL',
    );
    expect(cred.rows.map((r) => r.machine_id)).toEqual([machineId]);
    const credentialId = cred.rows[0]!.id;

    // ---- 2. the upgrade: the served install.sh, no token, while the TS daemon runs ----
    const upgrade = await new Promise<{ status: number | null; out: string }>((resolve) => {
      const child = spawn('sh', ['-c', 'curl -fsSL "$URL/install.sh" | sh -s -- --root "$ROOT"'], {
        // HOME is the run's: install.sh restarts a service unit it finds under $HOME.
        env: {
          ...cleanEnv(),
          HOME: home,
          URL: stack.baseUrl,
          ROOT: root,
          // install.sh needs `claude` and `git` on PATH. The system tools come first: a snap
          // curl (Ubuntu) can't write into the private temp dir install.sh downloads to.
          PATH: `${stack.claudeBinDir}:${stack.ghBinDir}:/usr/bin:/bin:${process.env.PATH ?? ''}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('close', (status) => resolve({ status, out }));
    });
    expect(upgrade.status, upgrade.out).toBe(0);
    expect(upgrade.out).toContain('upgraded in place; enrollment kept');
    expect(readlinkSync(join(root, 'daemon', 'current'))).toBe(rustVersion);
    // The TS version stays on disk, untouched (rolling back is pointing `current` at it).
    expect(readFileSync(join(tsDir, 'bin', 'conductor-daemon'), 'utf8')).toBe(tsWrapper);
    expect(readFileSync(machineFile, 'utf8')).toBe(credentialBytes);
    expect(statSync(machineFile).mode & 0o777).toBe(machineMode);
    expect(readFileSync(join(root, 'bin', 'conductor-launch'))).toEqual(readFileSync(LAUNCHER));

    // ---- 3. restart on the Rust binary: the same machine, the same credential ----
    await stack.stopProc('daemon-ts');
    const t0 = new Date();
    // No CONDUCTOR_BUILD_SHA: the Rust daemon reads it at runtime too and must report its own.
    stack.startDaemon(daemon, ['run'], env, 'daemon-rust');
    const machine = await waitFor('the Rust daemon to register', async () =>
      (await api.machines()).find(
        (m) => m.id === machineId && m.status === 'online' && m.daemon_version === rustVersion,
      ),
    );
    expect(machine).toMatchObject({ outdated: false, revoked_at: null, upgrade_command: null });
    expect(await api.machines()).toHaveLength(1);
    expect(await counts()).toEqual({ machines: '1', credentials: '1', tokens: '1' });
    const used = await stack.db.pool.query<{
      id: string;
      last_used_at: Date | null;
      revoked_at: Date | null;
    }>('SELECT id, last_used_at, revoked_at FROM machine_credential');
    expect(used.rows[0]).toMatchObject({ id: credentialId, revoked_at: null });
    // The Rust daemon's upgrade authenticated with the credential the TS daemon enrolled.
    expect(used.rows[0]!.last_used_at!.getTime()).toBeGreaterThanOrEqual(t0.getTime());

    // ---- 4. the next ticket runs on it (the TS daemon's clone under <root> is reused) ----
    expect((await runTicket('After the upgrade')).machine_id).toBe(machineId);
  }, 150_000);
});
