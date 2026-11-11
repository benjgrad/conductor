import { z } from 'zod';
import type { JsonObject, SessionStatus } from '../domain.js';
import type { RepoChecks } from '../workflow/repo-checks.js';
import type { WorkflowDefinition } from '../workflow/schema.js';
import { apply } from './apply.js';
import { engineEventFromRow } from './recorded.js';
import { CHECK_CONFIG_KEY } from './setup-failure.js';
import type { EngineEvent, SessionSnapshot } from './types.js';
import { withoutWatch } from './watch.js';

// simulate_workflow (R17, 05 §Simulating a draft): replay a ticket's recorded engine events
// through apply() with a draft definition and find the first move that differs from what
// happened. Pure: apply never reads a clock (each row's `ts` is `now`) and never assigns ids (the
// replay stands in for the EngineService wrapper with deterministic ones).

/** One `event` row of a session, in id order. */
export interface RecordedRow {
  id: number;
  type: string;
  payload: unknown;
  /** ISO timestamp (`event.ts`). */
  ts: string;
}

/** One session of the ticket, oldest first, with its rows in id order. */
export interface RecordedSession {
  id: string;
  branch: string | null;
  /** The session's status now (the recorded end). */
  status: SessionStatus;
  rows: RecordedRow[];
}

export interface SimulateInput {
  def: WorkflowDefinition;
  ticket: SessionSnapshot['ticket'];
  sessions: RecordedSession[];
  /** The repo's check override (the current one: the replay does not know older ones). */
  repoChecks?: RepoChecks | null;
}

/** A move: `state.entered` (recorded) or a `state_entered` effect (simulated). */
export interface SimulatedMove {
  from: string | null;
  to: string;
  transition: string | null;
}

export interface SimulationDivergence {
  session_id: string;
  /** The engine event row after which the routes differ. */
  event_id: number;
  event_type: string;
  at: string;
  /** Index of the first differing move in the recorded route (whole ticket). */
  move_index: number;
  /** The move that happened (null: the draft moves where nothing moved). */
  recorded: SimulatedMove | null;
  /** The move the draft takes (null: the draft stays where the ticket moved). */
  simulated: SimulatedMove | null;
}

export interface TicketSimulation {
  diverged: boolean;
  /** false: a row could not be read back as an engine event, or apply threw. */
  replayable: boolean;
  error?: { event_id: number; message: string };
  first_divergence: SimulationDivergence | null;
  /** Every state the ticket entered (its whole recorded route). */
  recorded_states: string[];
  /** The states the draft entered, up to where the replay stopped. */
  simulated_states: string[];
  /** A state list was clipped to STATES_MAX. */
  states_truncated?: true;
  final: {
    recorded: { state: string | null; status: SessionStatus } | null;
    simulated: { state: string | null; status: SessionStatus };
  };
  events_replayed: number;
  /** Events apply accepted in one run and ignored in the other (informational, not a divergence). */
  events_ignored_differently: number;
}

/** The longest state list a result carries. */
export const SIMULATION_STATES_MAX = 100;

const StateEnteredRowSchema = z.object({
  from: z.string().nullable(),
  to: z.string(),
  transition: z.string().nullable().optional(),
});

/** The replay's command ids (apply only compares them to `agent_command_id`). */
function simCommandId(n: number): string {
  return `00000000-0000-4000-a000-${n.toString(16).padStart(12, '0')}`;
}

function initialSnapshot(
  input: SimulateInput,
  session: RecordedSession,
  at: string,
): SessionSnapshot {
  return {
    id: session.id,
    ticket: input.ticket,
    machine_id: null,
    workflow_id: input.def.id,
    workflow_version: input.def.version,
    workflow_state: null,
    status: 'queued',
    fencing_token: 1,
    claude_session_id: null,
    agent_command_id: null,
    agent_process_live: false,
    pending_answer: null,
    retry_counters: {},
    state_visits: {},
    state_entered_at: at,
    state_deadline: null,
    return_to: null,
    spend_usd: 0,
    claude_spend_totals: {},
    wall_seconds: 0,
    context: {},
    step: null,
    repo_checks: input.repoChecks ?? null,
    repo_checks_meta: null,
    branch: session.branch,
  };
}

/** A reopened session (engine/reopen.ts): what it carries from the one before. */
function reopenedSnapshot(
  fresh: SessionSnapshot,
  prev: SessionSnapshot,
  text: string,
): SessionSnapshot {
  const context = { ...withoutWatch(prev.context) };
  delete context[CHECK_CONFIG_KEY];
  return {
    ...fresh,
    branch: fresh.branch ?? prev.branch ?? null,
    claude_session_id: prev.claude_session_id,
    claude_spend_totals: prev.claude_spend_totals,
    notified_transitions: prev.notified_transitions ?? [],
    context,
    pending_answer: { input_request_id: null, answer: text },
  };
}

/**
 * The recorded event, re-aimed at the replay's own wrapper- and clock-owned values: the
 * start_session command id and the state / watch deadlines. Only for an event the original run
 * accepted (an ignored one is replayed as recorded, so it is ignored again).
 */
function reaim(event: EngineEvent, snap: SessionSnapshot): EngineEvent {
  switch (event.type) {
    case 'session.started':
    case 'agent.exited':
      return snap.agent_command_id === null
        ? event
        : { ...event, command_id: snap.agent_command_id };
    case 'command.refused':
      return event.command_kind === 'start_session' && snap.agent_command_id !== null
        ? { ...event, command_id: snap.agent_command_id }
        : event;
    case 'timer.fired':
    case 'concurrency.checked':
      return snap.workflow_state === null || snap.state_deadline === null
        ? event
        : { ...event, state: snap.workflow_state, deadline: snap.state_deadline };
    case 'watch.fired':
      return snap.workflow_state === null || (snap.watch_deadline ?? null) === null
        ? event
        : { ...event, state: snap.workflow_state, deadline: snap.watch_deadline! };
    default:
      return event;
  }
}

function sameMove(a: SimulatedMove, b: SimulatedMove): boolean {
  return a.from === b.from && a.to === b.to && a.transition === b.transition;
}

function recordedMove(payload: unknown): SimulatedMove | null {
  const p = StateEnteredRowSchema.safeParse(payload);
  if (!p.success) return null;
  return { from: p.data.from, to: p.data.to, transition: p.data.transition ?? null };
}

interface Pending {
  row: RecordedRow;
  simulated: SimulatedMove[];
  recorded: SimulatedMove[];
}

function firstDifference(
  sessionId: string,
  p: Pending,
  moveIndex: number,
): SimulationDivergence | null {
  const n = Math.max(p.simulated.length, p.recorded.length);
  for (let i = 0; i < n; i++) {
    const r = p.recorded[i] ?? null;
    const s = p.simulated[i] ?? null;
    if (r !== null && s !== null && sameMove(r, s)) continue;
    return {
      session_id: sessionId,
      event_id: p.row.id,
      event_type: p.row.type,
      at: p.row.ts,
      move_index: moveIndex + i,
      recorded: r,
      simulated: s,
    };
  }
  return null;
}

function clip(list: string[]): { list: string[]; clipped: boolean } {
  return list.length > SIMULATION_STATES_MAX
    ? { list: list.slice(0, SIMULATION_STATES_MAX), clipped: true }
    : { list, clipped: false };
}

/** Replay one ticket's recorded sessions through `input.def`. */
export function simulateTicket(input: SimulateInput): TicketSimulation {
  const recordedStates: string[] = [];
  for (const s of input.sessions) {
    for (const r of s.rows) {
      if (r.type !== 'state.entered') continue;
      const m = recordedMove(r.payload);
      if (m !== null) recordedStates.push(m.to);
    }
  }
  const simulatedStates: string[] = [];
  let replayable = true;
  let error: TicketSimulation['error'];
  let divergence = null as SimulationDivergence | null;
  let eventsReplayed = 0;
  let ignoredDifferently = 0;
  let moveIndex = 0;
  let nextCommand = 1;
  let snap = null as SessionSnapshot | null;

  sessions: for (const session of input.sessions) {
    const firstTs = session.rows[0]?.ts ?? new Date(0).toISOString();
    const fresh = initialSnapshot(input, session, firstTs);
    const first = session.rows[0];
    const reopenText =
      first?.type === 'operator.reopen' &&
      first.payload !== null &&
      typeof first.payload === 'object' &&
      typeof (first.payload as JsonObject).text === 'string'
        ? ((first.payload as JsonObject).text as string)
        : null;
    snap = reopenText !== null && snap !== null ? reopenedSnapshot(fresh, snap, reopenText) : fresh;

    // The engine event being compared: its simulated moves and the recorded ones after it.
    let current = null as Pending | null;
    /** Compare `current`; false (and `divergence` set) when the routes differ. */
    const settle = (): boolean => {
      if (current === null) return true;
      const d = firstDifference(session.id, current, moveIndex);
      if (d !== null) {
        divergence = d;
        return false;
      }
      moveIndex += current.recorded.length;
      for (const m of current.simulated) simulatedStates.push(m.to);
      current = null;
      return true;
    };

    for (const row of session.rows) {
      if (row.type === 'state.entered') {
        const m = recordedMove(row.payload);
        if (m === null) continue;
        if (current === null) {
          // A move with no engine event before it in this session: nothing the replay can match.
          current = { row, simulated: [], recorded: [] };
        }
        current.recorded.push(m);
        continue;
      }
      const decoded = engineEventFromRow(row.type, row.payload);
      if (decoded === null) continue;
      if (!settle()) break sessions;
      if ('error' in decoded) {
        replayable = false;
        error = { event_id: row.id, message: decoded.error };
        break sessions;
      }
      const event = decoded.ignored === null ? reaim(decoded.event, snap) : decoded.event;
      let res;
      try {
        res = apply(input.def, snap, event, new Date(row.ts));
      } catch (e) {
        replayable = false;
        error = { event_id: row.id, message: e instanceof Error ? e.message : String(e) };
        break sessions;
      }
      eventsReplayed++;
      if ((res.ignored !== null) !== (decoded.ignored !== null)) ignoredDifferently++;
      let next = res.snapshot;
      const simulated: SimulatedMove[] = [];
      for (const effect of res.effects) {
        if (effect.type === 'start_session') {
          next = {
            ...next,
            agent_command_id: simCommandId(nextCommand++),
            agent_process_live: false,
          };
        } else if (effect.type === 'state_entered') {
          simulated.push({
            from: effect.from,
            to: effect.to,
            transition: effect.transition ?? null,
          });
        }
      }
      snap = next;
      current = { row, simulated, recorded: [] };
    }
    if (!settle()) break;
  }

  const recordedClip = clip(recordedStates);
  const simulatedClip = clip(simulatedStates);
  const lastSession = input.sessions[input.sessions.length - 1];
  const finalSnap = snap ?? {
    workflow_state: null,
    status: 'queued' as const,
  };
  return {
    diverged: divergence !== null,
    replayable,
    ...(error !== undefined ? { error } : {}),
    first_divergence: divergence,
    recorded_states: recordedClip.list,
    simulated_states: simulatedClip.list,
    ...(recordedClip.clipped || simulatedClip.clipped ? { states_truncated: true as const } : {}),
    final: {
      recorded:
        lastSession === undefined
          ? null
          : {
              state: recordedStates[recordedStates.length - 1] ?? null,
              status: lastSession.status,
            },
      simulated: { state: finalSnap.workflow_state, status: finalSnap.status },
    },
    events_replayed: eventsReplayed,
    events_ignored_differently: ignoredDifferently,
  };
}
