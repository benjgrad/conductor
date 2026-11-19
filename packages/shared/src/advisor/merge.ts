import type { RepoChecks } from '../workflow/repo-checks.js';
import { stableJson, WORKFLOW_DEPTH } from './diff.js';

// ADR-0033 §Amendment "apply rebases": applying a change proposal replays what it changed (base →
// proposed) onto what is there now, instead of saving its whole snapshot. Two proposals made from
// the same base both apply when they change different paths; only a path changed differently
// since is a conflict. Same granularity as the board's diff (`diffWorkflow`, `diffRepoChecks`):
// arrays and values below WORKFLOW_DEPTH are compared whole. Pure.

/** A three-way merge's outcome: the merged value and how many paths it wrote (0 = already there). */
export type MergeResult<T> =
  { ok: true; merged: T; applied: number } | { ok: false; conflicts: string[] };

type Path = readonly string[];

interface LeafChange {
  path: Path;
  /** undefined = absent. */
  before: unknown;
  after: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const same = (a: unknown, b: unknown) =>
  a === undefined || b === undefined ? a === b : stableJson(a) === stableJson(b);

/** As `diff.ts`'s walk, with path arrays (names may hold dots: `ui.approve`) and whole values. */
function leafChanges(
  before: unknown,
  after: unknown,
  path: Path,
  depth: number,
  out: LeafChange[],
): void {
  if (before === undefined && after === undefined) return;
  if (depth > 0 && isObject(before) && isObject(after)) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      leafChanges(before[k], after[k], [...path, k], depth - 1, out);
    }
    return;
  }
  if (!same(before, after)) out.push({ path, before, after });
}

function getAt(root: unknown, path: Path): unknown {
  let v = root;
  for (const k of path) {
    if (!isObject(v)) return undefined;
    v = v[k];
  }
  return v;
}

/** Display form of a path for a conflict message. */
const pathName = (path: Path) => (path.length === 0 ? '(whole value)' : path.join('.'));

/**
 * Replay `base → ours` onto a deep copy of `theirs`. Each changed leaf is written only when
 * `theirs` still has the base's value there; when it already has ours, it is skipped; anything
 * else (or a parent `theirs` removed) is a conflict.
 */
function replay(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  depth: number,
): MergeResult<unknown> {
  const changes: LeafChange[] = [];
  leafChanges(base, ours, [], depth, changes);
  let merged: unknown = theirs === undefined ? undefined : structuredClone(theirs);
  const conflicts: string[] = [];
  let applied = 0;
  for (const c of changes) {
    const now = getAt(merged, c.path);
    if (same(now, c.after)) continue;
    if (!same(now, c.before)) {
      conflicts.push(pathName(c.path));
      continue;
    }
    if (c.path.length === 0) {
      merged = c.after === undefined ? undefined : structuredClone(c.after);
      applied++;
      continue;
    }
    const parent = getAt(merged, c.path.slice(0, -1));
    if (!isObject(parent)) {
      conflicts.push(pathName(c.path));
      continue;
    }
    const key = c.path[c.path.length - 1]!;
    if (c.after === undefined) delete parent[key];
    else parent[key] = structuredClone(c.after);
    applied++;
  }
  return conflicts.length > 0 ? { ok: false, conflicts } : { ok: true, merged, applied };
}

const withoutVersion = (d: unknown) => {
  if (!isObject(d)) return d;
  const rest = { ...d };
  delete rest.version;
  return rest;
};

/**
 * Rebase a workflow proposal: its changes from `base` (the version it was made from) replayed onto
 * `theirs` (the latest). `version` is ignored; the caller validates the result and saves it.
 */
export function mergeWorkflow(
  base: unknown,
  ours: unknown,
  theirs: unknown,
): MergeResult<Record<string, unknown>> {
  const res = replay(
    withoutVersion(base),
    withoutVersion(ours),
    withoutVersion(theirs),
    WORKFLOW_DEPTH,
  );
  if (!res.ok) return res;
  if (!isObject(res.merged)) return { ok: false, conflicts: [pathName([])] };
  return { ok: true, merged: res.merged, applied: res.applied };
}

/**
 * Rebase a repo-checks proposal. null = no override (the workflow's checks). With an override on
 * every side, `setup` and the `checks` list merge as two separate values; the list is compared
 * whole, so two edits to different checks still conflict (follow-up: merge check by check).
 * Adding or clearing the override merges only when the other side left it as it was.
 */
export function mergeRepoChecks(
  base: RepoChecks | null,
  ours: RepoChecks | null,
  theirs: RepoChecks | null,
): MergeResult<RepoChecks | null> {
  if (same(ours, theirs)) return { ok: true, merged: theirs, applied: 0 };
  if (same(base, theirs)) return { ok: true, merged: ours, applied: 1 };
  if (base === null || ours === null || theirs === null) {
    return { ok: false, conflicts: ['override'] };
  }
  // Depth 1: `setup` and `checks` are the leaves.
  const res = replay(base, ours, theirs, 1);
  if (!res.ok) return res;
  return { ok: true, merged: res.merged as RepoChecks, applied: res.applied };
}
