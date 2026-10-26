import { describe, expect, it } from 'vitest';
import { SNAPSHOT_FIXTURE } from '../engine/fixtures.js';
import { sessionBranch } from '../domain.js';
import { commandPayloadForEffect, M1_BASE_REF } from './commands.js';
import { OrchestratorToDaemonSchema } from './ws.js';

const command_id = 'c0ffee00-1111-4222-8333-444455556666';
const branch = sessionBranch(SNAPSHOT_FIXTURE.ticket.id, SNAPSHOT_FIXTURE.id);
const ctx = { command_id, snapshot: SNAPSHOT_FIXTURE, branch };

/** Every built payload must be a valid WS command once wrapped in an envelope. */
function envelope(kind: string, payload: unknown) {
  return OrchestratorToDaemonSchema.parse({
    type: kind,
    msg_id: '0e1d2c3b-4a59-4687-9a6b-5c4d3e2f1a0b',
    seq: null,
    session_id: SNAPSHOT_FIXTURE.id,
    fencing_token: SNAPSHOT_FIXTURE.fencing_token,
    payload,
  });
}

describe('commandPayloadForEffect (Effect → WS)', () => {
  it('start_session carries ticket, branch, base_ref HEAD, env and the resume id', () => {
    const c = commandPayloadForEffect(
      {
        type: 'start_session',
        state: 'implement',
        prompt: 'postgres',
        tools: ['edit', 'bash'],
        resume_claude_session_id: 'claude-1',
        max_budget_usd: 1.5,
      },
      ctx,
    );
    expect(c.kind).toBe('start_session');
    expect(c.target).toBe('machine:mbp-ben');
    expect(c.payload).toEqual({
      command_id,
      ticket_id: SNAPSHOT_FIXTURE.ticket.id,
      repo: SNAPSHOT_FIXTURE.ticket.repo,
      base_ref: M1_BASE_REF,
      branch,
      workflow_state: 'implement',
      prompt: 'postgres',
      tools: ['edit', 'bash'],
      resume_claude_session_id: 'claude-1',
      max_budget_usd: 1.5,
      env: {
        CONDUCTOR_SESSION_ID: SNAPSHOT_FIXTURE.id,
        CONDUCTOR_TICKET_ID: SNAPSHOT_FIXTURE.ticket.id,
      },
    });
    expect(envelope(c.kind, c.payload).type).toBe('start_session');
  });

  it('engine kills target every process of the session (target_command_id null)', () => {
    const c = commandPayloadForEffect({ type: 'kill', reason: 'operator_cancel' }, ctx);
    expect(c.payload).toEqual({ command_id, target_command_id: null, reason: 'operator_cancel' });
    expect(envelope(c.kind, c.payload).type).toBe('kill');
  });

  it('send_input and run_cmd map field for field', () => {
    const s = commandPayloadForEffect(
      { type: 'send_input', input_request_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', text: 'a' },
      ctx,
    );
    expect(envelope(s.kind, s.payload).type).toBe('send_input');
    const r = commandPayloadForEffect(
      { type: 'run_cmd', state: 'build', cmd: 'npm run build', cwd: null, timeout_ms: 600000 },
      ctx,
    );
    expect(r.payload).toMatchObject({ workflow_state: 'build', cmd: 'npm run build' });
    expect(envelope(r.kind, r.payload).type).toBe('run_cmd');
  });

  it('send_message targets the current agent process (ADR-0007)', () => {
    const agent = 'a9e17000-1111-4222-8333-444455556666';
    const snapshot = { ...SNAPSHOT_FIXTURE, agent_command_id: agent, agent_process_live: true };
    const c = commandPayloadForEffect(
      { type: 'send_message', text: '/context' },
      { ...ctx, snapshot },
    );
    expect(c).toEqual({
      kind: 'send_message',
      target: 'machine:mbp-ben',
      payload: { command_id, target_command_id: agent, text: '/context' },
    });
    expect(envelope(c.kind, c.payload).type).toBe('send_message');
    expect(() =>
      commandPayloadForEffect(
        { type: 'send_message', text: 'x' },
        { ...ctx, snapshot: { ...SNAPSHOT_FIXTURE, agent_command_id: null } },
      ),
    ).toThrow(/without an agent process/);
  });

  it('ADR-0011: start_session carries the allowed transitions; none → field omitted', () => {
    const transitions = [
      { name: 'ready_for_testing', when: 'Done and tested.', question: false },
      { name: 'ask_user', when: null, question: false },
    ];
    const base = {
      type: 'start_session' as const,
      state: 'implementing',
      prompt: 'p',
      tools: ['edit'],
      resume_claude_session_id: null,
    };
    const c = commandPayloadForEffect({ ...base, transitions }, ctx);
    expect(c.kind === 'start_session' && c.payload.transitions).toEqual(transitions);
    expect(envelope(c.kind, c.payload).type).toBe('start_session');
    const old = commandPayloadForEffect({ ...base, transitions: [] }, ctx);
    expect(old.payload).not.toHaveProperty('transitions');
  });

  it('ADR-0011: run_action evaluate_conditions maps field for field', () => {
    const args = {
      conditions: [{ type: 'pr_approvals', min: 1 }],
      pr_url: 'https://github.com/benjgrad/fixture-app/pull/7',
      branch,
    };
    const c = commandPayloadForEffect(
      {
        type: 'run_action',
        state: 'implementing → waiting_external (move: ready_for_testing)',
        target_state: 'waiting_external',
        action: 'evaluate_conditions',
        idempotency_key: 'k',
        args,
        expected_sha: null,
      },
      ctx,
    );
    expect(c.payload).toMatchObject({ action: 'evaluate_conditions', args, branch });
    expect(envelope(c.kind, c.payload).type).toBe('run_action');
    expect(() =>
      commandPayloadForEffect(
        {
          type: 'run_action',
          state: 's',
          target_state: 't',
          action: 'deploy',
          idempotency_key: 'k',
          args: {},
          expected_sha: null,
        },
        ctx,
      ),
    ).toThrow(/unknown entry action/);
  });

  it('M2: start_session carries the working copy from the context; none → field omitted', () => {
    const effect = {
      type: 'start_session' as const,
      state: 'implementing',
      prompt: 'p',
      tools: ['edit'],
      resume_claude_session_id: null,
    };
    const working_copy = { repo_path: '/Users/ben/code/fixture-app', mode: 'reference' as const };
    const c = commandPayloadForEffect(effect, { ...ctx, working_copy });
    expect(c.kind === 'start_session' && c.payload.working_copy).toEqual(working_copy);
    expect(envelope(c.kind, c.payload).type).toBe('start_session');
    expect(commandPayloadForEffect(effect, ctx).payload).not.toHaveProperty('working_copy');
  });

  it('throws without a machine', () => {
    expect(() =>
      commandPayloadForEffect(
        { type: 'kill', reason: 'x' },
        { ...ctx, snapshot: { ...SNAPSHOT_FIXTURE, machine_id: null } },
      ),
    ).toThrow(/without a machine/);
  });
});
