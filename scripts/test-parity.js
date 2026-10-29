#!/usr/bin/env node
// @ts-check
// The parity ledger (ADR-0026 §3, MR-T02): every test case of the frozen TS daemon maps to a Rust
// test, or is `dropped: <reason>` with Ben's OK. The ledger is crates/conductor-daemon/PARITY.md:
//
//   node scripts/test-parity.js                  check the ledger against packages/daemon/src
//   node scripts/test-parity.js --files <glob>…  check with these ported globs instead of the header's
//   node scripts/test-parity.js --write          regenerate PARITY.md, keeping every Rust cell and tick
//
// Every case needs a row (todo is fine) and every row a case. In a ported file (a ticked line in
// PARITY.md's `## Ported` block, or `--files`) no row may be `todo`. A Rust cell names one or more
// `<repo path>.rs::…::<fn>`, comma-separated, and each must exist. Cases are read with the
// TypeScript parser: `describe`/`it`/`test`, with `.skip`/`.only`/`.todo`/`.concurrent` and
// `.each(…)`/`.skipIf(…)`/`.runIf(…)`, keyed `<file> › <describe…> › <title>` with the file
// relative to packages/daemon/src. An `it.each` is one case (its title template).
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { matchGlob } from './test-tiers.js';

export const TS_SRC = 'packages/daemon/src';
export const LEDGER = 'crates/conductor-daemon/PARITY.md';
export const SEP = ' › ';
const PORTED_START = '<!-- parity:ported:start -->';
const PORTED_END = '<!-- parity:ported:end -->';

const BASES = new Set(['describe', 'it', 'test']);
/** `it.skip(title, fn)`: modifiers used as a property. */
const DIRECT = new Set(['skip', 'only', 'todo', 'concurrent', 'sequential', 'fails']);
/** `it.each(table)(title, fn)`: modifiers that are called first. */
const CALLED = new Set(['each', 'for', 'skipIf', 'runIf']);

/**
 * @typedef {object} Case
 * @property {string} file  relative to packages/daemon/src
 * @property {string} key   `<file> › <describe…> › <title>`
 */

/**
 * `describe`/`it`/`test` when `expr` registers one, else null.
 * @param {ts.Expression} expr @returns {string | null}
 */
function registrar(expr) {
  if (ts.isIdentifier(expr)) return BASES.has(expr.text) ? expr.text : null;
  if (ts.isPropertyAccessExpression(expr) && DIRECT.has(expr.name.text))
    return registrar(expr.expression);
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    CALLED.has(expr.expression.name.text)
  )
    return registrar(expr.expression.expression);
  return null;
}

/**
 * Every test case in one test file, in source order. Duplicate keys get ` [2]`, ` [3]`, ….
 * @param {string} source @param {string} file relative to packages/daemon/src @returns {Case[]}
 */
export function extractCases(source, file) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  /** @type {string[]} */
  const keys = [];
  /** @param {ts.Expression | undefined} arg */
  const title = (arg) => {
    if (!arg) return '(untitled)';
    const text =
      ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)
        ? arg.text
        : arg.getText(sf);
    return text.replace(/\s*\n\s*/g, ' ');
  };
  /** @param {ts.Node} node @param {string[]} chain */
  const visit = (node, chain) => {
    if (ts.isCallExpression(node)) {
      const kind = registrar(node.expression);
      if (kind === 'describe') {
        const inner = [...chain, title(node.arguments[0])];
        for (const a of node.arguments.slice(1)) visit(a, inner);
        return;
      }
      if (kind) {
        keys.push([file, ...chain, title(node.arguments[0])].join(SEP));
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, chain));
  };
  visit(sf, []);
  /** @type {Map<string, number>} */
  const seen = new Map();
  return keys.map((k) => {
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return { file, key: n === 1 ? k : `${k} [${n}]` };
  });
}

/** Every `*.test.ts` under `dir`, relative and with `/`, sorted. @param {string} dir */
export function testFiles(dir) {
  /** @param {string} d @returns {string[]} */
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = join(d, e.name);
      if (e.isDirectory()) return walk(p);
      return e.name.endsWith('.test.ts') ? [relative(dir, p).split('\\').join('/')] : [];
    });
  return walk(dir).sort();
}

/**
 * @typedef {object} Ledger
 * @property {{ key: string, rust: string, line: number }[]} rows
 * @property {{ glob: string, ticked: boolean }[]} ported  every line of the `## Ported` block
 */

/** @param {string} cell */
const unescapeCell = (cell) => cell.trim().replace(/\\\|/g, '|');
/** @param {string} text */
const escapeCell = (text) => text.replace(/\|/g, '\\|');

/** @param {string} md @returns {Ledger} */
export function parseLedger(md) {
  /** @type {Ledger} */
  const ledger = { rows: [], ported: [] };
  let inPorted = false;
  md.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line === PORTED_START) inPorted = true;
    else if (line === PORTED_END) inPorted = false;
    else if (inPorted) {
      const m = /^- \[([ xX])\] `?([^`]+?)`?$/.exec(line);
      if (m) ledger.ported.push({ glob: /** @type {string} */ (m[2]), ticked: m[1] !== ' ' });
    } else if (line.startsWith('|') && !/^\|\s*-/.test(line)) {
      // Split on `|` not preceded by a backslash.
      const cells = line.slice(1, line.endsWith('|') ? -1 : undefined).split(/(?<!\\)\|/);
      const key = unescapeCell(cells[0] ?? '');
      if (key === 'TS case') return;
      ledger.rows.push({ key, rust: unescapeCell(cells[1] ?? ''), line: i + 1 });
    }
  });
  return ledger;
}

const RUST_REF = /^([\w./-]+\.rs)::(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)$/;

/**
 * @typedef {object} CheckInput
 * @property {Case[]} cases
 * @property {Ledger} ledger
 * @property {string[]} ported  globs relative to packages/daemon/src
 * @property {(path: string) => string | null} readFile  repo-relative; null when missing
 */

/**
 * Every problem with the ledger, as one line each; empty when it passes.
 * @param {CheckInput} input @returns {string[]}
 */
export function checkParity({ cases, ledger, ported, readFile }) {
  /** @type {string[]} */
  const errors = [];
  const caseKeys = new Map(cases.map((c) => [c.key, c]));
  /** @type {Map<string, string>} */
  const rows = new Map();
  for (const r of ledger.rows) {
    if (rows.has(r.key)) errors.push(`PARITY.md:${r.line}: duplicate row: ${r.key}`);
    else rows.set(r.key, r.rust);
    if (!caseKeys.has(r.key))
      errors.push(`PARITY.md:${r.line}: extra row (no such TS case): ${r.key}`);
  }
  const files = [...new Set(cases.map((c) => c.file))];
  for (const glob of ported) {
    if (!files.some((f) => matchGlob(glob, f)))
      errors.push(`ported glob matches no TS test file: ${glob}`);
  }
  /** @type {Map<string, string | null>} */
  const sources = new Map();
  /** @param {string} path */
  const source = (path) => {
    if (!sources.has(path)) sources.set(path, readFile(path));
    return sources.get(path) ?? null;
  };
  for (const c of cases) {
    const rust = rows.get(c.key);
    if (rust === undefined) {
      errors.push(`missing row: ${c.key}`);
      continue;
    }
    const isPorted = ported.some((g) => matchGlob(g, c.file));
    if (rust === 'todo') {
      if (isPorted) errors.push(`todo in a ported file: ${c.key}`);
      continue;
    }
    if (rust.startsWith('dropped:')) {
      if (rust.slice('dropped:'.length).trim() === '')
        errors.push(`dropped without a reason: ${c.key}`);
      continue;
    }
    for (const ref of rust.split(',').map((s) => s.trim().replace(/^`|`$/g, ''))) {
      const m = RUST_REF.exec(ref);
      if (!m) {
        errors.push(
          `not todo, dropped: <reason> or <path>.rs::<fn>: ${JSON.stringify(ref)} (${c.key})`,
        );
        continue;
      }
      const [, path, fn] = /** @type {[string, string, string]} */ (/** @type {unknown} */ (m));
      const text = source(path);
      if (text === null) errors.push(`no such Rust file ${path} (${c.key})`);
      else if (!new RegExp(`\\bfn\\s+${fn}\\b`).test(text))
        errors.push(`no fn ${fn} in ${path} (${c.key})`);
    }
  }
  return errors;
}

const HEADER = `# PARITY: TS daemon tests → Rust tests

The ledger of ADR-0026 §3. Every test case of the frozen TS daemon (\`packages/daemon/src/**/*.test.ts\`, tag
\`daemon-ts-freeze\`) has one row here. \`node scripts/test-parity.js\` checks it in \`scripts/ci.sh\`;
\`--write\` regenerates this file and keeps every Rust cell and tick.

- **Key:** \`<file> › <describe…> › <title>\`, with the file relative to \`packages/daemon/src\`. An \`it.each\` is one
  row (its title template). A repeated key gets \` [2]\`. A \`|\` in a title is written \`\\|\`.
- **Rust cell:** \`todo\`, or \`dropped: <reason>\` (needs Ben's OK in review), or one or more comma-separated
  \`<repo path>.rs::…::<fn>\`, e.g. \`crates/conductor-daemon/tests/seam.rs::no_os_cfg_outside_platform\`. The file
  and the \`fn\` must exist.
- **Ported:** tick your files in the list below (\`[x]\`) when your ticket ports them; extra \`- [x] <glob>\` lines
  are allowed. A ported file may have no \`todo\` row. Edit only your own lines: the blank lines between entries
  and the per-file sections keep parallel tickets from conflicting.

## Ported
`;

/**
 * PARITY.md for these cases, keeping `existing`'s Rust cells and ticks.
 * @param {Case[]} cases @param {Ledger} [existing] @returns {string}
 */
export function renderLedger(cases, existing = { rows: [], ported: [] }) {
  const rust = new Map(existing.rows.map((r) => [r.key, r.rust]));
  const ticked = new Map(existing.ported.map((p) => [p.glob, p.ticked]));
  const files = [...new Set(cases.map((c) => c.file))].sort();
  const extra = existing.ported.filter((p) => !files.includes(p.glob));
  const portedLines = [
    ...files.map((f) => `- [${ticked.get(f) ? 'x' : ' '}] \`${f}\``),
    ...extra.map((p) => `- [${p.ticked ? 'x' : ' '}] \`${p.glob}\``),
  ];
  const sections = files.map((f) => {
    const rows = cases
      .filter((c) => c.file === f)
      .map((c) => `| ${escapeCell(c.key)} | ${escapeCell(rust.get(c.key) ?? 'todo')} |`);
    return `### ${f}\n\n| TS case | Rust |\n|---|---|\n${rows.join('\n')}\n`;
  });
  return [
    HEADER,
    `${PORTED_START}\n${portedLines.join('\n\n')}\n${PORTED_END}\n`,
    `## Cases\n`,
    ...sections,
  ].join('\n');
}

/** @param {string} root repo root @returns {Case[]} */
export function repoCases(root) {
  const src = join(root, TS_SRC);
  return testFiles(src).flatMap((f) => extractCases(readFileSync(join(src, f), 'utf8'), f));
}

/** @param {Case[]} cases @param {Ledger} ledger @param {string[]} ported */
function summary(cases, ledger, ported) {
  const rust = new Map(ledger.rows.map((r) => [r.key, r.rust]));
  let todo = 0;
  let dropped = 0;
  for (const c of cases) {
    const r = rust.get(c.key) ?? 'todo';
    if (r === 'todo') todo++;
    else if (r.startsWith('dropped:')) dropped++;
  }
  const files = new Set(cases.map((c) => c.file)).size;
  const mapped = cases.length - todo - dropped;
  const dupes = cases.filter((c) => / \[\d+\]$/.test(c.key)).length;
  return (
    `test-parity: ${cases.length} cases in ${files} files: todo ${todo}, mapped ${mapped}, ` +
    `dropped ${dropped}${dupes ? `, ${dupes} repeated key(s)` : ''}; ported globs: ` +
    (ported.length ? ported.join(', ') : '(none)')
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  /** @type {string[] | null} */
  let files = null;
  let write = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--write') write = true;
    else if (a === '--files' && args[i + 1] !== undefined) {
      files ??= [];
      files.push(/** @type {string} */ (args[++i]));
    } else {
      process.stderr.write('usage: test-parity.js [--files <glob>]… [--write]\n');
      process.exit(2);
    }
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const ledgerPath = join(root, LEDGER);
  const cases = repoCases(root);
  let ledger = parseLedger(existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : '');
  if (write) {
    writeFileSync(ledgerPath, renderLedger(cases, ledger));
    ledger = parseLedger(readFileSync(ledgerPath, 'utf8'));
  }
  const ported = files ?? ledger.ported.filter((p) => p.ticked).map((p) => p.glob);
  const readFile = (/** @type {string} */ p) => {
    const abs = join(root, p);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  };
  const errors = checkParity({ cases, ledger, ported, readFile });
  process.stdout.write(`${summary(cases, ledger, ported)}\n`);
  if (errors.length > 0) {
    process.stderr.write(errors.map((e) => `  ${e}\n`).join(''));
    process.stderr.write(`test-parity: ${errors.length} problem(s) in ${LEDGER}\n`);
    process.exit(1);
  }
}
