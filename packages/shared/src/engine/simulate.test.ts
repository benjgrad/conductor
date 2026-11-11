import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from '../workflow/schema.js';
import { freshSnapshot, Harness, referenceWorkflow, uuid } from './apply.testkit.js';
import { eventPayload } from './recorded.js';
import { simulateTicket, type RecordedRow, type RecordedSession } from './simulate.js';
import type { EngineEvent, SessionSnapshot } from './types.js';

const m1 = referenceWorkflow('m1_basic');
const SESSION_2 = '7d0c5b1e-3f4a-4b7e-9c2d-000000000002';

/**
 * Records a session the way the EngineService wrapper does (service.ts): the engine event row
 * (eventPayload), then one `state.entered` row per move. The Harness's command ids differ from
 * the replay's, so a clean replay proves the re-aiming.
 */
class Recorder {
  readonly rows: RecordedRow[] = [];
  readonly h: Harness;

  constructor(
    def: WorkflowDefinition,
    snap?: SessionSnapshot,
    private nextId = { n: 1 },
  ) {
    this.h = new Harness(def, snap);
  }

  private push(type: string, payload: unknown): void {
    this.rows.push({ id: this.nextId.n++, type, payload, ts: this.h.now.toISOString() });
  }

  note(type: string, payload: unknown): this {
    this.push(type, payload);
    return this;
  }

  run(event: EngineEvent, advanceSeconds = 60): this {
    this.h.advance(advanceSeconds);
    const res = this.h.run(event);
    this.push(event.type, eventPayload(event, res.ignored));
    for (const e of res.effects) {
      if (e.type === 'state_entered') {
        this.push('state.entered', {
          from: e.from,
          to: e.to,
          visit: e.visit,
          ...(e.transition !== undefined ? { transition: e.transition } : {}),
          cause: e.cause,
        });
      }
    }
    return this;
  }

  started(): this {
    return this.run({
      type: 'session.started',
      command_id: this.h.agentCmd,
      worktree_path: '/tmp/wt',
      branch: 'conductor/x/y',
      port_range: { base: 41000, count: 10 },
    });
  }

  cmdExit(exit_code: number, output_tail = ''): this {
    return this.run({
      type: 'command.exited',
      command_id: uuid(900 + this.rows.length),
      exit_code,
      timed_out: false,
      output_tail,
    });
  }

  session(id = '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f'): RecordedSession {
    return { id, branch: null, status: this.h.snap.status, rows: this.rows };
  }
}

/** m1_basic all the way: implement → build (fails once) → implement → build → test → done. */
function happyPath(): Recorder {
  return new Recorder(m1)
    .run({ type: 'session.assigned', machine_id: 'mbp' })
    .started()
    .run({ type: 'agent.complete_state', result: {} })
    .cmdExit(1, 'build failed: boom')
    .started()
    .run({ type: 'agent.complete_state', result: {} })
    .cmdExit(0)
    .cmdExit(0);
}

function edited(edit: (d: WorkflowDefinition) => void): WorkflowDefinition {
  const d = structuredClone(m1);
  edit(d);
  return WorkflowDefinitionSchema.parse(d);
}

const ticket = freshSnapshot(m1).ticket;

describe('simulateTicket', () => {
  it('an identical definition replays without a divergence', () => {
    const r = happyPath();
    expect(r.h.snap.status).toBe('done');
    const out = simulateTicket({ def: m1, ticket, sessions: [r.session()] });
    expect(out).toMatchObject({
      diverged: false,
      replayable: true,
      first_divergence: null,
      events_ignored_differently: 0,
      final: {
        recorded: { state: 'done', status: 'done' },
        simulated: { state: 'done', status: 'done' },
      },
    });
    expect(out.recorded_states).toEqual([
      'implement',
      'build',
      'implement',
      'build',
      'test',
      'done',
    ]);
    expect(out.simulated_states).toEqual(out.recorded_states);
    expect(out.events_replayed).toBe(8);
  });

  it('a retargeted transition diverges at the event that took it', () => {
    const r = happyPath();
    const draft = edited((d) => {
      const build = d.states.build as { on: Record<string, unknown> };
      build.on.exit_0 = 'done';
    });
    const out = simulateTicket({ def: draft, ticket, sessions: [r.session()] });
    expect(out.diverged).toBe(true);
    const d = out.first_divergence!;
    expect(d.move_index).toBe(4);
    expect(d.event_type).toBe('command.exited');
    expect(d.recorded).toMatchObject({ from: 'build', to: 'test' });
    expect(d.simulated).toMatchObject({ from: 'build', to: 'done' });
    // The draft's route up to the divergence, and the whole recorded one.
    expect(out.simulated_states).toEqual(['implement', 'build', 'implement', 'build']);
    expect(out.recorded_states).toHaveLength(6);
    expect(out.final.simulated.state).toBe('done');
  });

  it('removing the transition the agent took diverges at its complete_state', () => {
    const r = happyPath();
    const draft = edited((d) => {
      const impl = d.states.implement as { on: Record<string, unknown> };
      delete impl.on.done;
    });
    const out = simulateTicket({ def: draft, ticket, sessions: [r.session()] });
    expect(out.first_divergence).toMatchObject({
      move_index: 1,
      event_type: 'agent.complete_state',
      recorded: { from: 'implement', to: 'build' },
    });
    expect(out.first_divergence!.simulated?.to).not.toBe('build');
  });

  it('a changed timeout does not move when the recorded timer fired', () => {
    const r = new Recorder(m1).run({ type: 'session.assigned', machine_id: 'mbp' }).started();
    const deadline = r.h.snap.state_deadline!;
    r.run({ type: 'timer.fired', state: 'implement', deadline }, 30 * 60);
    expect(r.h.snap.workflow_state).toBe('needs_input');
    const draft = edited((d) => {
      (d.states.implement as { timeout: string }).timeout = '45m';
    });
    const out = simulateTicket({ def: draft, ticket, sessions: [r.session()] });
    expect(out.diverged).toBe(false);
    expect(out.simulated_states).toEqual(['implement', 'needs_input']);
  });

  it('an event the original run ignored is ignored again', () => {
    const r = new Recorder(m1).run({ type: 'session.assigned', machine_id: 'mbp' }).started();
    // A late exit of some earlier process: command_id_mismatch.
    r.run({ type: 'agent.exited', command_id: uuid(777), code: 1, signal: null });
    expect(r.rows.at(-1)!.payload).toMatchObject({ ignored: 'command_id_mismatch' });
    r.run({ type: 'agent.complete_state', result: {} });
    const out = simulateTicket({ def: m1, ticket, sessions: [r.session()] });
    expect(out).toMatchObject({ diverged: false, events_ignored_differently: 0 });
    expect(out.final.simulated.state).toBe('build');
  });

  it('a reopened session carries the context and the human’s message', () => {
    const ids = { n: 1 };
    const first = new Recorder(m1, undefined, ids)
      .run({ type: 'session.assigned', machine_id: 'mbp' })
      .started()
      .run({ type: 'agent.complete_state', result: { note: 'first' } })
      .cmdExit(0)
      .cmdExit(0);
    const prev = first.h.snap;
    const second = new Recorder(
      m1,
      {
        ...freshSnapshot(m1),
        id: SESSION_2,
        claude_session_id: prev.claude_session_id,
        context: prev.context,
        pending_answer: { input_request_id: null, answer: 'one more thing' },
      },
      ids,
    )
      .note('operator.reopen', { text: 'one more thing', reopened_from: prev.id, actor: 'ui' })
      .run({ type: 'session.assigned', machine_id: 'mbp' })
      .started()
      .run({ type: 'agent.complete_state', result: {} });
    const out = simulateTicket({
      def: m1,
      ticket,
      sessions: [first.session(), second.session(SESSION_2)],
    });
    expect(out.diverged).toBe(false);
    expect(out.recorded_states).toEqual([
      'implement',
      'build',
      'test',
      'done',
      'implement',
      'build',
    ]);
    expect(out.simulated_states).toEqual(out.recorded_states);
    expect(out.final.recorded).toEqual({ state: 'build', status: 'running' });
  });

  it('stops at a row it cannot read back, naming it', () => {
    const r = new Recorder(m1).run({ type: 'session.assigned', machine_id: 'mbp' });
    r.note('session.started', { command_id: 'not-a-uuid' });
    const bad = r.rows.at(-1)!.id;
    const out = simulateTicket({ def: m1, ticket, sessions: [r.session()] });
    expect(out.replayable).toBe(false);
    expect(out.error?.event_id).toBe(bad);
    expect(out.diverged).toBe(false);
  });

  it('a ticket with no sessions replays nothing', () => {
    const out = simulateTicket({ def: m1, ticket, sessions: [] });
    expect(out).toMatchObject({ diverged: false, events_replayed: 0, final: { recorded: null } });
  });
});
