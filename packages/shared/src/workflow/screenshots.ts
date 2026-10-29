// M2-T35 (Ben, 2026-10-29): a PR with a UI change carries before and after screenshots. The agent
// saves them, conductor's `open_pr` attaches them (a Before / After table in the PR body), and the
// `pr_screenshots` condition checks the PR: no file matching `ui_paths` changed, or the body says
// how many pairs it shows. Pure helpers shared by the daemon (evaluation, open_pr) and the engine.

/** The default `ui_paths`: files whose change is visible in a UI. */
export const DEFAULT_UI_PATHS: readonly string[] = ['**/*.{tsx,jsx,vue,svelte,css,scss,html}'];

/** What `open_pr` writes in the PR body after the table; the condition reads `pairs`. */
export function screenshotsMarker(pairs: number): string {
  return `<!-- conductor:screenshots pairs=${pairs} -->`;
}
export const SCREENSHOTS_MARKER_RE = /<!-- conductor:screenshots pairs=(\d{1,3}) -->/;

/** A screenshot file name: `before-<view>.png` or `after-<view>.png`. */
export const SCREENSHOT_NAME_RE = /^(before|after)-([a-z0-9][a-z0-9-]{0,39})\.png$/;

/** The views with both a before and an after file, sorted. */
export function screenshotPairs(names: readonly string[]): string[] {
  const seen = { before: new Set<string>(), after: new Set<string>() };
  for (const name of names) {
    const m = SCREENSHOT_NAME_RE.exec(name);
    if (m) seen[m[1] as 'before' | 'after'].add(m[2]!);
  }
  return [...seen.before].filter((v) => seen.after.has(v)).sort();
}

const globCache = new Map<string, RegExp>();

/**
 * A path glob as a RegExp, minimatch-style for the subset workflows use: `**` (any directories,
 * including none, as a whole segment), `*` (within a segment), `?` (one character), `{a,b}`
 * (alternatives, not nested). Everything else is literal; dot files match like any other.
 */
export function globToRegExp(glob: string): RegExp {
  const hit = globCache.get(glob);
  if (hit) return hit;
  let re = '';
  let i = 0;
  let inBraces = false;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      const atStart = i === 0 || glob[i - 1] === '/';
      const atEnd = i + 2 === glob.length || glob[i + 2] === '/';
      if (atStart && glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 3;
        continue;
      }
      if (atStart && atEnd) {
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i += 2;
      continue;
    }
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{' && !inBraces) {
      inBraces = true;
      re += '(?:';
    } else if (c === '}' && inBraces) {
      inBraces = false;
      re += ')';
    } else if (c === ',' && inBraces) re += '|';
    else re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
    i += 1;
  }
  if (inBraces) re = re.replace('(?:', '\\{').replaceAll('|', ',');
  const out = new RegExp(`^${re}$`);
  globCache.set(glob, out);
  return out;
}

/** The paths that match any of `globs`. */
export function matchingPaths(paths: readonly string[], globs: readonly string[]): string[] {
  const res = globs.map(globToRegExp);
  return paths.filter((p) => res.some((r) => r.test(p)));
}
