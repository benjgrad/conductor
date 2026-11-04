// @ts-check
import { describe, expect, it } from 'vitest';
import { e2eSteps } from './e2e.js';

/** @param {Parameters<typeof e2eSteps>[0]} o */
const plan = (o) => e2eSteps(o).map((s) => [s.cmd, ...s.args].join(' '));

describe('e2eSteps (MR-T16b)', () => {
  it('linux: db up, tsc, the Rust daemon, vitest', () => {
    expect(plan({ platform: 'linux', env: {} })).toEqual([
      'bash scripts/db.sh up',
      'pnpm exec tsc -b',
      'cargo build --release --locked -p conductor-daemon',
      'pnpm exec vitest run --config e2e/vitest.config.ts',
    ]);
    expect(e2eSteps({ platform: 'linux', env: {} }).some((s) => s.shell)).toBe(false);
  });

  it('another daemon (CONDUCTOR_E2E_DAEMON_BIN) skips cargo on POSIX', () => {
    const steps = plan({
      platform: 'darwin',
      env: { CONDUCTOR_E2E_DAEMON_BIN: 'packages/daemon/dist/main.js' },
    });
    expect(steps.some((s) => s.startsWith('cargo'))).toBe(false);
  });

  it('win32: no db.sh, the launcher is built too, pnpm through the shell', () => {
    const steps = e2eSteps({ platform: 'win32', env: { DATABASE_URL: 'postgres://x' } });
    expect(steps.map((s) => [s.cmd, ...s.args].join(' '))).toEqual([
      'pnpm exec tsc -b',
      'cargo build --release --locked -p conductor-daemon -p conductor-e2e-launcher',
      'pnpm exec vitest run --config e2e/vitest.config.ts',
    ]);
    expect(steps.filter((s) => s.shell).map((s) => s.name)).toEqual(['tsc -b', 'vitest']);
  });

  it('win32 with another daemon still builds the launcher', () => {
    expect(
      plan({ platform: 'win32', env: { CONDUCTOR_E2E_DAEMON_BIN: 'x.exe' } }).find((s) =>
        s.startsWith('cargo'),
      ),
    ).toBe('cargo build --release --locked -p conductor-e2e-launcher');
  });

  it('forwards extra args to vitest', () => {
    expect(plan({ platform: 'linux', env: {}, args: ['m1', '-t', 'happy path'] }).at(-1)).toBe(
      'pnpm exec vitest run --config e2e/vitest.config.ts m1 -t happy path',
    );
  });

  it('win32 refuses a forwarded arg cmd.exe would reinterpret', () => {
    expect(() => e2eSteps({ platform: 'win32', env: {}, args: ['a&calc'] })).toThrow(/shell/);
    expect(() => e2eSteps({ platform: 'win32', env: {}, args: ['happy path'] })).toThrow(/spaces/);
    expect(plan({ platform: 'win32', env: {}, args: ['m1.e2e'] }).at(-1)).toMatch(/ m1\.e2e$/);
  });
});
