import type { RepoChecks } from '../workflow/repo-checks.js';

// ADR-0033 P3 (MA-T05): the structural diff a change proposal shows: what a workflow or a repo's
// checks would look like after the change, path by path. Pure, deterministic (sorted by path) and
// capped, so it fits an MCP result and a board row.

export interface StructuralChange {
  op: 'add' | 'remove' | 'change';
  /** Dotted path, e.g. `states.implementing.on.done.requires`, `checks.test.cmd`. */
  path: string;
  /** Absent for `add`. Long values are clipped (DIFF_VALUE_CLIP). */
  before?: unknown;
  /** Absent for `remove`. */
  after?: unknown;
}

/** A value's JSON is clipped to this many characters in a diff. */
export const DIFF_VALUE_CLIP = 200;
/** Changes shown by default (`capDiff`). */
export const DIFF_MAX = 40;
/**
 * `diffWorkflow` recurses this deep (`states.<s>.on.<t>.<field>`); below it, a value is compared
 * as a whole.
 */
const WORKFLOW_DEPTH = 5;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A stable JSON form: object keys sorted, so key order never shows up as a change. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** `v` as shown in a diff: itself when short, else its JSON clipped with an ellipsis. */
export function clipValue(v: unknown, max = DIFF_VALUE_CLIP): unknown {
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max - 1)}…` : v;
  if (v === null || typeof v !== 'object') return v;
  const json = stableJson(v);
  return json.length > max ? `${json.slice(0, max - 1)}…` : v;
}

function walk(
  before: unknown,
  after: unknown,
  path: string,
  depth: number,
  out: StructuralChange[],
): void {
  if (before === undefined && after === undefined) return;
  if (before === undefined) {
    out.push({ op: 'add', path, after: clipValue(after) });
    return;
  }
  if (after === undefined) {
    out.push({ op: 'remove', path, before: clipValue(before) });
    return;
  }
  if (depth > 0 && isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys)
      walk(before[k], after[k], path === '' ? k : `${path}.${k}`, depth - 1, out);
    return;
  }
  if (stableJson(before) !== stableJson(after)) {
    out.push({ op: 'change', path, before: clipValue(before), after: clipValue(after) });
  }
}

const byPath = (a: StructuralChange, b: StructuralChange) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * What changes from one workflow definition to another: top-level fields, states added and
 * removed, and inside each state its fields and each transition (`on.<name>`) field by field.
 * `version` is ignored (the server assigns it). A changed prompt shows as one `change` with both
 * texts clipped, not as a text diff.
 */
export function diffWorkflow(before: unknown, after: unknown): StructuralChange[] {
  const strip = (d: unknown) => {
    if (!isObject(d)) return d;
    const rest = { ...d };
    delete rest.version;
    return rest;
  };
  const out: StructuralChange[] = [];
  walk(strip(before), strip(after), '', WORKFLOW_DEPTH, out);
  return out.sort(byPath);
}

/**
 * What changes in a repo's checks: `setup` and each check, matched by name (`cmd`, `timeout`,
 * and `position` when it moved). null = no override of its own (the workflow's checks).
 */
export function diffRepoChecks(
  before: RepoChecks | null,
  after: RepoChecks | null,
): StructuralChange[] {
  const out: StructuralChange[] = [];
  if (before === null && after === null) return out;
  if (before === null || after === null) {
    out.push(
      before === null
        ? { op: 'add', path: 'override', after: clipValue(after) }
        : { op: 'remove', path: 'override', before: clipValue(before) },
    );
  }
  walk(before?.setup, after?.setup, 'setup', 0, out);
  const named = (c: RepoChecks | null) =>
    new Map((c?.checks ?? []).map((check, i) => [check.name.trim(), { check, position: i + 1 }]));
  const b = named(before);
  const a = named(after);
  for (const name of new Set([...b.keys(), ...a.keys()])) {
    const x = b.get(name);
    const y = a.get(name);
    const path = `checks.${name}`;
    if (x === undefined || y === undefined) {
      walk(x?.check, y?.check, path, 0, out);
      continue;
    }
    walk(x.check.cmd, y.check.cmd, `${path}.cmd`, 0, out);
    walk(x.check.timeout, y.check.timeout, `${path}.timeout`, 0, out);
    // Moving is only worth a line when the check is in both lists.
    if (x.position !== y.position) walk(x.position, y.position, `${path}.position`, 0, out);
  }
  return out.sort(byPath);
}

/** The first `max` changes and how many were left out. */
export function capDiff(
  changes: readonly StructuralChange[],
  max = DIFF_MAX,
): { changes: StructuralChange[]; more_changes: number } {
  return { changes: changes.slice(0, max), more_changes: Math.max(0, changes.length - max) };
}
