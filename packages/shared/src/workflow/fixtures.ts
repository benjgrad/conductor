import { CONDUCTOR_V1 } from './conductor.js';
import {
  RETURN_TO,
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
} from './schema.js';

// ADR-0011 (M1b-T01): a DRAFT of `conductor` v2 that groups B–C code against before T09 ships
// the real one (docs/design/workflows/conductor.v2.json + CONDUCTOR_V2). Non-normative: T09 may
// change wording, checks and timeouts; names, actors, kinds and targets follow ADR-0011 §Default
// conductor v2. It covers every new shape: agent `question` transitions, kind filters, `requires`
// with checks + actions + conditions (incl. disabled M5 ones), human transitions with RETURN_TO,
// an event-state human transition, and the `ask_user` / `timeout` fallbacks.
// Before T02 lands, the M1 validator rejects RETURN_TO (rule 1); the schema parses it.

const ON_UNMET = {
  goto: 'implementing',
  instruction: 'Fix what is listed above, commit, then finish the step again.',
  retries: 3,
  else: 'needs_input',
} as const;

const BUILD_AND_TEST = [
  { name: 'Build passes', cmd: 'npm run build', timeout: '10m' },
  { name: 'Tests pass', cmd: 'npm test', timeout: '10m' },
];

export const CONDUCTOR_V2_DRAFT: WorkflowDefinitionInput = {
  id: CONDUCTOR_V1.id,
  version: 2,
  start: 'planning',
  budget: { usd: 5, minutes: 120, max_loop_retries: 3 },
  on_budget_exceeded: 'needs_input',
  columns: ['planning', 'implementing', 'needs_input', 'waiting_external', 'done'],
  states: {
    planning: {
      type: 'agent',
      title: 'Planning',
      prompt: 'plan_template',
      tools: ['read'],
      result: ['plan', 'summary'],
      timeout: '20m',
      on: {
        plan_ready: {
          goto: 'implementing',
          title: 'Plan ready',
          when: 'The plan is complete and needs no decision from a human.',
        },
        scope_changed: {
          goto: 'needs_input',
          title: 'Scope changed',
          when: 'A new dependency or finding changes the scope of the ticket.',
          question: true,
        },
        plan_needs_approval: {
          goto: 'needs_input',
          title: 'Plan needs approval',
          when: 'The plan is ready but a human must approve it before implementation.',
          question: true,
        },
        needs_product_context: {
          goto: 'needs_input',
          title: 'Needs product context',
          when: 'You need more product context to plan the work.',
          question: true,
        },
        impossible: {
          goto: 'needs_input',
          title: 'Impossible',
          when: 'The work cannot be done as asked.',
          question: true,
        },
        ask_user: 'needs_input',
        timeout: 'needs_input',
      },
    },
    implementing: {
      type: 'agent',
      title: 'Implementing',
      prompt: 'implement_template',
      tools: ['edit', 'bash', 'git'],
      input: { plan: '$planning.plan' },
      timeout: '30m',
      on: {
        needs_approval_to_message: {
          goto: 'needs_input',
          title: 'Approve a message',
          when: 'You are about to message a person and need approval of the text first.',
          question: true,
        },
        pr_ready_for_review: {
          goto: 'needs_input',
          title: 'PR ready for review',
          when: 'The work is done and you want the user to review the PR.',
          question: true,
          requires: { checks: [BUILD_AND_TEST[1]!], actions: ['open_pr'] },
          on_unmet: { ...ON_UNMET },
        },
        ready_for_testing: {
          goto: 'waiting_external',
          title: 'Ready for testing',
          when: 'The work is complete and should go to testing.',
          kinds: ['work'],
          requires: {
            checks: BUILD_AND_TEST,
            actions: ['open_pr'],
            conditions: [
              { type: 'pr_checks_green' },
              { type: 'pr_approvals', min: 1 },
              { type: 'jira_fields_set', fields: ['resolution'], enabled: false },
              { type: 'azure_pipeline_succeeded', pipeline: 'ci', enabled: false },
            ],
            condition_timeout: '3d',
            condition_poll: '2m',
          },
          on_unmet: { ...ON_UNMET },
        },
        done: {
          goto: 'done',
          title: 'Done',
          when: 'The work is complete.',
          kinds: ['personal'],
          requires: { checks: BUILD_AND_TEST, actions: ['open_pr'] },
          on_unmet: { ...ON_UNMET },
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
        waiting_on_someone: {
          goto: 'waiting_external',
          title: 'Waiting on someone else',
          actor: 'human',
        },
        done: { goto: 'done', title: 'Done', actor: 'human' },
      },
    },
    waiting_external: {
      type: 'event',
      title: 'Waiting external',
      wait_for: ['ui.approve'],
      on: {
        'ui.approve': { goto: 'done', title: 'Approved' },
        back_to_implementing: {
          goto: 'implementing',
          title: 'Back to Implementing',
          actor: 'human',
        },
      },
    },
    done: { type: 'terminal', title: 'Done' },
  },
};

/** CONDUCTOR_V2_DRAFT parsed (defaults applied). */
export const CONDUCTOR_V2_DRAFT_DEF: WorkflowDefinition =
  WorkflowDefinitionSchema.parse(CONDUCTOR_V2_DRAFT);
