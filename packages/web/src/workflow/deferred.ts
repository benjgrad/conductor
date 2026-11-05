// UXR-71: a newly added item (a check, review item or condition) is not validated until it loses
// focus, or until Save. The view keeps the path prefix of each such item (absolute, like the
// server's `details[].path`: `states.planning.on.plan_ready.requires.checks.0`) and hides the
// problems under it. Also the old-version warning (UXR-70).

/** Whether a problem at `path` belongs to a still-new item. */
export function isDeferred(path: string, deferred: ReadonlySet<string>): boolean {
  for (const p of deferred) {
    if (path === p || path.startsWith(`${p}.`)) return true;
  }
  return false;
}

/** The problems to show now: those not under a still-new item. */
export function visibleIssues<T extends { path: string }>(
  issues: readonly T[],
  deferred: ReadonlySet<string>,
): T[] {
  if (deferred.size === 0) return [...issues];
  return issues.filter((i) => !isDeferred(i.path, deferred));
}

export function withDeferred(deferred: ReadonlySet<string>, prefix: string): ReadonlySet<string> {
  if (deferred.has(prefix)) return deferred;
  return new Set([...deferred, prefix]);
}

export function withoutDeferred(
  deferred: ReadonlySet<string>,
  prefix: string,
): ReadonlySet<string> {
  if (!deferred.has(prefix)) return deferred;
  const next = new Set(deferred);
  next.delete(prefix);
  return next;
}

/**
 * Drop every entry under the list at `listPrefix` (an item was moved or removed, so the indexes
 * shifted: showing their problems is the safe direction).
 */
export function withoutUnder(
  deferred: ReadonlySet<string>,
  listPrefix: string,
): ReadonlySet<string> {
  const next = [...deferred].filter((p) => !p.startsWith(`${listPrefix}.`) && p !== listPrefix);
  return next.length === deferred.size ? deferred : new Set(next);
}

/**
 * UXR-70: editing a version older than the latest saves a new version made from it, which undoes
 * the versions after it. null when `current` is the latest.
 */
export function oldVersionWarning(
  current: number,
  latest: number,
  versions: readonly number[],
): string | null {
  if (current >= latest) return null;
  const first = versions.filter((v) => v > current && v <= latest).sort((a, b) => a - b)[0];
  const from = first ?? current + 1;
  const range = from >= latest ? `v${latest}` : `v${from}–v${latest}`;
  return `This starts from v${current}: saving undoes the changes in ${range}.`;
}
