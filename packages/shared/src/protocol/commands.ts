import type { z } from 'zod';
import type { OutboxEffect, SessionSnapshot } from '../engine/types.js';
import type {
  KillPayloadSchema,
  RunActionPayloadSchema,
  RunCmdPayloadSchema,
  SendInputPayloadSchema,
  SendMessagePayloadSchema,
  StartSessionPayloadSchema,
} from './ws.js';

// Effect → WS command payload (10-contracts §Effect → WS). Pure. The EngineService wrapper (T04)
// calls it in the apply transaction, once it has assigned the command_id, and stores the result
// verbatim as `outbox.payload` (with `outbox.fencing_token` = the session's token). The
// dispatcher then only wraps the row in an envelope (orchestrator `commandEnvelopeForOutboxRow`).

/** `start_session.base_ref` in M1: `HEAD` of the machine's shared clone (10-contracts). */
export const M1_BASE_REF = 'HEAD';

export type StartSessionPayload = z.infer<typeof StartSessionPayloadSchema>;
export type RunCmdPayload = z.infer<typeof RunCmdPayloadSchema>;
export type RunActionPayload = z.infer<typeof RunActionPayloadSchema>;
export type SendInputPayload = z.infer<typeof SendInputPayloadSchema>;
export type SendMessagePayload = z.infer<typeof SendMessagePayloadSchema>;
export type KillPayload = z.infer<typeof KillPayloadSchema>;

/** The outbox effects that become a WS command (connector_call has no WS message). */
export type MachineCommandEffect = Exclude<OutboxEffect, { type: 'connector_call' }>;

export interface CommandPayloadContext {
  /** Assigned by the wrapper. */
  command_id: string;
  /** The snapshot AFTER apply (machine_id, ticket). */
  snapshot: SessionSnapshot;
  /** `session.branch` (set by the claim; not in the snapshot). */
  branch: string;
  /** Default M1_BASE_REF. */
  base_ref?: string;
}

export type MachineCommand =
  | { kind: 'start_session'; target: string; payload: StartSessionPayload }
  | { kind: 'send_input'; target: string; payload: SendInputPayload }
  | { kind: 'send_message'; target: string; payload: SendMessagePayload }
  | { kind: 'run_cmd'; target: string; payload: RunCmdPayload }
  | { kind: 'run_action'; target: string; payload: RunActionPayload }
  | { kind: 'kill'; target: string; payload: KillPayload };

/**
 * Build the outbox `kind`, `target` (`machine:<snapshot.machine_id>`) and `payload` for one
 * effect. Throws if the snapshot has no machine (apply never emits a machine command then).
 */
export function commandPayloadForEffect(
  effect: MachineCommandEffect,
  ctx: CommandPayloadContext,
): MachineCommand {
  const { snapshot, command_id } = ctx;
  if (snapshot.machine_id === null) {
    throw new Error(`${effect.type} for session ${snapshot.id} without a machine`);
  }
  const target = `machine:${snapshot.machine_id}`;
  switch (effect.type) {
    case 'start_session': {
      const payload: StartSessionPayload = {
        command_id,
        ticket_id: snapshot.ticket.id,
        repo: snapshot.ticket.repo,
        base_ref: ctx.base_ref ?? M1_BASE_REF,
        branch: ctx.branch,
        workflow_state: effect.state,
        prompt: effect.prompt,
        tools: effect.tools,
        resume_claude_session_id: effect.resume_claude_session_id,
        // The workflow schema has no per-state env in M1; ports and git identity are added by
        // the daemon (ADR-0005 §Spawn).
        env: { CONDUCTOR_SESSION_ID: snapshot.id, CONDUCTOR_TICKET_ID: snapshot.ticket.id },
      };
      if (effect.model !== undefined) payload.model = effect.model;
      if (effect.max_turns !== undefined) payload.max_turns = effect.max_turns;
      if (effect.max_budget_usd !== undefined) payload.max_budget_usd = effect.max_budget_usd;
      if (effect.review === true) payload.review = true;
      return { kind: 'start_session', target, payload };
    }
    case 'send_input':
      return {
        kind: 'send_input',
        target,
        payload: { command_id, input_request_id: effect.input_request_id, text: effect.text },
      };
    case 'send_message': {
      // ADR-0007: only the process of the current agent visit may receive it.
      if (snapshot.agent_command_id === null) {
        throw new Error(`send_message for session ${snapshot.id} without an agent process`);
      }
      return {
        kind: 'send_message',
        target,
        payload: { command_id, target_command_id: snapshot.agent_command_id, text: effect.text },
      };
    }
    case 'run_cmd':
      return {
        kind: 'run_cmd',
        target,
        payload: {
          command_id,
          workflow_state: effect.state,
          cmd: effect.cmd,
          cwd: effect.cwd,
          timeout_ms: effect.timeout_ms,
          ...(effect.require_clean === true ? { require_clean: true as const } : {}),
          ...(effect.checkout !== undefined ? { checkout: effect.checkout } : {}),
        },
      };
    case 'run_action':
      if (effect.action !== 'open_pr') throw new Error(`unknown entry action ${effect.action}`);
      return {
        kind: 'run_action',
        target,
        payload: {
          command_id,
          workflow_state: effect.state,
          target_state: effect.target_state,
          action: effect.action,
          idempotency_key: effect.idempotency_key,
          args: effect.args,
          branch: ctx.branch,
          expected_sha: effect.expected_sha,
        },
      };
    case 'kill':
      // Engine kills (operator.cancel, …) target every process of the session at or below the
      // envelope token (the row's token). Only the gateway's direct orphan kills set
      // target_command_id (10-contracts §Orphaned processes).
      return {
        kind: 'kill',
        target,
        payload: {
          command_id,
          target_command_id: effect.target_command_id ?? null,
          reason: effect.reason,
        },
      };
  }
}
