import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sessionBranch,
  type ApplyFn,
  type ApplyResult,
  type Effect,
  type EngineEvent,
  type SessionSnapshot,
  type WorkflowDefinition,
} from '@conductor/shared';
import type pg from 'pg';
import type { SessionRow } from '../../src/db/types.js';

// Seed rows and a scripted apply() for the EngineService integration tests (M1-T04b).

const workflowsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/design/workflows',
);

export function loadWorkflow(file: string): unknown {
  return JSON.parse(readFileSync(resolve(workflowsDir, file), 'utf8'));
}

export const MACHINE = 'mbp-test';

export async function seedBase(pool: pg.Pool): Promise<void> {
  await pool.query(
    'INSERT INTO workflow_definition (id, version, definition) VALUES ($1, 1, $2) ' +
      'ON CONFLICT DO NOTHING',
    ['m1_basic', JSON.stringify(loadWorkflow('m1_basic.v1.json'))],
  );
  await pool.query(
    'INSERT INTO machine (id, hostname, os, arch, cpu_total, mem_total_mb, disk_free_mb, ' +
      'budget_cpu, budget_mem_mb, max_sessions, max_concurrent_builds) ' +
      "VALUES ($1, 'h', 'darwin', 'arm64', 8, 16000, 100000, 4, 8000, 2, 1) ON CONFLICT DO NOTHING",
    [MACHINE],
  );
}

export interface Seeded {
  ticketId: string;
  sessionId: string;
  branch: string;
}

/** A claimed ticket with a fresh queued session (what T11's claim leaves before session.assigned). */
export async function seedSession(
  pool: pg.Pool,
  overrides: Partial<Record<keyof SessionRow, unknown>> = {},
): Promise<Seeded> {
  await seedBase(pool);
  const ticketId = randomUUID();
  const sessionId = randomUUID();
  const branch = sessionBranch(ticketId, sessionId);
  await pool.query(
    'INSERT INTO ticket (id, repo, title, body, workflow_id, workflow_version, status) ' +
      "VALUES ($1, 'github.com/x/app', 'Add /health', 'Return 200', 'm1_basic', 1, 'claimed')",
    [ticketId],
  );
  const cols: Record<string, unknown> = {
    id: sessionId,
    ticket_id: ticketId,
    workflow_id: 'm1_basic',
    workflow_version: 1,
    status: 'queued',
    branch,
    ...overrides,
  };
  const keys = Object.keys(cols);
  await pool.query(
    `INSERT INTO session (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
    keys.map((k) => {
      const v = cols[k];
      return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
    }),
  );
  return { ticketId, sessionId, branch };
}

export type Script = (
  snap: SessionSnapshot,
  event: EngineEvent,
  now: Date,
  def: WorkflowDefinition,
) => { snapshot?: Partial<SessionSnapshot>; effects?: Effect[]; ignored?: ApplyResult['ignored'] };

/**
 * A stand-in for the real apply() (M1-T04a, in parallel): per-event-type scripts that patch the
 * snapshot and return effects. Unscripted events are ignored as `unexpected_event`.
 */
export class ScriptedApply {
  readonly calls: { snap: SessionSnapshot; event: EngineEvent }[] = [];
  private scripts = new Map<EngineEvent['type'], Script>();

  on(type: EngineEvent['type'], script: Script): this {
    this.scripts.set(type, script);
    return this;
  }

  readonly apply: ApplyFn = (def, snap, event, now) => {
    this.calls.push({ snap, event });
    const script = this.scripts.get(event.type);
    if (!script) return { snapshot: snap, effects: [], ignored: 'unexpected_event' };
    const out = script(snap, event, now, def);
    if (out.ignored) return { snapshot: snap, effects: [], ignored: out.ignored };
    return {
      snapshot: { ...snap, ...out.snapshot },
      effects: out.effects ?? [],
      ignored: null,
    };
  };
}

/** session.assigned → enter `implement`: assigned + start_session (what m1_basic does). */
export const assignScript: Script = (snap, event, now) => {
  if (event.type !== 'session.assigned') throw new Error('bad event');
  const deadline = new Date(now.getTime() + 30 * 60_000).toISOString();
  return {
    snapshot: {
      machine_id: event.machine_id,
      workflow_state: 'implement',
      status: 'assigned',
      state_visits: { implement: 1 },
      state_entered_at: now.toISOString(),
      state_deadline: deadline,
    },
    effects: [
      { type: 'state_entered', from: null, to: 'implement', visit: 1 },
      { type: 'set_deadline', state: 'implement', deadline },
      { type: 'session_status', from: snap.status, to: 'assigned' },
      { type: 'ticket_status', to: 'in_progress' },
      {
        type: 'start_session',
        state: 'implement',
        prompt: 'ticket_template',
        tools: ['edit', 'bash', 'git'],
        resume_claude_session_id: null,
      },
    ],
  };
};
