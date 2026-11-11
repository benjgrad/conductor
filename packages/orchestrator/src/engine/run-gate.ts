import { DAEMON_FEATURE_RUN_GATE, RUN_GATE_INSTRUCTION, type JsonObject } from '@conductor/shared';
import type { Queryable } from '../contracts.js';

// R4: `run_gate` is a tool of the daemon's outcome server. The implement prompt tells the agent to
// use it (RUN_GATE_INSTRUCTION); a machine whose daemon predates it gets a note saying it isn't
// there, the same way a daemon without `publish_page` does (pages.ts).

/** For a machine without DAEMON_FEATURE_RUN_GATE: the paragraph appended to the prompt. */
export const RUN_GATE_FALLBACK_NOTE =
  "\n\nThis machine's conductor daemon has no `run_gate` tool, so ignore the line about it: " +
  "run the repo's build and tests yourself before you take a transition that runs checks.";

/**
 * The `start_session` payload for `target` (`machine:<id>`): unchanged unless its prompt asks for
 * `run_gate` and the machine doesn't advertise DAEMON_FEATURE_RUN_GATE. Then the prompt says so.
 */
export async function withRunGateFeature(
  q: Queryable,
  payload: JsonObject,
  target: string,
): Promise<JsonObject> {
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  if (!prompt.includes(RUN_GATE_INSTRUCTION)) return payload;
  const machineId = target.startsWith('machine:') ? target.slice('machine:'.length) : null;
  const m =
    machineId === null
      ? undefined
      : (
          await q.query<{ features: string[] }>('SELECT features FROM machine WHERE id = $1', [
            machineId,
          ])
        ).rows[0];
  if (m?.features.includes(DAEMON_FEATURE_RUN_GATE) === true) return payload;
  return { ...payload, prompt: prompt + RUN_GATE_FALLBACK_NOTE };
}
