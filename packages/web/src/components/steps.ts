// UXR-88: the Details tab's Steps. One row per state the ticket passed through, from
// `SessionDetail.moves` (when) and `SessionDetail.context` (each state's recorded result, the same
// data MCP `get_ticket_artifacts what=results` reads), so no extra route is needed.
import type { JsonObject, SessionDetail } from '@conductor/shared';
import { phaseStateName } from './OutputLog.js';
import { moveTitle } from './transitions.js';

export interface StepRow {
  key: string;
  state: string;
  title: string;
  enteredAt: string;
  /** null: the session is still in this state. */
  leftAt: string | null;
  /** null while the step is current and the session isn't running (no meaningful clock). */
  durationMs: number | null;
  /** The title of the transition that left the state; null while current or without one. */
  outcome: string | null;
  /** `context[state]`, on the state's last visit only (context keeps the latest result). */
  result: JsonObject | null;
  /** 1 for the first time in the state, 2 for the next… */
  visit: number;
  /** The state was visited again later, so this visit's result was replaced. */
  replaced: boolean;
  /** A terminal state: the ticket ended here (never "In progress"). */
  terminal: boolean;
}

export function steps(detail: SessionDetail, now: number = Date.now()): StepRow[] {
  const moves = detail.moves ?? [];
  const { workflow, context } = detail;
  const visits = new Map<string, number>();
  const rows: StepRow[] = moves.map((m, i) => {
    const next = moves[i + 1];
    const visit = (visits.get(m.to) ?? 0) + 1;
    visits.set(m.to, visit);
    const current = next === undefined;
    const entered = Date.parse(m.at);
    const durationMs = current
      ? detail.card.status === 'running'
        ? Math.max(0, now - entered)
        : null
      : Math.max(0, Date.parse(next.at) - entered);
    return {
      key: `${m.at}-${i}`,
      state: m.to,
      title: phaseStateName(m.to, workflow),
      enteredAt: m.at,
      leftAt: current ? null : next.at,
      durationMs,
      outcome: current ? null : moveTitle(workflow, next),
      result: null,
      visit,
      replaced: false,
      terminal: workflow.states[m.to]?.type === 'terminal',
    };
  });
  for (const row of rows) {
    const last = visits.get(row.state) === row.visit;
    const value = context[row.state];
    if (row.state.startsWith('__') || value === undefined) continue;
    if (last) row.result = value;
    else row.replaced = true;
  }
  return rows;
}

/** "1h 4m", "3m 20s", "12s". */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 || m >= 10 ? `${m}m` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

const json = (v: unknown) => '```json\n' + JSON.stringify(v, null, 2) + '\n```';
/** A string as is, a list of strings as a bullet list, anything else as a JSON block. */
const value = (v: unknown) =>
  typeof v === 'string'
    ? v
    : Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')
      ? v.map((x) => `- ${x}`).join('\n')
      : json(v);
const humanKey = (k: string) => {
  const words = k.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A step's result as markdown: the summary, the plan, then every other field by name. */
export function resultMarkdown(result: JsonObject): string {
  const parts: string[] = [];
  const { summary, plan, ...rest } = result;
  if (summary !== undefined) parts.push(typeof summary === 'string' ? summary : json(summary));
  if (plan !== undefined) {
    parts.push(`**Plan**\n\n${typeof plan === 'string' ? plan : json(plan)}`);
  }
  for (const [k, v] of Object.entries(rest)) {
    if (k === 'proposed_tickets' && Array.isArray(v)) {
      const lines = v.map((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        const title = typeof o.title === 'string' ? o.title : JSON.stringify(t);
        return typeof o.repo === 'string' ? `- ${title} (${o.repo})` : `- ${title}`;
      });
      parts.push(`**Proposed tickets**\n\n${lines.join('\n')}`);
      continue;
    }
    parts.push(`**${humanKey(k)}**\n\n${value(v)}`);
  }
  return parts.join('\n\n');
}
