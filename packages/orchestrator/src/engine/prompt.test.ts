import {
  SNAPSHOT_FIXTURE,
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import type { CreateEngineService } from '../main.js';
import { backoffSeconds } from './dispatcher.js';
import { createEngineService } from './index.js';
import { renderStartPrompt, renderTemplate } from './prompt.js';

const def: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  id: 'w',
  version: 1,
  start: 'implement',
  budget: { usd: 1, minutes: 10, max_loop_retries: 1 },
  on_budget_exceeded: 'needs_input',
  states: {
    implement: { type: 'agent', prompt: 'ticket_template', tools: ['edit'], on: { done: 'post' } },
    inline: { type: 'agent', prompt: 'Fix {{ticket.title}} in {{state}}', on: { done: 'post' } },
    post: {
      type: 'agent',
      skill: 'slack-post',
      input: { pr_url: '$open_pr.pr_url', channel: '#reviews' },
      on: { done: 'done' },
    },
    needs_input: { type: 'human' },
    done: { type: 'terminal' },
  },
});
const snap = { ...SNAPSHOT_FIXTURE, context: { open_pr: { pr_url: 'https://pr/1' } } };

describe('renderStartPrompt', () => {
  it('expands a named template with the ticket facts and keeps attached output', () => {
    const out = renderStartPrompt(def, snap, {
      state: 'implement',
      prompt: 'ticket_template\n\n--- build output ---\nerror TS2304',
    });
    expect(out).toContain('Add /health');
    expect(out).toContain('Return 200');
    expect(out).toContain('Workflow state: implement');
    expect(out).not.toContain('ticket_template');
    expect(out.endsWith('\n\n--- build output ---\nerror TS2304')).toBe(true);
  });

  it('treats an unknown prompt name as an inline template', () => {
    const out = renderStartPrompt(def, snap, {
      state: 'inline',
      prompt: 'Fix {{ticket.title}} in {{state}}',
    });
    expect(out).toBe('Fix Add /health in inline');
  });

  it('renders a skill state with its resolved inputs', () => {
    const out = renderStartPrompt(def, snap, { state: 'post', prompt: 'slack-post' });
    expect(out).toContain('slack-post skill');
    expect(out).toContain('- pr_url: https://pr/1');
    expect(out).toContain('- channel: #reviews');
  });

  it('passes the pending answer through untouched', () => {
    const s = {
      ...snap,
      pending_answer: { input_request_id: snap.ticket.id, answer: '{{x}} yes' },
    };
    expect(renderStartPrompt(def, s, { state: 'implement', prompt: '{{x}} yes' })).toBe(
      '{{x}} yes',
    );
  });

  it('passes through prompts that are already rendered', () => {
    expect(renderStartPrompt(def, snap, { state: 'implement', prompt: 'Do X' })).toBe('Do X');
    expect(renderStartPrompt(def, snap, { state: 'missing', prompt: 'ticket_template' })).toBe(
      'ticket_template',
    );
  });

  it('leaves unknown placeholders verbatim', () => {
    expect(
      renderTemplate('{{nope}} {{ticket.nope}} {{ticket.ref}}', {
        ticket: snap.ticket,
        state: 's',
        input: {},
      }),
    ).toBe(`{{nope}} {{ticket.nope}} ${snap.ticket.id}`);
  });
});

describe('dispatcher backoff', () => {
  it('is 5, 10, 20, 40, then 60 s after the n-th send', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(backoffSeconds)).toEqual([5, 10, 20, 40, 60, 60, 60]);
  });
});

describe('createEngineService', () => {
  it('matches the composition-root factory signature', () => {
    const factory: CreateEngineService = createEngineService;
    expect(typeof factory).toBe('function');
  });
});
