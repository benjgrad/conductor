/**
 * UXR-52: what a disabled main button is waiting for, worded like Create ticket's hint. `items` are
 * `[missing, label]` pairs, in form order; null when nothing is missing.
 */
export function stillNeeded(
  items: readonly (readonly [missing: boolean, label: string])[],
): string | null {
  const labels = items.filter(([missing]) => missing).map(([, label]) => label);
  return labels.length === 0 ? null : `Still needed: ${labels.join(', ')}`;
}
