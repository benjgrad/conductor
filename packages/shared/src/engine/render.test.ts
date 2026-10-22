import { describe, expect, it } from 'vitest';
import type { AgentState } from '../workflow/schema.js';
import { renderPrompt, TICKET_TEMPLATE } from './render.js';
import { SNAPSHOT_FIXTURE } from './fixtures.js';

const template: AgentState = { type: 'agent', prompt: TICKET_TEMPLATE, tools: ['edit'] };

describe('renderPrompt', () => {
  it('ticket_template: title, body, repo and how to finish', () => {
    const p = renderPrompt({ stateName: 'implement', state: template, snapshot: SNAPSHOT_FIXTURE });
    expect(p).toContain('# Ticket: Add /health');
    expect(p).toContain('Return 200');
    expect(p).toContain('Repository: github.com/benjgrad/fixture-app');
    expect(p).not.toContain('External reference');
    expect(p).toContain('call the `complete_state` tool');
    expect(p).toContain('call `ask_user`');
    expect(p).not.toContain('Previous attempt');
    expect(p).not.toContain('Answer from a human');
  });

  it('attaches the failed step output in a fence it cannot close', () => {
    const p = renderPrompt({
      stateName: 'implement',
      state: template,
      snapshot: SNAPSHOT_FIXTURE,
      attachment: { from: 'build', detail: 'exit code 2', output: 'error\n```\nmore\n' },
    });
    expect(p).toContain('The `build` step failed (exit code 2)');
    expect(p).toContain('````text\nerror\n```\nmore\n````');
  });

  it('includes the human answer and the external reference', () => {
    const p = renderPrompt({
      stateName: 'implement',
      state: template,
      snapshot: {
        ...SNAPSHOT_FIXTURE,
        ticket: { ...SNAPSHOT_FIXTURE.ticket, external_ref: 'JIRA-1' },
      },
      answer: 'Use port 8080',
    });
    expect(p).toContain('External reference: JIRA-1');
    expect(p).toContain('## Answer from a human\n\nUse port 8080');
  });

  it('literal prompts substitute known placeholders and keep unknown ones', () => {
    const p = renderPrompt({
      stateName: 's',
      state: { type: 'agent', prompt: 'Fix {{ ticket.title }} in {{ticket.repo}} ({{nope}})' },
      snapshot: SNAPSHOT_FIXTURE,
    });
    expect(p.startsWith('Fix Add /health in github.com/benjgrad/fixture-app ({{nope}})')).toBe(
      true,
    );
  });

  it('skill states: run the skill, resolved $refs, literal inputs, result keys', () => {
    const p = renderPrompt({
      stateName: 'notify',
      state: {
        type: 'agent',
        skill: 'slack-post',
        input: { pr_url: '$open_pr.pr_url', channel: '#reviews', n: 2, gone: '$x.y' },
        result: ['ts'],
      },
      snapshot: { ...SNAPSHOT_FIXTURE, context: { open_pr: { pr_url: 'https://pr/1' } } },
    });
    expect(p).toContain('Run the `slack-post` skill for workflow step `notify`.');
    expect(p).toContain('- pr_url: https://pr/1\n- channel: #reviews\n- n: 2\n- gone: (missing)');
    expect(p).toContain('containing `ts`');
  });
});
