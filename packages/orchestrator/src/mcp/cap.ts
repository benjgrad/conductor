// ADR-0028 (ADR-0014 §2, simplified): every MCP tool result is at most TOOL_RESULT_MAX_BYTES of
// JSON, so a model's context isn't flooded. Pure.

export const TOOL_RESULT_MAX_BYTES = 8192;
export const TRUNCATED = '…[truncated]';

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

type Slot<T> = { value: T; set: (v: T) => void };

/** Every string and array inside `root`, with a setter to replace it in place. */
function collect(root: { v: unknown }): { strings: Slot<string>[]; arrays: unknown[][] } {
  const strings: Slot<string>[] = [];
  const arrays: unknown[][] = [];
  const walk = (value: unknown, set: (v: unknown) => void): void => {
    if (typeof value === 'string') strings.push({ value, set: (v) => set(v) });
    else if (Array.isArray(value)) {
      arrays.push(value);
      value.forEach((item, i) => walk(item, (v) => (value[i] = v)));
    } else if (value !== null && typeof value === 'object') {
      const o = value as Record<string, unknown>;
      for (const k of Object.keys(o)) walk(o[k], (v) => (o[k] = v));
    }
  };
  walk(root.v, (v) => (root.v = v));
  return { strings, arrays };
}

/**
 * `value` (deep-copied) cut to at most `max` bytes of JSON: first the longest strings are halved
 * (marked TRUNCATED), then trailing items of the longest arrays are dropped.
 */
export function capJson<T>(
  value: T,
  max = TOOL_RESULT_MAX_BYTES,
): { value: T; truncated: boolean } {
  if (bytes(value) <= max) return { value, truncated: false };
  const root = { v: structuredClone(value) as unknown };
  for (let i = 0; i < 500 && bytes(root.v) > max; i++) {
    const { strings } = collect(root);
    const longest = strings.reduce<Slot<string> | null>(
      (a, s) => (a === null || s.value.length > a.value.length ? s : a),
      null,
    );
    if (longest === null || longest.value.length <= 64) break;
    const keep = longest.value.endsWith(TRUNCATED)
      ? longest.value.slice(0, -TRUNCATED.length)
      : longest.value;
    longest.set(keep.slice(0, Math.floor(keep.length / 2)) + TRUNCATED);
  }
  for (let i = 0; i < 10_000 && bytes(root.v) > max; i++) {
    const { arrays } = collect(root);
    const longest = arrays.reduce<unknown[] | null>(
      (a, arr) => (a === null || arr.length > a.length ? arr : a),
      null,
    );
    if (longest === null || longest.length === 0) break;
    longest.pop();
  }
  return { value: root.v as T, truncated: true };
}
