#!/usr/bin/env node
// @ts-check
// UXR-22/24/57 (11-web-ui §Tokens): the web CSS speaks in tokens. Outside `:root` (the light block
// and the dark `@media` block), a declaration may not use
//   - a raw `font-size` length (px / rem / pt): use `var(--text-*)`, `inherit`, `em` or `%`;
//   - a `padding*` / `margin*` px value other than 0, 1px or 2px: use `var(--space-*)`;
//   - a hex colour anywhere: use a colour token.
// Custom properties (`--tone: …`) are exempt: they are local tokens. Exceptions live in
// scripts/lint-css.allow.json ({file, selector, property, reason}); an entry that matches nothing
// fails, so stale exceptions get removed. Runs first in `pnpm lint`.
//
//   node scripts/lint-css.js [files…]   (default: every packages/web/src/**/*.css)
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {{ file: string, selector: string, property: string, reason?: string }} AllowEntry */
/** @typedef {{ file: string, line: number, selector: string, property: string, value: string, rule: string }} Violation */

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const FONT_LENGTH = /(^|[\s(,])-?\d*\.?\d+(px|rem|pt)\b/;
const PX = /-?\d*\.?\d+px\b/g;
const SMALL_PX = new Set(['0px', '1px', '2px', '-1px', '-2px']);

/** Blank out comments (and keep newlines) so offsets still map to the right line. */
function stripComments(/** @type {string} */ text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}

/**
 * The rule a declaration breaks, if any.
 * @param {string} property lower-case
 * @param {string} value
 */
export function checkDeclaration(property, value) {
  if (property.startsWith('--')) return undefined;
  if (HEX.test(value)) return 'no-hex-colour';
  if (property === 'font-size' && FONT_LENGTH.test(value)) return 'font-size-token';
  if (/^(padding|margin)(-|$)/.test(property)) {
    for (const px of value.match(PX) ?? []) if (!SMALL_PX.has(px)) return 'spacing-token';
  }
  return undefined;
}

/**
 * Every violation in one stylesheet, allowlisted ones removed.
 * @param {string} text
 * @param {string} file the path the allowlist names (repo-relative)
 * @param {AllowEntry[]} [allow]
 * @param {Set<AllowEntry>} [used] filled with the allowlist entries that matched
 * @returns {Violation[]}
 */
export function lintCss(text, file, allow = [], used = new Set()) {
  const src = stripComments(text);
  /** @type {string[]} */
  const stack = [];
  /** @type {Violation[]} */
  const out = [];
  let start = 0;
  const breaks = [...src.matchAll(/\n/g)].map((m) => m.index ?? 0);
  /** 1-based line of an offset. */
  const lineAt = (/** @type {number} */ offset) => {
    let lo = 0;
    let hi = breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((breaks[mid] ?? 0) < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  const inRoot = () => stack.some((p) => p === ':root');
  const inAtRule = () => stack.length === 0 || (stack[stack.length - 1] ?? '').startsWith('@');
  const declaration = (/** @type {string} */ chunk, /** @type {number} */ at) => {
    const colon = chunk.indexOf(':');
    if (colon < 0 || inAtRule() || inRoot()) return;
    const property = chunk.slice(0, colon).trim().toLowerCase();
    const value = chunk.slice(colon + 1).trim();
    const rule = checkDeclaration(property, value);
    if (!rule) return;
    const selector = stack[stack.length - 1] ?? '';
    const hit = allow.find(
      (a) => a.file === file && a.selector === selector && a.property === property,
    );
    if (hit) {
      used.add(hit);
      return;
    }
    out.push({ file, line: lineAt(at + chunk.search(/\S/)), selector, property, value, rule });
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      stack.push(src.slice(start, i).trim().replace(/\s+/g, ' '));
      start = i + 1;
    } else if (ch === ';' || ch === '}') {
      const chunk = src.slice(start, i);
      if (chunk.trim()) declaration(chunk, start);
      if (ch === '}') stack.pop();
      start = i + 1;
    }
  }
  return out;
}

/** @param {string} dir */
function cssFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...cssFiles(p));
    else if (e.name.endsWith('.css')) out.push(p);
  }
  return out.sort();
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  /** @type {unknown} */
  const parsed = JSON.parse(readFileSync(join(root, 'scripts/lint-css.allow.json'), 'utf8'));
  const allow = /** @type {AllowEntry[]} */ (parsed);
  const args = process.argv.slice(2);
  const files = args.length
    ? args.map((f) => join(process.cwd(), f))
    : cssFiles(join(root, 'packages/web/src'));
  /** @type {Set<AllowEntry>} */
  const used = new Set();
  /** @type {Violation[]} */
  const all = [];
  for (const f of files)
    all.push(...lintCss(readFileSync(f, 'utf8'), relative(root, f), allow, used));
  for (const v of all)
    console.error(`${v.file}:${v.line}  ${v.rule}  ${v.selector} { ${v.property}: ${v.value} }`);
  const stale = args.length ? [] : allow.filter((a) => !used.has(a));
  for (const a of stale)
    console.error(
      `scripts/lint-css.allow.json: unused entry ${a.file} ${a.selector} { ${a.property} }`,
    );
  if (all.length || stale.length) {
    console.error(
      `lint-css: ${all.length} violation(s), ${stale.length} stale allowlist entr(ies) (11-web-ui §Tokens)`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
