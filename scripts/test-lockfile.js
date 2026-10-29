// @ts-check
// Which workspace packages a pnpm-lock.yaml change actually reaches. A lockfile diff counts against
// a package only when that package's resolved dependency closure changed: its own entries, those of
// every workspace package it links (daemon → shared), the root toolchain (vitest, vite, tsc run
// every test), and every snapshot and package entry reachable from them. Used by the test tiers
// (scripts/test-tiers.js) and the daemon-windows job (scripts/test-affected.js).
//
// Anything uncertain runs more: an unparseable lockfile or a changed top-level setting returns null,
// and a changed root closure reaches every package; both leave `pnpm-lock.yaml` a global change.
import { posix } from 'node:path';
import { parse } from 'yaml';

export const LOCKFILE = 'pnpm-lock.yaml';

/** Top-level lockfile keys that can change how every package resolves. */
const GLOBAL_KEYS = [
  'lockfileVersion',
  'settings',
  'overrides',
  'patchedDependencies',
  'catalogs',
  'pnpmfileChecksum',
];
const DEP_GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/**
 * @typedef {{ importers?: Record<string, Record<string, Record<string, { version: string }>>>,
 *   packages?: Record<string, unknown>, snapshots?: Record<string, Record<string, unknown>>,
 *   [key: string]: unknown }} Lock
 */

/**
 * Importer ids (`.`, `packages/daemon`, …) whose resolved closure differs between the two
 * lockfiles, or null when that can't be told (unparseable, or a global setting changed).
 * @param {string} baseText @param {string} headText
 * @returns {string[] | null}
 */
export function lockfileImporters(baseText, headText) {
  /** @type {unknown} */ let baseValue;
  /** @type {unknown} */ let headValue;
  try {
    baseValue = parse(baseText);
    headValue = parse(headText);
  } catch {
    return null;
  }
  if (!isObject(baseValue) || !isObject(headValue)) return null;
  const base = /** @type {Lock} */ (baseValue);
  const head = /** @type {Lock} */ (headValue);
  for (const key of GLOBAL_KEYS) {
    if (stable(base[key]) !== stable(head[key])) return null;
  }
  const ids = new Set([...Object.keys(base.importers ?? {}), ...Object.keys(head.importers ?? {})]);
  return [...ids].filter((id) => closure(base, id) !== closure(head, id)).sort();
}

/**
 * Replace `pnpm-lock.yaml` in a changed-path list with `<importer>/package.json` for each package
 * the change reaches, so per-package rules apply. Left as is (a global change) when the root
 * closure changed or the lockfiles can't be compared.
 * @param {string[]} changed @param {() => [string, string] | null} read base and head lockfile text
 */
export function translateLockfile(changed, read) {
  if (!changed.includes(LOCKFILE)) return changed;
  const texts = read();
  const importers = texts && lockfileImporters(...texts);
  if (!importers || importers.includes('.')) return changed;
  const rest = changed.filter((f) => f !== LOCKFILE);
  return [...new Set([...rest, ...importers.map((id) => `${id}/package.json`)])];
}

/**
 * A comparable signature of everything importer `id` (and the root) resolves to.
 * @param {Lock} lock @param {string} id
 */
function closure(lock, id) {
  const importers = lock.importers ?? {};
  if (!(id in importers)) return 'absent';
  /** @type {Map<string, string>} */
  const out = new Map();
  /** @type {string[]} */
  const queue = [];
  /** @param {string} importer */
  const visitImporter = (importer) => {
    const key = `importer:${importer}`;
    if (out.has(key)) return;
    const entry = importers[importer];
    out.set(key, stable(entry ?? null));
    for (const group of DEP_GROUPS) {
      for (const [name, dep] of Object.entries(entry?.[group] ?? {})) {
        const version = String(dep?.version ?? '');
        if (version.startsWith('link:')) {
          visitImporter(posix.normalize(posix.join(importer, version.slice('link:'.length))));
        } else queue.push(snapshotKey(name, version));
      }
    }
  };
  visitImporter('.');
  visitImporter(id);
  while (queue.length > 0) {
    const key = /** @type {string} */ (queue.pop());
    if (out.has(key)) continue;
    const snapshot = lock.snapshots?.[key];
    out.set(key, stable([snapshot ?? null, lock.packages?.[key.replace(/\(.*$/, '')] ?? null]));
    for (const group of ['dependencies', 'optionalDependencies']) {
      const deps = /** @type {Record<string, string> | undefined} */ (snapshot?.[group]);
      for (const [name, version] of Object.entries(deps ?? {})) {
        queue.push(snapshotKey(name, String(version)));
      }
    }
  }
  return stable(Object.fromEntries(out));
}

/**
 * `zod` + `4.6.7` → `zod@4.6.7`; an alias's version is already a key
 * (`typescript` + `@typescript/typescript6@6.0.2`).
 * @param {string} name @param {string} version
 */
function snapshotKey(name, version) {
  const bare = version.replace(/\(.*$/, '').replace(/^@/, '');
  return bare.includes('@') ? version : `${name}@${version}`;
}

/** JSON with sorted keys, so key order never reads as a change. @param {unknown} value */
function stable(value) {
  return JSON.stringify(value, (_k, /** @type {unknown} */ v) =>
    isObject(v) && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** @param {unknown} v @returns {v is Record<string, any>} */
function isObject(v) {
  return typeof v === 'object' && v !== null;
}
