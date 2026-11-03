import {
  RETURN_TO,
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
} from './schema.js';

// ADR-0032: `routine`, the shipped workflow of recurring tickets (schedules). One agent step that
// does the ticket's job with the machine's own skills, plugins and CLIs, then finishes or escalates
// to a person. No PR: the worktree is only a working directory. A copy of
// docs/design/workflows/routine.v1.json (a test checks they are equal), seeded like `conductor`.

export const ROUTINE_WORKFLOW_ID = 'routine';

export const ROUTINE_PROMPT = [
  '# Recurring job: {{ticket.title}}',
  '',
  '{{ticket.body}}',
  '',
  'Repository (working directory only): {{ticket.repo}}',
  '',
  '## Your step: a recurring run',
  '',
  'This ticket was created by a schedule: it runs again later, so do what is due now and nothing else.',
  'Follow the instructions above using the skills, plugins, MCP servers and CLIs available on this machine.',
  'The repository checkout is only a working directory: do not commit, push or open a pull request in it unless the instructions above say to.',
  'If anything needs a person (a decision, an outward-facing action you are unsure about, missing access, or ambiguous instructions), take `needs_decision` with one clear question instead of guessing.',
  'When you finish, give a short `report`: what you checked, what you changed (with links), and anything left for a person.',
].join('\n');

export const ROUTINE_V1: WorkflowDefinitionInput = {
  id: ROUTINE_WORKFLOW_ID,
  version: 1,
  start: 'running',
  budget: { usd: 3, minutes: 90, max_loop_retries: 3 },
  on_budget_exceeded: 'needs_input',
  columns: ['running', 'needs_input', 'done'],
  states: {
    running: {
      type: 'agent',
      title: 'Running',
      prompt: ROUTINE_PROMPT,
      tools: ['read', 'edit', 'bash', 'git'],
      result: ['report'],
      timeout: '60m',
      on: {
        done: {
          goto: 'done',
          title: 'Done',
          when: 'Everything the job asks for is done, or nothing needed doing this time.',
        },
        needs_decision: {
          goto: 'needs_input',
          title: 'Needs a decision',
          when: "Something needs the user's judgement or an action only they can take.",
          question: true,
        },
        ask_user: 'needs_input',
        timeout: 'needs_input',
      },
    },
    needs_input: {
      type: 'human',
      title: 'Needs input',
      on: {
        answer: { goto: RETURN_TO, title: 'Back with this answer', actor: 'human' },
        done: { goto: 'done', title: 'Done', actor: 'human' },
      },
    },
    done: { type: 'terminal', title: 'Done' },
  },
};

/** ROUTINE_V1 parsed (defaults applied). */
export const ROUTINE_V1_DEF: WorkflowDefinition = WorkflowDefinitionSchema.parse(ROUTINE_V1);
