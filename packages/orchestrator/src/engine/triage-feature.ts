import { DAEMON_FEATURE_TRIAGE, type JsonObject } from '@conductor/shared';
import type { Queryable } from '../contracts.js';

// ADR-0041: a triage session runs with the `triage` tool alias (read-only git and `gh`). A daemon
// older than the alias would refuse the start as an unknown alias, so a machine that doesn't
// advertise DAEMON_FEATURE_TRIAGE gets `review` instead (read-only git, no `gh`). Both are
// edit-free, so this only narrows what the triage can read. TD row: "triage degrades to review".

/** The tools to send: `triage` → `review` unless the machine's daemon knows `triage`. */
export function triageTools(tools: readonly string[], features: readonly string[]): string[] {
  if (!tools.includes('triage') || features.includes(DAEMON_FEATURE_TRIAGE)) return [...tools];
  return [...new Set(tools.map((t) => (t === 'triage' ? 'review' : t)))];
}

/**
 * The `start_session` payload for `target` (`machine:<id>`): unchanged unless its `tools` has
 * `triage` and the machine doesn't advertise DAEMON_FEATURE_TRIAGE.
 */
export async function withTriageFeature(
  q: Queryable,
  payload: JsonObject,
  target: string,
): Promise<JsonObject> {
  const tools = payload.tools;
  if (!Array.isArray(tools) || !tools.includes('triage')) return payload;
  const machineId = target.startsWith('machine:') ? target.slice('machine:'.length) : null;
  const features =
    machineId === null
      ? []
      : ((
          await q.query<{ features: string[] }>('SELECT features FROM machine WHERE id = $1', [
            machineId,
          ])
        ).rows[0]?.features ?? []);
  if (features.includes(DAEMON_FEATURE_TRIAGE)) return payload;
  return { ...payload, tools: triageTools(tools as string[], features) };
}
