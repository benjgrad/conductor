import { readFileSync } from 'node:fs';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from '../workflow/schema.js';
import { apply } from './apply.js';
import { qaFenceChanged } from './qa.js';
import {
  ApplyResultSchema,
  type ApplyResult,
  type EngineEvent,
  type SessionSnapshot,
} from './types.js';

// Test-only helpers for apply*.test.ts: reference workflows, a fresh claimed session, and a tiny
// stand-in for the EngineService wrapper (assigns start_session command ids, bumps the fencing
// token on a non-ignored start refusal, a terminal session, and entering or leaving a QA state),
// per 10-contracts §EngineService wrapper.

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

const TERMINAL: ReadonlySet<string> = new Set(['done', 'failed', 'lost']);

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
      (event.type === 'command.refused' &&
        event.command_kind === 'start_session' &&
        result.ignored === null) ||
      // BUG-1: the wrapper also fences a session that becomes terminal.
      (!TERMINAL.has(before.status) && TERMINAL.has(snap.status)) ||
      // ADR-0020 §2 (M2r-T03): and one that enters or leaves a QA state.
      qaFenceChanged(this.def, before, snap)
    ) {
      snap = { ...snap, fencing_token: snap.fencing_token + 1 };
    }
    this.snap = snap;
    this.last = result;
    return result;
  }

  /**
   * An event sent under fencing token `token`: refused like the wrapper does (`stale_fencing_token`,
   * nothing applied) when it is below the session's current token.
   */
  runFenced(event: EngineEvent, token: number): ApplyResult | { ignored: 'stale_fencing_token' } {
    if (token < this.snap.fencing_token) return { ignored: 'stale_fencing_token' };
    return this.run(event);
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

// ---------------------------------------------------------------- the QA state (M2r-T03)

/** The PR conductor opened in the QA tests (`__pr.pr_url`). */
export const QA_PR_URL = 'https://github.com/benjgrad/fixture-app/pull/7';

/**
 * A minimal ADR-0020 §10 shape: Implementing → (checks, open_pr) → In QA (`role: qa`) → Ready to
 * merge; `qa_fail` sends the findings back (`attach: 'result'`, 3 rounds, then Needs input).
 * No `inspect_pr` / `merge_pr` (M2r-T04).
 */
export function qaDefinition(): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    id: 'qa_flow',
    version: 1,
    start: 'implementing',
    budget: { usd: 20, minutes: 600, max_loop_retries: 3 },
    on_budget_exceeded: 'needs_input',
    states: {
      implementing: {
        type: 'agent',
        title: 'Implementing',
        prompt: 'implement_template',
        tools: ['edit', 'bash'],
        timeout: '60m',
        on: {
          pr_ready: {
            goto: 'in_qa',
            title: 'PR ready for QA',
            when: 'The work is done and committed.',
            requires: {
              checks: [{ name: 'Tests pass', cmd: 'npm test', timeout: '10m' }],
              actions: ['open_pr'],
            },
            on_unmet: {
              goto: 'implementing',
              instruction: 'Fix it, commit, then finish again.',
              retries: 3,
              else: 'needs_input',
            },
          },
          ask_user: 'needs_input',
          timeout: 'needs_input',
        },
      },
      in_qa: {
        type: 'agent',
        role: 'qa',
        title: 'In QA',
        prompt: 'QA the pull request for {{ticket.title}}.',
        tools: ['qa'],
        model: 'opus',
        timeout: '40m',
        checkout: { setup: 'pnpm i --frozen-lockfile' },
        result: ['verdict', 'summary'],
        on: {
          qa_pass: {
            goto: 'ready_to_merge',
            title: 'QA passed',
            when: 'Every requirement is met.',
          },
          qa_fail: {
            goto: 'implementing',
            attach: 'result',
            retries: 3,
            else: 'needs_input',
            title: 'Changes required',
            when: 'At least one required fix.',
          },
          qa_needs_human: {
            goto: 'needs_input',
            question: true,
            title: 'QA needs a human',
            when: 'You need a human decision.',
          },
          ask_user: 'needs_input',
          timeout: 'needs_input',
        },
      },
      ready_to_merge: {
        type: 'human',
        title: 'Ready to merge',
        on: {
          merged: { goto: 'done', title: 'Merged', actor: 'human' },
          request_changes: {
            goto: 'implementing',
            title: 'Request changes',
            actor: 'human',
            text: 'required',
          },
        },
      },
      needs_input: {
        type: 'human',
        title: 'Needs input',
        on: {
          answer: { goto: '$return_to', title: 'Back with this answer', actor: 'human' },
          back_to_implementing: {
            goto: 'implementing',
            title: 'Back to Implementing',
            actor: 'human',
            text: 'required',
          },
          close: { goto: 'done', title: 'Close', actor: 'human' },
        },
      },
      done: { type: 'terminal' },
    },
  });
}
