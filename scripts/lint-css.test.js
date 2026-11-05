// @ts-check
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkDeclaration, lintCss } from './lint-css.js';

const rules = (/** @type {string} */ css) => lintCss(css, 'a.css').map((v) => v.rule);

describe('checkDeclaration', () => {
  it('wants a type token for font-size, and lets relative sizes through', () => {
    expect(checkDeclaration('font-size', '12px')).toBe('font-size-token');
    expect(checkDeclaration('font-size', '0.8rem')).toBe('font-size-token');
    expect(checkDeclaration('font-size', 'var(--text-sm)')).toBeUndefined();
    expect(checkDeclaration('font-size', 'inherit')).toBeUndefined();
    expect(checkDeclaration('font-size', '0.85em')).toBeUndefined();
    expect(checkDeclaration('font-size', '90%')).toBeUndefined();
  });

  it('wants spacing tokens for padding and margin, allowing 0, 1px and 2px', () => {
    expect(checkDeclaration('padding', '6px 10px')).toBe('spacing-token');
    expect(checkDeclaration('margin-top', '12px')).toBe('spacing-token');
    expect(checkDeclaration('padding-inline', 'var(--space-2) 10px')).toBe('spacing-token');
    expect(checkDeclaration('margin', 'calc(-1 * 8px)')).toBe('spacing-token');
    expect(checkDeclaration('padding', '2px var(--space-2)')).toBeUndefined();
    expect(checkDeclaration('margin', '0 -1px')).toBeUndefined();
    expect(checkDeclaration('margin', 'calc(-1 * var(--space-2))')).toBeUndefined();
  });

  it('leaves other lengths alone', () => {
    expect(checkDeclaration('gap', '6px')).toBeUndefined();
    expect(checkDeclaration('width', '320px')).toBeUndefined();
  });

  it('rejects a hex colour anywhere, but not in a custom property', () => {
    expect(checkDeclaration('color', '#fff')).toBe('no-hex-colour');
    expect(checkDeclaration('border', '1px solid #a2262e')).toBe('no-hex-colour');
    expect(checkDeclaration('color', 'var(--danger, #b42318)')).toBe('no-hex-colour');
    expect(checkDeclaration('--tone', '#fff')).toBeUndefined();
  });
});

describe('lintCss', () => {
  it('skips :root and the dark :root block', () => {
    expect(rules(':root { --bg: #fff; font-size: 14px; }')).toEqual([]);
    expect(rules('@media (prefers-color-scheme: dark) { :root { color: #000; } }')).toEqual([]);
    expect(rules('.x { color: #000; }')).toEqual(['no-hex-colour']);
    expect(rules('@media (max-width: 700px) { .x { padding: 6px; } }')).toEqual(['spacing-token']);
  });

  it('reports the selector, property and line, past a multi-line comment', () => {
    const css = '/* one\n two\n three */\n.a,\n.b {\n  color: red;\n  font-size: 12px;\n}\n';
    expect(lintCss(css, 'a.css')).toEqual([
      {
        file: 'a.css',
        line: 7,
        selector: '.a, .b',
        property: 'font-size',
        value: '12px',
        rule: 'font-size-token',
      },
    ]);
  });

  it('a last declaration without a semicolon is still checked', () => {
    expect(rules('.x { margin: 12px }')).toEqual(['spacing-token']);
  });

  it('an allowlist entry suppresses its violation and is marked used', () => {
    const entry = { file: 'a.css', selector: '.x', property: 'padding', reason: 'test' };
    /** @type {Set<import('./lint-css.js').AllowEntry>} */
    const used = new Set();
    expect(
      lintCss('.x { padding: 46px; } .y { padding: 46px; }', 'a.css', [entry], used),
    ).toHaveLength(1);
    expect(used.has(entry)).toBe(true);
    expect(lintCss('.x { padding: 46px; }', 'b.css', [entry])).toHaveLength(1);
  });
});

describe('the web CSS', () => {
  // Spawns the CLI: the real stylesheets and allowlist are what's under test (an unused
  // allowlist entry, too, fails only in the CLI).
  it('passes', () => {
    const r = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./lint-css.js', import.meta.url))],
      {
        encoding: 'utf8',
      },
    );
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
