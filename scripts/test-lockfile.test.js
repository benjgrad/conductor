// @ts-check
import { describe, expect, it } from 'vitest';
import { daemonAffected } from './test-affected.js';
import { lockfileImporters, translateLockfile } from './test-lockfile.js';

/** A pnpm v9 lockfile shaped like ours: root toolchain, shared linked into daemon and web. */
const lock = ({
  zod = '4.6.7',
  ws = '8.22.0',
  vitest = '5.0.5',
  webDeps = '',
  settings = '',
} = {}) =>
  `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true${settings}

importers:

  .:
    devDependencies:
      vitest:
        specifier: ^${vitest}
        version: ${vitest}

  packages/daemon:
    dependencies:
      '@conductor/shared':
        specifier: workspace:*
        version: link:../shared
      ws:
        specifier: ^8.22.0
        version: ${ws}

  packages/shared:
    dependencies:
      zod:
        specifier: ^4.6.7
        version: ${zod}

  packages/web:
    dependencies:
      '@conductor/shared':
        specifier: workspace:*
        version: link:../shared${webDeps}

packages:

  vitest@${vitest}:
    resolution: {integrity: sha512-v${vitest}}

  ws@${ws}:
    resolution: {integrity: sha512-w${ws}}

  zod@${zod}:
    resolution: {integrity: sha512-z${zod}}

snapshots:

  vitest@${vitest}: {}

  ws@${ws}: {}

  zod@${zod}: {}
`;

const reactDep = `
      react:
        specifier: ^19.0.0
        version: 19.0.0`;

describe('lockfileImporters', () => {
  it('a web-only dependency reaches only web', () => {
    // react isn't in packages/snapshots here: a dangling key still counts as a change
    expect(lockfileImporters(lock(), lock({ webDeps: reactDep }))).toEqual(['packages/web']);
  });

  it('a shared dependency reaches every package that links shared', () => {
    expect(lockfileImporters(lock(), lock({ zod: '4.7.0' }))).toEqual([
      'packages/daemon',
      'packages/shared',
      'packages/web',
    ]);
  });

  it('a daemon dependency reaches only the daemon', () => {
    expect(lockfileImporters(lock(), lock({ ws: '8.23.0' }))).toEqual(['packages/daemon']);
  });

  it('the root toolchain reaches everything, the root included', () => {
    expect(lockfileImporters(lock(), lock({ vitest: '5.1.0' }))).toEqual([
      '.',
      'packages/daemon',
      'packages/shared',
      'packages/web',
    ]);
  });

  it('an unchanged closure is no change, whatever the key order', () => {
    expect(lockfileImporters(lock(), lock())).toEqual([]);
  });

  it("can't tell (null) when a global setting changed or the text doesn't parse", () => {
    expect(
      lockfileImporters(lock(), lock({ settings: '\n  excludeLinksFromLockfile: true' })),
    ).toBe(null);
    expect(lockfileImporters(lock(), 'importers: [unclosed')).toBe(null);
    expect(lockfileImporters(lock(), '')).toBe(null);
  });
});

describe('translateLockfile', () => {
  const read = (/** @type {string} */ head) => () =>
    /** @type {[string, string]} */ ([lock(), head]);

  it('replaces the lockfile with the package.json of each package it reaches', () => {
    expect(
      translateLockfile(['docs/x.md', 'pnpm-lock.yaml'], read(lock({ ws: '8.23.0' }))),
    ).toEqual(['docs/x.md', 'packages/daemon/package.json']);
  });

  it('keeps it (a global change) when it reaches the root or can not be read', () => {
    const changed = ['pnpm-lock.yaml'];
    expect(translateLockfile(changed, read(lock({ vitest: '5.1.0' })))).toEqual(changed);
    expect(translateLockfile(changed, () => null)).toEqual(changed);
  });

  it('leaves a list without the lockfile alone', () => {
    expect(translateLockfile(['a.ts'], () => null)).toEqual(['a.ts']);
  });
});

describe('daemonAffected (the daemon-windows job)', () => {
  it.each([
    [['packages/daemon/src/daemon.ts'], true],
    [['packages/shared/src/api/rest.ts'], true],
    [['packages/daemon/package.json'], true],
    [['pnpm-lock.yaml'], true],
    [['.github/workflows/daemon-windows.yml'], true],
    [['tsconfig.base.json'], true],
    [['docs/tracking/STATUS.md'], false],
    [['packages/web/src/App.tsx', 'packages/web/package.json'], false],
    [['packages/orchestrator/src/server.ts', 'deploy/gradyserver/compose.yml'], false],
  ])('%j → %s', (changed, want) => {
    expect(daemonAffected(changed)).toBe(want);
  });

  it('runs when the diff is unknown', () => {
    expect(daemonAffected(null)).toBe(true);
  });
});
