import { describe, expect, it } from 'vitest';
import { Harness, referenceWorkflow } from '../engine/apply.testkit.js';
import { SNAPSHOT_FIXTURE } from '../engine/fixtures.js';
import { commandPayloadForEffect } from '../protocol/commands.js';
import { StartSessionPayloadSchema } from '../protocol/ws.js';
import { mcpServerRule, McpPolicySchema, resolveMcpPolicy } from './mcp.js';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from './schema.js';

// ADR-0029: agents inherit the machine owner's MCP servers unless the workflow says otherwise.

const m1 = referenceWorkflow('m1_basic');

function withMcp(
  workflow: WorkflowDefinition['mcp'],
  implement?: WorkflowDefinition['mcp'],
): WorkflowDefinition {
  const states = structuredClone(m1.states);
  const impl = states.implement!;
  if (impl.type === 'agent' && implement !== undefined) impl.mcp = implement;
  return WorkflowDefinitionSchema.parse({
    ...m1,
    ...(workflow !== undefined ? { mcp: workflow } : {}),
    states,
  });
}

const firstStart = (def: WorkflowDefinition) => {
  const r = new Harness(def).run({ type: 'session.assigned', machine_id: 'mbp-ben' });
  return r.effects.find((e) => e.type === 'start_session')!;
};

describe('ADR-0029 MCP policy', () => {
  it('resolveMcpPolicy: the state replaces the workflow, which replaces the inherit default', () => {
    expect(resolveMcpPolicy({}, {})).toEqual({ mode: 'inherit' });
    expect(resolveMcpPolicy({ mcp: { mode: 'none' } }, {})).toEqual({ mode: 'none' });
    expect(
      resolveMcpPolicy({ mcp: { mode: 'none' } }, { mcp: { mode: 'inherit', deny: ['x'] } }),
    ).toEqual({ mode: 'inherit', deny: ['x'] });
  });

  it('mcpServerRule: Claude Code tool prefixes', () => {
    expect(mcpServerRule('claude.ai Atlassian')).toBe('mcp__claude_ai_Atlassian');
    expect(mcpServerRule('plugin:azure:azure')).toBe('mcp__plugin_azure_azure');
    expect(mcpServerRule('chrome-devtools')).toBe('mcp__chrome-devtools');
    expect(mcpServerRule(' vibe_kanban ')).toBe('mcp__vibe_kanban');
  });

  it('the schema refuses unknown modes and keys, and empty names', () => {
    expect(McpPolicySchema.safeParse({ mode: 'all' }).success).toBe(false);
    expect(McpPolicySchema.safeParse({ mode: 'inherit', allow: ['x'] }).success).toBe(false);
    expect(McpPolicySchema.safeParse({ mode: 'inherit', deny: [' '] }).success).toBe(false);
    expect(() => withMcp({ mode: 'inherit', deny: ['claude.ai Gmail'] })).not.toThrow();
  });

  it('a worker start carries the resolved policy: inherit by default, else the workflow or state', () => {
    expect(firstStart(m1).mcp).toEqual({ mode: 'inherit' });
    expect(firstStart(withMcp({ mode: 'none' })).mcp).toEqual({ mode: 'none' });
    expect(
      firstStart(withMcp({ mode: 'none' }, { mode: 'inherit', deny: ['claude.ai Gmail'] })).mcp,
    ).toEqual({ mode: 'inherit', deny: ['claude.ai Gmail'] });
  });

  it('commandPayloadForEffect copies it to start_session; without it the payload has none', () => {
    const ctx = {
      command_id: 'c0ffee00-1111-4222-8333-444455556666',
      snapshot: SNAPSHOT_FIXTURE,
      branch: 'b',
    };
    const effect = {
      type: 'start_session' as const,
      state: 'implement',
      prompt: 'p',
      tools: [],
      resume_claude_session_id: null,
    };
    const withPolicy = commandPayloadForEffect(
      { ...effect, mcp: { mode: 'inherit', deny: ['claude.ai Gmail'] } },
      ctx,
    );
    expect(withPolicy.kind === 'start_session' && withPolicy.payload.mcp).toEqual({
      mode: 'inherit',
      deny: ['claude.ai Gmail'],
    });
    expect(StartSessionPayloadSchema.parse(withPolicy.payload).mcp?.mode).toBe('inherit');
    const without = commandPayloadForEffect(effect, ctx);
    expect(without.kind === 'start_session' && 'mcp' in without.payload).toBe(false);
  });
});
