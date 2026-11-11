import type { JsonObject } from '../domain.js';
import { EngineEventSchema, type EngineEvent } from './types.js';

// The engine event row (02-data-model §event): how the EngineService wrapper records an applied
// (or ignored) engine event, and the way back for a replay (simulate_workflow, R17).

/** Every engine event type: the `event.type` values a replay feeds back to apply. */
export const ENGINE_EVENT_TYPES: ReadonlySet<string> = new Set(
  EngineEventSchema.options.map((o) => o.shape.type.value),
);

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * The engine event row's payload: the event minus `type` (+ the ignore reason, if any).
 * Raw command output never goes in an event row (02-data-model §event, ADR-0003):
 * `command.exited.output_tail` is replaced by its UTF-8 byte length, `output_tail_bytes`, and
 * `agent.exited.stderr_tail` by `stderr_tail_bytes` (stderr may carry secrets; only apply's
 * clipped last line reaches the failure question).
 */
export function eventPayload(event: EngineEvent, ignored: string | null): JsonObject {
  const payload = JSON.parse(JSON.stringify(event)) as JsonObject;
  delete payload.type;
  if (event.type === 'command.exited') {
    delete payload.output_tail;
    payload.output_tail_bytes = utf8Bytes(event.output_tail);
  }
  if (event.type === 'agent.exited' && event.stderr_tail !== undefined) {
    delete payload.stderr_tail;
    payload.stderr_tail_bytes = utf8Bytes(event.stderr_tail);
  }
  if (ignored !== null) payload.ignored = ignored;
  return payload;
}

export type RecordedEngineEvent =
  { event: EngineEvent; ignored: string | null } | { error: string };

/**
 * The engine event an `event` row recorded (eventPayload reversed), or null for a row that is
 * not an engine event (`state.entered`, `operator.reopen`, audit rows). The output and stderr
 * tails are not kept: `output_tail` comes back `''` and `stderr_tail` absent.
 */
export function engineEventFromRow(type: string, payload: unknown): RecordedEngineEvent | null {
  if (!ENGINE_EVENT_TYPES.has(type)) return null;
  const p: Record<string, unknown> =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>) }
      : {};
  const ignored = typeof p.ignored === 'string' ? p.ignored : null;
  delete p.ignored;
  if (type === 'command.exited' && 'output_tail_bytes' in p) {
    delete p.output_tail_bytes;
    if (!('output_tail' in p)) p.output_tail = '';
  }
  if (type === 'agent.exited') delete p.stderr_tail_bytes;
  const parsed = EngineEventSchema.safeParse({ ...p, type });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: `${type}: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid'}`,
    };
  }
  return { event: parsed.data, ignored };
}
