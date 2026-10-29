import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { SCREENSHOT_NAME_RE, screenshotPairs, screenshotsMarker } from '@conductor/shared';

// M2-T35b (Ben, 2026-10-29): a PR with a UI change carries before and after screenshots. The
// agent saves them in its session's screenshot directory (`CONDUCTOR_SCREENSHOT_DIR`, outside the
// worktree, so they are never committed and never make the tree dirty); open_pr attaches the pairs
// (open-pr.ts `pushScreenshots`) and writes the table + marker that the `pr_screenshots` condition
// reads (M2-T35a).
//
// The directory is agent-written, so it is read as untrusted input: the directory itself must be
// a real directory (not a symlink); only regular files (lstat, then fstat on the opened fd: never
// a symlink, FIFO or device) named `before-<view>.png` / `after-<view>.png`, each at most
// MAX_SCREENSHOT_BYTES, starting with the PNG signature, at most MAX_SCREENSHOT_FILES of them.
// Their bytes are read here once; open_pr writes those bytes into its private repo, so a file
// swapped after this check is never what gets pushed.

export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
export const MAX_SCREENSHOT_FILES = 20;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SESSION_RE = /^[0-9a-f-]{36}$/;

/** `<root>/artifacts/<session>/screenshots`; null for a session id that isn't a UUID. */
export function screenshotDir(root: string, sessionId: string): string | null {
  return SESSION_RE.test(sessionId) ? join(root, 'artifacts', sessionId, 'screenshots') : null;
}

/** Create the session's screenshot directory and return the env that names it ({} on failure). */
export function screenshotEnv(root: string, sessionId: string): Record<string, string> {
  const dir = screenshotDir(root, sessionId);
  if (dir === null) return {};
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { CONDUCTOR_SCREENSHOT_DIR: dir };
  } catch {
    return {};
  }
}

export interface Screenshot {
  name: string;
  bytes: Buffer;
}

export interface ScreenshotSet {
  /** The views with both files, sorted. */
  views: string[];
  /** The files of those views (before, after per view, in view order). */
  files: Screenshot[];
  /** Files that were refused, with why (for the daemon's output; never fatal). */
  skipped: string[];
}

function readPng(path: string): Buffer | string {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (e) {
    return `can't open (${(e as NodeJS.ErrnoException).code ?? 'error'})`;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return 'not a regular file';
    if (st.size > MAX_SCREENSHOT_BYTES) return `over ${MAX_SCREENSHOT_BYTES / 1024 / 1024} MB`;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    const bytes = buf.subarray(0, off);
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'not a PNG';
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** The validated before/after pairs in `dir` (a missing directory is an empty set). */
export function readScreenshots(dir: string): ScreenshotSet {
  const empty: ScreenshotSet = { views: [], files: [], skipped: [] };
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      return { ...empty, skipped: [`${dir} is not a directory`] };
    }
  } catch {
    return empty;
  }
  const skipped: string[] = [];
  const ok = new Map<string, Buffer>();
  const names = readdirSync(dir).sort();
  for (const name of names) {
    if (!SCREENSHOT_NAME_RE.test(name)) {
      skipped.push(`${name}: not named before-<view>.png or after-<view>.png`);
      continue;
    }
    if (ok.size >= MAX_SCREENSHOT_FILES) {
      skipped.push(`${name}: more than ${MAX_SCREENSHOT_FILES} files`);
      continue;
    }
    const path = join(dir, name);
    try {
      if (!lstatSync(path).isFile()) {
        skipped.push(`${name}: not a regular file`);
        continue;
      }
    } catch {
      continue;
    }
    const r = readPng(path);
    if (typeof r === 'string') skipped.push(`${name}: ${r}`);
    else ok.set(name, r);
  }
  const views = screenshotPairs([...ok.keys()]);
  const files = views.flatMap((v) =>
    ['before', 'after'].map((side) => {
      const name = `${side}-${v}.png`;
      return { name, bytes: ok.get(name)! };
    }),
  );
  for (const name of ok.keys()) {
    const view = SCREENSHOT_NAME_RE.exec(name)![2]!;
    if (!views.includes(view))
      skipped.push(`${name}: no matching ${name.startsWith('before') ? 'after' : 'before'} file`);
  }
  return { views, files, skipped };
}

/** The PR body section: a Before / After table, then the marker the condition counts. */
export function screenshotsSection(
  views: readonly string[],
  urlFor: (name: string) => string,
): string {
  const rows = views.map(
    (v) =>
      `| ${v} | ![before ${v}](${urlFor(`before-${v}.png`)}) | ![after ${v}](${urlFor(`after-${v}.png`)}) |`,
  );
  return [
    '## Screenshots',
    '',
    '| View | Before | After |',
    '| --- | --- | --- |',
    ...rows,
    '',
    screenshotsMarker(views.length),
  ].join('\n');
}
