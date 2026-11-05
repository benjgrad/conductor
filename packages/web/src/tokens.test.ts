// UXR-22 / UXR-23 (11-web-ui §Tokens, §Colour semantics): the type ramp is the six agreed steps,
// and every semantic colour reads at WCAG AA in both schemes. Reads styles.css as text, like
// focus-styles.test.ts (vitest empties stylesheets).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

/** The custom properties of the first `:root {…}` block at or after `from`. */
function rootVars(from: number): Map<string, string> {
  const start = styles.indexOf(':root {', from);
  const body = styles.slice(start, styles.indexOf('}', start));
  const vars = new Map<string, string>();
  for (const [, name = '', value = ''] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g))
    vars.set(name, value.trim());
  return vars;
}

const light = rootVars(0);
const dark = new Map([
  ...light,
  ...rootVars(styles.indexOf('@media (prefers-color-scheme: dark)')),
]);

function hex(vars: Map<string, string>, name: string): string {
  let v = vars.get(name);
  for (let i = 0; v?.startsWith('var(') && i < 3; i++)
    v = vars.get(/var\((--[\w-]+)\)/.exec(v)?.[1] ?? '');
  if (!v || !/^#[0-9a-f]{3,6}$/i.test(v)) throw new Error(`${name} is not a hex colour: ${v}`);
  return v.length === 4 ? `#${[...v.slice(1)].map((c) => c + c).join('')}` : v;
}

function luminance(colour: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const c = parseInt(colour.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(vars: Map<string, string>, fg: string, bg: string): number {
  const [a = 0, b = 0] = [luminance(hex(vars, fg)), luminance(hex(vars, bg))].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

const SEMANTIC = ['--attention', '--danger', '--warn', '--info', '--ok'];

describe('type ramp', () => {
  it('is 11 / 12 / 13 / 14 / 16 / 20 px', () => {
    const ramp = ['xs', 'sm', 'base', 'md', 'lg', 'xl'].map((s) => light.get(`--text-${s}`));
    expect(ramp).toEqual(['11px', '12px', '13px', '14px', '16px', '20px']);
  });
});

describe.each([
  ['light', light],
  ['dark', dark],
])('%s colours', (_scheme, vars) => {
  it.each(SEMANTIC)('%s is AA on its own -bg, on --panel and on --bg', (token) => {
    expect(contrast(vars, token, `${token}-bg`)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(vars, token, '--panel')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(vars, token, '--bg')).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SEMANTIC)('--muted is AA on %s-bg', (token) => {
    expect(contrast(vars, '--muted', `${token}-bg`)).toBeGreaterThanOrEqual(4.5);
  });

  it('text, field edges and accent fills keep their contrast', () => {
    expect(contrast(vars, '--text', '--panel')).toBeGreaterThanOrEqual(7);
    expect(contrast(vars, '--border-strong', '--panel')).toBeGreaterThanOrEqual(3);
    expect(contrast(vars, '--on-accent', '--accent')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('colour tokens', () => {
  it('--ask is gone: a person needed is --attention, a failure is --danger', () => {
    expect(styles).not.toMatch(/--ask\b/);
  });
});
