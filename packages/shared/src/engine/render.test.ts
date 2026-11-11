import { describe, expect, it } from 'vitest';
import type { AgentState } from '../workflow/schema.js';
import {
  CONDUCTOR_V1_DEF,
  CONDUCTOR_V2_DEF,
  CONDUCTOR_V3_DEF,
  CONDUCTOR_V4_DEF,
} from '../workflow/conductor.js';
import { ROUTINE_V1_DEF } from '../workflow/routine.js';
import {
  ASK_BEFORE_HANDOFF_INSTRUCTION,
  HOW_TO_FINISH_HEADING,
  IMPLEMENT_SCOPE_INSTRUCTION,
  IMPLEMENT_SCOPE_NO_PROPOSALS_INSTRUCTION,
  IMPLEMENT_TEMPLATE,
  IMPLEMENT_TESTS_INSTRUCTION,
  PLAN_ASK_INSTRUCTION,
  PLAN_ASSUMPTIONS_HEADING,
  PLAN_FILES_INSTRUCTION,
  PLAN_HEADINGS_INSTRUCTION,
  PLAN_MECHANISMS_HEADING,
  PLAN_SIZE_INSTRUCTION,
  PLAN_SIZE_NO_PROPOSALS_INSTRUCTION,
  PLAN_TEMPLATE,
  PROPOSALS_HINT,
  READONLY_SHELL_HEADING,
  renderPrompt,
  RUN_GATE_INSTRUCTION,
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
      "- pr_url: https://pr/1\n- channel: #reviews\n- n: 2\n- `gone`: not produced (a person moved this ticket here directly). Work out what's needed from the ticket.",
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
      "## Inputs\n\n- `plan`: not produced (a person moved this ticket here directly). Work out what's needed from the ticket.",
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

describe('proposed_tickets hint (optional follow-up tickets)', () => {
  it.each([
    ['planning', PLAN_TEMPLATE],
    ['implementing', IMPLEMENT_TEMPLATE],
  ])('the %s template offers proposed_tickets as optional', (stateName, prompt) => {
    const state: AgentState = { type: 'agent', prompt, tools: ['edit'] };
    const p = renderPrompt({ stateName, state, snapshot: SNAPSHOT_FIXTURE });
    expect(p).toContain(PROPOSALS_HINT);
    expect(p).toContain('`"proposed_tickets"`');
    expect(p).toContain("It's optional");
  });

  it('the plain ticket template does not mention it', () => {
    const p = renderPrompt({ stateName: 'implement', state: template, snapshot: SNAPSHOT_FIXTURE });
    expect(p).not.toContain('proposed_tickets');
  });

  it('no built-in workflow requires proposed_tickets in a result list', () => {
    for (const def of [
      CONDUCTOR_V1_DEF,
      CONDUCTOR_V2_DEF,
      CONDUCTOR_V3_DEF,
      CONDUCTOR_V4_DEF,
      ROUTINE_V1_DEF,
    ]) {
      for (const state of Object.values(def.states)) {
        if (state.type !== 'agent') continue;
        expect(state.result ?? []).not.toContain('proposed_tickets');
      }
    }
  });
});

describe('planned files (ADR-0037 P4)', () => {
  it('the plan template asks for a ## Files list and the files result key', () => {
    const state: AgentState = { type: 'agent', prompt: PLAN_TEMPLATE, tools: ['read'] };
    const p = renderPrompt({ stateName: 'planning', state, snapshot: SNAPSHOT_FIXTURE });
    expect(p).toContain(PLAN_FILES_INSTRUCTION);
    expect(p).toContain('`## Files`');
    expect(p).toContain('"files": ["<path or glob>", …]');
  });

  it('with follow_ups set, the hint is removed and the files instruction stays', () => {
    const state: AgentState = {
      type: 'agent',
      prompt: PLAN_TEMPLATE,
      tools: ['read'],
      follow_ups: { enabled: false, max: 3 },
    };
    const p = renderPrompt({ stateName: 'planning', state, snapshot: SNAPSHOT_FIXTURE });
    expect(p).not.toContain(PROPOSALS_HINT);
    expect(p).toContain(PLAN_FILES_INSTRUCTION);
  });

  it('the implement template does not ask for files', () => {
    const state: AgentState = { type: 'agent', prompt: IMPLEMENT_TEMPLATE, tools: ['edit'] };
    const p = renderPrompt({ stateName: 'implementing', state, snapshot: SNAPSHOT_FIXTURE });
    expect(p).not.toContain(PLAN_FILES_INSTRUCTION);
  });
});

describe('plan headings and the read-only shell (R7)', () => {
  const planning: AgentState = { type: 'agent', prompt: PLAN_TEMPLATE, tools: ['read'] };
  const render = (state: AgentState, stateName = 'planning') =>
    renderPrompt({ stateName, state, snapshot: SNAPSHOT_FIXTURE });

  it('the plan template requires Assumptions and Existing mechanisms checked, before ## Files', () => {
    const p = render(planning);
    expect(p).toContain(PLAN_HEADINGS_INSTRUCTION);
    expect(p).toContain(`\`${PLAN_ASSUMPTIONS_HEADING}\``);
    expect(p).toContain(`\`${PLAN_MECHANISMS_HEADING}\``);
    expect(PLAN_ASSUMPTIONS_HEADING).toBe('## Assumptions');
    expect(PLAN_MECHANISMS_HEADING).toBe('## Existing mechanisms checked');
    expect(PLAN_HEADINGS_INSTRUCTION).toContain('`None.`');
    expect(p.indexOf(PLAN_HEADINGS_INSTRUCTION)).toBeLessThan(p.indexOf(PLAN_FILES_INSTRUCTION));
  });

  it('the implement and ticket templates do not ask for them', () => {
    for (const [name, prompt] of [
      ['implementing', IMPLEMENT_TEMPLATE],
      ['implement', TICKET_TEMPLATE],
    ] as const) {
      const p = render({ type: 'agent', prompt, tools: ['edit'] }, name);
      expect(p).not.toContain(PLAN_HEADINGS_INSTRUCTION);
      expect(p).not.toContain(PLAN_MECHANISMS_HEADING);
    }
  });

  it('a bash_readonly state is told what it may run, before how to finish', () => {
    const p = render({ ...planning, tools: ['read', 'bash_readonly'] });
    expect(p).toContain(READONLY_SHELL_HEADING);
    for (const c of [
      '`git log …`',
      '`gh pr checks …`',
      '`gh run view …`',
      '`rg …`',
      '`git status`',
    ])
      expect(p).toContain(c);
    expect(p).toContain('denied without a prompt');
    expect(p.indexOf(READONLY_SHELL_HEADING)).toBeLessThan(p.indexOf('## When you are done'));
    expect(render(planning)).not.toContain(READONLY_SHELL_HEADING);
  });
});

describe('process-review rules (ADR-0037 §4, C2)', () => {
  const implementing: AgentState = { type: 'agent', prompt: IMPLEMENT_TEMPLATE, tools: ['edit'] };
  const planning: AgentState = { type: 'agent', prompt: PLAN_TEMPLATE, tools: ['read'] };
  const sized = (size: 'S' | 'M' | 'L' | null) => ({
    ...SNAPSHOT_FIXTURE,
    ticket: { ...SNAPSHOT_FIXTURE.ticket, size },
  });

  it('the implement template carries the scope and test-as-you-go paragraphs', () => {
    const p = renderPrompt({
      stateName: 'implementing',
      state: implementing,
      snapshot: SNAPSHOT_FIXTURE,
    });
    expect(p).toContain(IMPLEMENT_SCOPE_INSTRUCTION);
    expect(p).toContain(IMPLEMENT_TESTS_INSTRUCTION);
    expect(IMPLEMENT_SCOPE_INSTRUCTION).toContain('`proposed_tickets`');
    expect(IMPLEMENT_SCOPE_INSTRUCTION).toContain('`ask_user`');
  });

  it('R4: the implement template tells the agent to run_gate before taking a checked transition', () => {
    const p = renderPrompt({
      stateName: 'implementing',
      state: implementing,
      snapshot: SNAPSHOT_FIXTURE,
    });
    expect(p).toContain(RUN_GATE_INSTRUCTION);
    expect(RUN_GATE_INSTRUCTION).toContain('`run_gate`');
    const plan = renderPrompt({
      stateName: 'planning',
      state: planning,
      snapshot: SNAPSHOT_FIXTURE,
    });
    expect(plan).not.toContain(RUN_GATE_INSTRUCTION);
  });

  it('with follow-ups off, out-of-scope work goes to the summary, not proposed_tickets', () => {
    const p = renderPrompt({
      stateName: 'implementing',
      state: { ...implementing, follow_ups: { enabled: false, max: 3 } },
      snapshot: SNAPSHOT_FIXTURE,
    });
    expect(p).not.toContain(IMPLEMENT_SCOPE_INSTRUCTION);
    expect(p).toContain(IMPLEMENT_SCOPE_NO_PROPOSALS_INSTRUCTION);
    expect(p).toContain(IMPLEMENT_TESTS_INSTRUCTION);
    expect(p).not.toContain('proposed_tickets');
  });

  it('with follow-ups on, the scope paragraph keeps proposed_tickets', () => {
    const p = renderPrompt({
      stateName: 'implementing',
      state: { ...implementing, follow_ups: { enabled: true, max: 2 } },
      snapshot: SNAPSHOT_FIXTURE,
    });
    expect(p).toContain(IMPLEMENT_SCOPE_INSTRUCTION);
  });

  it('an L ticket shows its size and the plan template asks to split it', () => {
    const p = renderPrompt({ stateName: 'planning', state: planning, snapshot: sized('L') });
    expect(p).toContain('Size: L');
    expect(p).toContain(PLAN_SIZE_INSTRUCTION);
  });

  it('an L ticket in a state with follow-ups off is asked about instead', () => {
    const p = renderPrompt({
      stateName: 'planning',
      state: { ...planning, follow_ups: { enabled: false, max: 3 } },
      snapshot: sized('L'),
    });
    expect(p).toContain(PLAN_SIZE_NO_PROPOSALS_INSTRUCTION);
    expect(p).not.toContain(PLAN_SIZE_INSTRUCTION);
  });

  it.each([['S' as const], ['M' as const], [null]])('size %s gets no split line', (size) => {
    const p = renderPrompt({ stateName: 'planning', state: planning, snapshot: sized(size) });
    expect(p).not.toContain(PLAN_SIZE_INSTRUCTION);
    expect(p.includes('Size:')).toBe(size !== null);
  });

  it('the plain ticket template has none of the new paragraphs', () => {
    const p = renderPrompt({ stateName: 'implement', state: template, snapshot: SNAPSHOT_FIXTURE });
    expect(p).not.toContain(IMPLEMENT_SCOPE_INSTRUCTION);
    expect(p).not.toContain(IMPLEMENT_TESTS_INSTRUCTION);
    expect(p).not.toContain(PLAN_SIZE_INSTRUCTION);
    expect(p).not.toContain(ASK_BEFORE_HANDOFF_INSTRUCTION);
    expect(p).not.toContain(PLAN_ASK_INSTRUCTION);
  });
});

describe('asking questions: resolve unknowns before the PR hand-off', () => {
  const implementing: AgentState = { type: 'agent', prompt: IMPLEMENT_TEMPLATE, tools: ['edit'] };
  const planning: AgentState = { type: 'agent', prompt: PLAN_TEMPLATE, tools: ['read'] };

  it('the implement template asks freely and hands off only when nothing is left to ask', () => {
    for (const follow_ups of [undefined, { enabled: false, max: 3 }] as const) {
      const p = renderPrompt({
        stateName: 'implementing',
        state: follow_ups ? { ...implementing, follow_ups } : implementing,
        snapshot: SNAPSHOT_FIXTURE,
      });
      expect(p).toContain(ASK_BEFORE_HANDOFF_INSTRUCTION);
      expect(p).not.toContain('never a commit in this PR');
      expect(p).not.toContain('Do only what');
    }
    expect(ASK_BEFORE_HANDOFF_INSTRUCTION).toContain('`ask_user`');
    expect(ASK_BEFORE_HANDOFF_INSTRUCTION).toContain('only when nothing is left to ask');
  });

  it('the scope paragraph is judgement-based and its two variants stay distinct', () => {
    expect(IMPLEMENT_SCOPE_INSTRUCTION).toContain('use your judgement');
    expect(IMPLEMENT_SCOPE_NO_PROPOSALS_INSTRUCTION).toContain('use your judgement');
    expect(IMPLEMENT_SCOPE_INSTRUCTION).not.toBe(IMPLEMENT_SCOPE_NO_PROPOSALS_INSTRUCTION);
  });

  it('the plan template asks rather than guesses', () => {
    const p = renderPrompt({ stateName: 'planning', state: planning, snapshot: SNAPSHOT_FIXTURE });
    expect(p).toContain(PLAN_ASK_INSTRUCTION);
    expect(p).not.toContain(ASK_BEFORE_HANDOFF_INSTRUCTION);
  });

  it('ask_user is offered for information as well as decisions', () => {
    const p = renderPrompt({ stateName: 'implement', state: template, snapshot: SNAPSHOT_FIXTURE });
    expect(p).toContain('If you need a decision or information from a human, call `ask_user`');
    expect(p).not.toContain('blocked');
  });
});
