import { readFileSync } from 'node:fs';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from '../workflow/schema.js';
import { apply } from './apply.js';
import {
  ApplyResultSchema,
  type ApplyResult,
  type EngineEvent,
  type SessionSnapshot,
} from './types.js';

// Test-only helpers for apply*.test.ts: reference workflows, a fresh claimed session, and a tiny
// stand-in for the EngineService wrapper (assigns start_session command ids, bumps the fencing
// token on a non-ignored start refusal), per 10-contracts §EngineService wrapper.

export function referenceWorkflow(
  name: 'm1_basic' | 'm1_reviewed' | 'pr_flow',
): WorkflowDefinition {
  const url = new URL(`../../../../docs/design/workflows/${name}.v1.json`, import.meta.url);
  return WorkflowDefinitionSchema.parse(JSON.parse(readFileSync(url, 'utf8')));
}

/** The worktree HEAD a fake daemon reports with a command exit (ADR-0010). */
export const HEAD_SHA = '3b18e512dba79e4c8300dd08aeb37f8e728b8dad';

export const T0 = new Date('2026-10-22T12:00:00.000Z');

/** A session as the claim INSERTs it: queued, no state, no machine. */
export function freshSnapshot(def: WorkflowDefinition): SessionSnapshot {
  return {
    id: '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f',
    ticket: {
      id: '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2',
      title: 'Add /health',
      body: 'Return 200 from GET /health.',
      repo: 'github.com/benjgrad/fixture-app',
      external_ref: null,
    },
    machine_id: null,
    workflow_id: def.id,
    workflow_version: def.version,
    workflow_state: null,
    status: 'queued',
    fencing_token: 1,
    claude_session_id: null,
    agent_command_id: null,
    agent_process_live: false,
    pending_answer: null,
    retry_counters: {},
    state_visits: {},
    state_entered_at: T0.toISOString(),
    state_deadline: null,
    return_to: null,
    spend_usd: 0,
    claude_spend_totals: {},
    wall_seconds: 0,
    context: {},
    step: null,
  };
}

/** Deterministic v4-shaped uuids. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** Drives apply like the EngineService wrapper would, with a manual clock. */
export class Harness {
  snap: SessionSnapshot;
  now: Date;
  last!: ApplyResult;
  private nextId = 1;
  /** command ids of every start_session issued, oldest first. */
  readonly starts: string[] = [];

  constructor(
    readonly def: WorkflowDefinition,
    snap?: SessionSnapshot,
    now: Date = T0,
  ) {
    this.snap = snap ?? freshSnapshot(def);
    this.now = now;
  }

  advance(seconds: number): this {
    this.now = new Date(this.now.getTime() + seconds * 1000);
    return this;
  }

  get agentCmd(): string {
    if (this.snap.agent_command_id === null) throw new Error('no agent_command_id');
    return this.snap.agent_command_id;
  }

  newId(): string {
    return uuid(this.nextId++);
  }

  run(event: EngineEvent): ApplyResult {
    const before = this.snap;
    const result = ApplyResultSchema.parse(apply(this.def, before, event, this.now));
    let snap = result.snapshot;
    for (const e of result.effects) {
      if (e.type === 'start_session') {
        const id = this.newId();
        this.starts.push(id);
        snap = { ...snap, agent_command_id: id, agent_process_live: false };
      }
    }
    if (
      event.type === 'command.refused' &&
      event.command_kind === 'start_session' &&
      result.ignored === null
    ) {
      snap = { ...snap, fencing_token: snap.fencing_token + 1 };
    }
    this.snap = snap;
    this.last = result;
    return result;
  }

  /** Claim + matching `started` → running in the start state. */
  claimAndStart(machine = 'mbp-ben'): this {
    this.run({ type: 'session.assigned', machine_id: machine });
    if (this.snap.agent_command_id !== null) this.started();
    return this;
  }

  started(commandId = this.agentCmd): ApplyResult {
    return this.run({
      type: 'session.started',
      command_id: commandId,
      worktree_path: '/tmp/wt',
      branch: 'conductor/x/y',
      port_range: { base: 41000, count: 10 },
    });
  }

  complete(result: Record<string, string> = {}): ApplyResult {
    return this.run({ type: 'agent.complete_state', result });
  }

  cmdExit(
    exit_code: number | null,
    output_tail = '',
    timed_out = false,
    head_sha: string | null = HEAD_SHA,
  ): ApplyResult {
    return this.run({
      type: 'command.exited',
      command_id: this.newId(),
      exit_code,
      timed_out,
      output_tail,
      head_sha,
    });
  }
}
