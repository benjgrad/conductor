// @ts-check
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LEDGER,
  checkParity,
  extractCases,
  parseLedger,
  renderLedger,
  repoCases,
} from './test-parity.js';

const keys = (/** @type {string} */ src, file = 'a.test.ts') =>
  extractCases(src, file).map((c) => c.key);

describe('extractCases (MR-T02)', () => {
  it('keys every it/test with its describe chain', () => {
    const src = `
      describe('outer', () => {
        it('one', () => {});
        describe("inner", () => { test(\`two\`, async () => {}); });
      });
      it('top', () => {});`;
    expect(keys(src)).toEqual([
      'a.test.ts › outer › one',
      'a.test.ts › outer › inner › two',
      'a.test.ts › top',
    ]);
  });

  it('reads the modifier forms: .each, .skipIf, .runIf, .skip, .todo, describe.skipIf', () => {
    const src = `
      describe.skipIf(WIN)('POSIX', () => {
        it.each([1, 2])('case %s', (n) => {});
        it.skipIf(onWin32)('skipped on win32', () => {});
        it.runIf(isWin)(
          'a title on its own line',
          () => {},
        );
        it.skip('skip', () => {});
        it.todo('later');
        it.concurrent.each([[1]])('nested %j', () => {});
      });`;
    expect(keys(src)).toEqual([
      'a.test.ts › POSIX › case %s',
      'a.test.ts › POSIX › skipped on win32',
      'a.test.ts › POSIX › a title on its own line',
      'a.test.ts › POSIX › skip',
      'a.test.ts › POSIX › later',
      'a.test.ts › POSIX › nested %j',
    ]);
  });

  it('ignores calls that only look alike, and keeps a non-literal title as source text', () => {
    const src = `
      const t = it;
      foo.it('no', () => {});
      expect(x).toEqual(1);
      it(\`id \${n}\`, () => {});
      it(NAME + '!', () => {});`;
    expect(keys(src)).toEqual(['a.test.ts › `id ${n}`', "a.test.ts › NAME + '!'"]);
  });

  it('numbers repeated keys', () => {
    expect(keys(`it('x', f); it('x', f); it('x', f);`)).toEqual([
      'a.test.ts › x',
      'a.test.ts › x [2]',
      'a.test.ts › x [3]',
    ]);
  });
});

const cases = [
  ...extractCases(`describe('d', () => { it('one', f); it('a | b', f); });`, 'p/a.test.ts'),
  ...extractCases(`it('two', f);`, 'q/b.test.ts'),
];
const RUST = 'crates/x/tests/t.rs';
/** @param {string} p */
const readFile = (p) => (p === RUST ? 'fn alpha() {}\n#[test]\nfn beta() {}\n' : null);
/** @param {Record<string, string>} [cells] @param {string[]} [ported] */
const check = (cells = {}, ported = []) => {
  /** @type {import('./test-parity.js').Ledger} */
  const base = parseLedger(renderLedger(cases));
  const ledger = {
    ported: base.ported,
    rows: base.rows.map((r) => ({ ...r, rust: cells[r.key] ?? r.rust })),
  };
  return checkParity({ cases, ledger, ported, readFile });
};

describe('checkParity (MR-T02)', () => {
  it('a freshly rendered ledger passes, all todo, with no ported globs', () => {
    expect(check()).toEqual([]);
  });

  it('a case without a row fails', () => {
    const ledger = parseLedger(renderLedger(cases));
    ledger.rows = ledger.rows.filter((r) => r.key !== 'q/b.test.ts › two');
    expect(checkParity({ cases, ledger, ported: [], readFile })).toEqual([
      'missing row: q/b.test.ts › two',
    ]);
  });

  it('a row without a case fails, and so does a duplicate row', () => {
    const md =
      renderLedger(cases) + '| q/b.test.ts › gone | todo |\n| q/b.test.ts › two | todo |\n';
    const errors = checkParity({ cases, ledger: parseLedger(md), ported: [], readFile });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/extra row \(no such TS case\): q\/b\.test\.ts › gone$/);
    expect(errors[1]).toMatch(/duplicate row: q\/b\.test\.ts › two$/);
  });

  it('dropped rows need a reason, and count as done in a ported file', () => {
    expect(check({ 'q/b.test.ts › two': 'dropped: Node-only API' }, ['q/**'])).toEqual([]);
    expect(check({ 'q/b.test.ts › two': 'dropped:  ' })).toEqual([
      'dropped without a reason: q/b.test.ts › two',
    ]);
  });

  it('todo passes outside the ported files and fails inside them', () => {
    expect(check({}, ['p/*.test.ts'])).toEqual([
      'todo in a ported file: p/a.test.ts › d › one',
      'todo in a ported file: p/a.test.ts › d › a | b',
    ]);
    expect(check({ 'q/b.test.ts › two': `${RUST}::beta` }, ['q/b.test.ts'])).toEqual([]);
  });

  it('a Rust cell must name an existing file and fn', () => {
    const key = 'q/b.test.ts › two';
    expect(check({ [key]: `${RUST}::tests::alpha, \`${RUST}::beta\`` })).toEqual([]);
    expect(check({ [key]: `${RUST}::gamma` })).toEqual([`no fn gamma in ${RUST} (${key})`]);
    expect(check({ [key]: 'crates/x/src/nope.rs::alpha' })).toEqual([
      `no such Rust file crates/x/src/nope.rs (${key})`,
    ]);
    expect(check({ [key]: 'done' })[0]).toMatch(/^not todo, dropped: <reason> or <path>\.rs::<fn>/);
  });

  it('a ported glob that matches no TS test file fails (a typo would port nothing)', () => {
    expect(check({}, ['nope/*.test.ts'])).toEqual([
      'ported glob matches no TS test file: nope/*.test.ts',
    ]);
  });
});

describe('renderLedger / parseLedger (MR-T02)', () => {
  it('round-trips, escaping | in titles, and keeps Rust cells and ticks', () => {
    const first = parseLedger(renderLedger(cases));
    expect(first.rows.map((r) => [r.key, r.rust])).toEqual(cases.map((c) => [c.key, 'todo']));
    expect(first.ported).toEqual([
      { glob: 'p/a.test.ts', ticked: false },
      { glob: 'q/b.test.ts', ticked: false },
    ]);
    const edited = renderLedger(cases)
      .replace(
        '| p/a.test.ts › d › a \\| b | todo |',
        `| p/a.test.ts › d › a \\| b | ${RUST}::beta |`,
      )
      .replace('- [ ] `q/b.test.ts`', '- [x] `q/b.test.ts`\n\n- [x] `r/**`');
    const again = parseLedger(renderLedger(cases, parseLedger(edited)));
    expect(again.rows.find((r) => r.key === 'p/a.test.ts › d › a | b')?.rust).toBe(`${RUST}::beta`);
    expect(again.ported.filter((p) => p.ticked).map((p) => p.glob)).toEqual([
      'q/b.test.ts',
      'r/**',
    ]);
  });

  it('puts each TS file in its own section, so tickets edit disjoint hunks', () => {
    const md = renderLedger(cases);
    expect(md).toMatch(/### p\/a\.test\.ts\n\n\| TS case \| Rust \|/);
    expect(md).toMatch(/- \[ \] `p\/a\.test\.ts`\n\n- \[ \] `q\/b\.test\.ts`/);
  });
});

describe('the repo ledger (MR-T02)', () => {
  it('crates/conductor-daemon/PARITY.md passes against packages/daemon/src', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const all = repoCases(root);
    expect(all.length).toBeGreaterThan(400);
    const ledger = parseLedger(readFileSync(join(root, LEDGER), 'utf8'));
    const ported = ledger.ported.filter((p) => p.ticked).map((p) => p.glob);
    const read = (/** @type {string} */ p) => {
      try {
        return readFileSync(join(root, p), 'utf8');
      } catch {
        return null;
      }
    };
    expect(checkParity({ cases: all, ledger, ported, readFile: read })).toEqual([]);
  });
});
