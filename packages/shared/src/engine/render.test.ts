import { describe, expect, it } from 'vitest';
import type { AgentState } from '../workflow/schema.js';
import {
  HOW_TO_FINISH_HEADING,
  renderPrompt,
  TICKET_TEMPLATE,
  WORK_REPOSITORY_HEADING,
} from './render.js';
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
    expect(p).toContain(
      "- pr_url: https://pr/1\n- channel: #reviews\n- n: 2\n- `gone`: not produced (a person moved this ticket here directly). Work out what's needed from the ticket first, and make a short plan before changing code.",
    );
    expect(p).toContain('containing `ts`');
  });

  it('an input a human move skipped says so (T02 rule 5: human moves may skip producers)', () => {
    const p = renderPrompt({
      stateName: 'implementing',
      state: { type: 'agent', prompt: 'implement_template', input: { plan: '$planning.plan' } },
      snapshot: SNAPSHOT_FIXTURE,
    });
    expect(p).toContain(
      "## Inputs\n\n- `plan`: not produced (a person moved this ticket here directly). Work out what's needed from the ticket first, and make a short plan before changing code.",
    );
    expect(p).not.toContain('(missing)');
  });
});

describe('renderPrompt (ADR-0011)', () => {
  const work = {
    ...SNAPSHOT_FIXTURE,
    ticket: { ...SNAPSHOT_FIXTURE.ticket, kind: 'work' as const },
  };

  it('a work ticket gets the work-commit rule, before how to finish', () => {
    const p = renderPrompt({ stateName: 'implement', state: template, snapshot: work });
    expect(p).toContain(WORK_REPOSITORY_HEADING);
    expect(p.indexOf(WORK_REPOSITORY_HEADING)).toBeLessThan(p.indexOf('## When you are done'));
    for (const kind of ['personal', null] as const) {
      const other = { ...SNAPSHOT_FIXTURE, ticket: { ...SNAPSHOT_FIXTURE.ticket, kind } };
      expect(
        renderPrompt({ stateName: 'implement', state: template, snapshot: other }),
      ).not.toContain(WORK_REPOSITORY_HEADING);
    }
  });

  it('transitions replace "When you are done" with "How to finish"', () => {
    const p = renderPrompt({
      stateName: 'implement',
      state: { ...template, result: ['summary'] },
      snapshot: SNAPSHOT_FIXTURE,
      transitions: [
        { name: 'ship', when: 'It is done.', question: false },
        { name: 'ask', when: null, question: true },
        { name: 'other', when: null, question: false },
      ],
    });
    expect(p).not.toContain('## When you are done');
    expect(p).toContain(
      `${HOW_TO_FINISH_HEADING}\n\nWhen you finish this step, take exactly one of these transitions:\n\n- ship: It is done.\n- ask: Your \`reason\` is the question for the human.\n- other\n`,
    );
    expect(p).toContain('a `result` object containing `summary`');
  });
});
