import {
  BOARD_CARD_FIXTURE,
  BOARD_CARD_NEEDS_INPUT_FIXTURE,
  BOARD_CARD_PENDING_FIXTURE,
  BOARD_SSE_FIXTURES,
  CONDUCTOR_V4_DEF,
  CONDUCTOR_V2_DRAFT_DEF,
  CONDUCTOR_WORKFLOW_ID,
  diffWorkflow,
  OUTPUT_CHUNK_FIXTURE,
  SESSION_MOVES_FIXTURE,
  moveStateLabel,
  WorkflowDefinitionSchema,
  type BoardCard,
  type ChangeProposalDetail,
  type BoardChecking,
  type InputRequestDto,
  type MachineDetail,
  type MoveDto,
  type OutputChunk,
  type RepoChecksDto,
  type ScheduleDto,
  nextRuns,
  SCHEDULE_PREVIEW_RUNS,
  ROUTINE_WORKFLOW_ID,
  type SessionDetail,
  type SessionInputRequest,
  type SessionStatus,
  type WorkflowDefinition,
  humanTransitionOptions,
  sessionBranch,
} from '@conductor/shared';
import { UX2_TICKET_BODY } from '../brief/ux2-ticket.js';
import { implementerReport } from '../components/review-fixture.js';

// Seed data for the mock API, built from the frozen shared fixtures so the mock drifts with the
// contracts. Timestamps are relative to `now` so the board reads naturally in dev.

// Copies of docs/design/workflows/*.v1.json (the web tsconfig only includes src/).
export const M1_BASIC_V1: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  id: 'm1_basic',
  version: 1,
  start: 'implement',
  budget: { usd: 2, minutes: 60, max_loop_retries: 3 },
  states: {
    implement: {
      type: 'agent',
      prompt: 'ticket_template',
      tools: ['edit', 'bash', 'git'],
      timeout: '30m',
      on: { done: 'build', ask_user: 'needs_input', timeout: 'needs_input' },
    },
    build: {
      type: 'command',
      cmd: 'npm run build',
      timeout: '10m',
      on: {
        exit_0: 'test',
        fail: { goto: 'implement', attach: 'output', retries: 3, else: 'needs_input' },
      },
    },
    test: {
      type: 'command',
      cmd: 'npm test',
      timeout: '10m',
      on: {
        exit_0: 'done',
        fail: { goto: 'implement', attach: 'output', retries: 3, else: 'needs_input' },
      },
    },
    needs_input: { type: 'human' },
    done: { type: 'terminal' },
  },
});

/**
 * m1_basic v2: v1 plus an example requirements gate (ADR-0009) on implement → build. The seeded
 * sessions run this version.
 */
export const M1_BASIC: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  ...M1_BASIC_V1,
  version: 2,
  states: {
    ...M1_BASIC_V1.states,
    implement: {
      ...M1_BASIC_V1.states.implement,
      on: {
        done: {
          goto: 'build',
          requirements: {
            items: [
              'New and changed code paths have unit tests',
              'No TODO or FIXME comments in the changed files',
            ],
            on_unmet: {
              goto: 'implement',
              instruction: 'Fix the unmet requirements before anything else, then finish again.',
              retries: 2,
              else: 'needs_input',
            },
          },
        },
        ask_user: 'needs_input',
        timeout: 'needs_input',
      },
    },
  },
});

/** A trimmed pr_flow: just enough for an `await_approval` event state. */
export const PR_FLOW: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  id: 'pr_flow',
  version: 1,
  start: 'implement',
  budget: { usd: 5, minutes: 120, max_loop_retries: 3 },
  states: {
    implement: {
      type: 'agent',
      prompt: 'ticket_template',
      on: { done: 'open_pr', ask_user: 'needs_input' },
    },
    open_pr: { type: 'connector', action: 'github.open_pr', on: { done: 'await_approval' } },
    await_approval: {
      type: 'event',
      wait_for: ['pr.approved', 'ui.approve'],
      release_machine: true,
      timeout: '3d',
      on: { 'ui.approve': 'done', 'pr.approved': 'done', timeout: 'needs_input' },
    },
    needs_input: { type: 'human' },
    done: { type: 'terminal' },
  },
});

/** pr_flow v2: the full docs/design/workflows/pr_flow.v1.json (the larger diagram). */
export const PR_FLOW_FULL: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  id: 'pr_flow',
  version: 2,
  start: 'implement',
  budget: { usd: 5, minutes: 120, max_loop_retries: 3 },
  states: {
    implement: {
      type: 'agent',
      prompt: 'ticket_template',
      tools: ['edit', 'bash', 'git'],
      timeout: '60m',
      on: { done: 'build', ask_user: 'needs_input', timeout: 'needs_input' },
    },
    build: {
      type: 'command',
      cmd: 'npm run build',
      timeout: '15m',
      on: {
        exit_0: 'test',
        fail: { goto: 'implement', attach: 'output', retries: 3, else: 'needs_input' },
      },
    },
    test: {
      type: 'command',
      cmd: 'npm test',
      timeout: '20m',
      on: {
        exit_0: 'open_pr',
        fail: { goto: 'implement', attach: 'output', retries: 3, else: 'needs_input' },
      },
    },
    open_pr: {
      type: 'agent',
      skill: 'commit-push-pr',
      tools: ['git', 'pr_skill'],
      guard: 'branch_has_commits',
      result: ['pr_url'],
      on: { done: 'notify', ask_user: 'needs_input', fail: 'needs_input' },
    },
    notify: {
      type: 'agent',
      skill: 'slack-post',
      input: { pr_url: '$open_pr.pr_url', channel: '#reviews' },
      on: { done: 'await_approval', ask_user: 'needs_input' },
    },
    await_approval: {
      type: 'event',
      wait_for: ['pr.approved', 'ui.approve', 'pr.changes_requested'],
      park: true,
      release_machine: true,
      timeout: '3d',
      on: {
        'pr.approved': 'update_ticket',
        'ui.approve': 'update_ticket',
        'pr.changes_requested': 'implement',
        timeout: 'needs_input',
      },
    },
    update_ticket: {
      type: 'connector',
      actions: ['ticket.set_status:Done', 'azure.update_build'],
      idempotency: 'session+state+visit',
      on: { ok: 'jira_docs', error: 'needs_input' },
    },
    jira_docs: {
      type: 'connector',
      action: 'jira.create_task',
      args: { kind: 'docs-change' },
      idempotency: 'session+state+visit',
      on: { ok: 'done', error: 'needs_input' },
    },
    needs_input: { type: 'human' },
    done: { type: 'terminal' },
  },
});

/**
 * The one workflow (ADR-0010), v1: a mock copy of docs/design/workflows/conductor.v1.json per the
 * ADR's table. Its states are the board columns; "Waiting external" requires build + tests and
 * conductor opening the PR.
 */
export const CONDUCTOR_V1: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  id: CONDUCTOR_WORKFLOW_ID,
  version: 1,
  start: 'planning',
  budget: { usd: 5, minutes: 120, max_loop_retries: 3 },
  columns: ['planning', 'implementing', 'needs_input', 'waiting_external', 'done'],
  states: {
    planning: {
      type: 'agent',
      title: 'Planning',
      prompt: 'plan_template',
      tools: ['read'],
      result: ['plan'],
      timeout: '30m',
      on: { done: 'implementing', ask_user: 'needs_input', timeout: 'needs_input' },
    },
    implementing: {
      type: 'agent',
      title: 'Implementing',
      prompt: 'implement_template',
      tools: ['edit', 'bash', 'git'],
      input: { plan: '$planning.plan' },
      result: ['summary'],
      timeout: '60m',
      on: { done: 'waiting_external', ask_user: 'needs_input', timeout: 'needs_input' },
    },
    needs_input: { type: 'human', title: 'Needs input' },
    waiting_external: {
      type: 'event',
      title: 'Waiting external',
      wait_for: ['ui.approve'],
      entry: {
        checks: [
          { name: 'Build passes', cmd: 'npm run build' },
          { name: 'Tests pass', cmd: 'npm test' },
        ],
        actions: ['open_pr'],
        on_unmet: { goto: 'implementing', retries: 3, else: 'needs_input' },
      },
      on: { 'ui.approve': 'done' },
    },
    done: { type: 'terminal', title: 'Done' },
  },
});

/** conductor v2: v1 plus a reviewer judging two plain-language items before Waiting external. */
export const CONDUCTOR: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  ...CONDUCTOR_V1,
  version: 2,
  states: {
    ...CONDUCTOR_V1.states,
    waiting_external: {
      ...CONDUCTOR_V1.states.waiting_external,
      entry: {
        ...CONDUCTOR_V1.states.waiting_external!.entry,
        review: {
          items: ['The change does what the ticket asks', 'New code paths have unit tests'],
        },
      },
    },
  },
});

/**
 * ADR-0011: conductor v3 in the mock is the shipped transition-rules conductor, so the Workflow
 * view's arrows run with VITE_API=mock. M2-T34: the newest shipped one (`CONDUCTOR_V4_DEF`, no
 * agent `done`), since the mock's save validates it like the server (rule 17).
 */
export const CONDUCTOR_TRANSITIONS: WorkflowDefinition = { ...CONDUCTOR_V4_DEF, version: 3 };

/** The latest version of each workflow (seeded sessions pin m1_basic v2 and pr_flow v1). */
export const MOCK_WORKFLOWS = [CONDUCTOR, M1_BASIC, PR_FLOW_FULL];

/**
 * Every stored version, oldest first, per workflow id. `conductor` is the one workflow; the
 * others are old ones that finished tickets still pin (hidden in the UI).
 */
/**
 * UXR-70: who saved each `conductor` version in the mock, and its note (oldest first; the other
 * workflows' versions have none).
 */
export const MOCK_WORKFLOW_AUTHORS: Record<
  string,
  { created_by: string | null; note: string | null }[]
> = {
  [CONDUCTOR_WORKFLOW_ID]: [
    { created_by: null, note: null },
    { created_by: 'ben@example.com', note: 'Board columns: one column per state' },
    {
      created_by: 'mcp:ben@example.com',
      note: 'Transition rules: checks and conditions on arrows',
    },
  ],
};

export const MOCK_WORKFLOW_HISTORY: Record<string, WorkflowDefinition[]> = {
  [CONDUCTOR_WORKFLOW_ID]: [CONDUCTOR_V1, CONDUCTOR, CONDUCTOR_TRANSITIONS],
  m1_basic: [M1_BASIC_V1, M1_BASIC],
  pr_flow: [PR_FLOW, PR_FLOW_FULL],
};

/** Mock-side per-session state behind SessionDetail. */
export interface MockSession {
  workflow: WorkflowDefinition;
  context: SessionDetail['context'];
  return_to: string | null;
  state_entered_at: string;
  wall_seconds: number;
  branch: string | null;
  output: OutputChunk[];
  /** What GET /transcript returns (ADR-0008); absent → 404 no_transcript. */
  transcript?: OutputChunk[];
  /** SessionDetail.moves (ADR-0011), oldest first; the mock appends one per move it makes. */
  moves: MoveDto[];
  /** SessionDetail.ticket_body (UX-2); absent → as from an older server. */
  ticket_body?: string;
  /** SessionDetail.input_requests (UX-7): the answered ones; the open one is the card's. */
  input_requests?: SessionInputRequest[];
}

export interface MockSeed {
  card: BoardCard;
  session: MockSession | null;
}

const ago = (now: Date, minutes: number) =>
  new Date(now.getTime() - minutes * 60_000).toISOString();

// Fixed v4 UUIDs so tests can address seeds.
export const SEED_IDS = {
  queuedFixture: BOARD_CARD_FIXTURE.ticket_id,
  queuedUrgent: { ticket: 'a1000000-0000-4000-8000-000000000001' },
  runningSlot: {
    ticket: 'a1000000-0000-4000-8000-000000000002',
    session: OUTPUT_CHUNK_FIXTURE.session_id,
  },
  running: {
    ticket: 'a1000000-0000-4000-8000-000000000003',
    session: 'b2000000-0000-4000-8000-000000000003',
  },
  askNewer: {
    ticket: 'a1000000-0000-4000-8000-000000000004',
    session: 'b2000000-0000-4000-8000-000000000004',
    input: BOARD_SSE_FIXTURES['input.requested'].input_request_id,
  },
  askOlder: {
    ticket: 'a1000000-0000-4000-8000-000000000005',
    session: 'b2000000-0000-4000-8000-000000000005',
    input: 'c3000000-0000-4000-8000-000000000005',
  },
  approval: {
    ticket: 'a1000000-0000-4000-8000-000000000006',
    session: 'b2000000-0000-4000-8000-000000000006',
  },
  done: {
    ticket: 'a1000000-0000-4000-8000-000000000007',
    session: 'b2000000-0000-4000-8000-000000000007',
  },
  failed: {
    ticket: 'a1000000-0000-4000-8000-000000000008',
    session: 'b2000000-0000-4000-8000-000000000008',
  },
  /** ADR-0011: held in Implementing by `ready_for_testing`'s conditions (the checklist). */
  pending: {
    ticket: BOARD_CARD_PENDING_FIXTURE.ticket_id,
    // Its own session: the fixture shares OUTPUT_CHUNK_FIXTURE's (the runningSlot seed).
    session: 'b2000000-0000-4000-8000-000000000009',
  },
  /** ADR-0011: a Needs-input card with three human transition buttons. */
  transitions: {
    ticket: BOARD_CARD_NEEDS_INPUT_FIXTURE.ticket_id,
    session: BOARD_CARD_NEEDS_INPUT_FIXTURE.session_id!,
    input: BOARD_CARD_NEEDS_INPUT_FIXTURE.input_request!.id,
  },
  /** UX-4: a review request (an implementer report after `personal_pr_ready_for_review`). */
  review: {
    ticket: 'a1000000-0000-4000-8000-00000000000a',
    session: 'b2000000-0000-4000-8000-00000000000a',
    input: 'c3000000-0000-4000-8000-00000000000a',
  },
  /** UX-4: a move step whose open_pr failed. */
  stepFailed: {
    ticket: 'a1000000-0000-4000-8000-00000000000b',
    session: 'b2000000-0000-4000-8000-00000000000b',
    input: 'c3000000-0000-4000-8000-00000000000b',
  },
  /** UX-5: conductor running a move step's checks (item 3 of 5, "Unit tests"). */
  checking: {
    ticket: 'a1000000-0000-4000-8000-00000000000c',
    session: 'b2000000-0000-4000-8000-00000000000c',
  },
  /** UX-5 FR-5: a move step waiting for the machine's build slot. */
  buildSlot: {
    ticket: 'a1000000-0000-4000-8000-00000000000d',
    session: 'b2000000-0000-4000-8000-00000000000d',
  },
  /** 06 §Plan approval: a planner asking to approve its plan (`plan_needs_approval`). */
  planApproval: {
    ticket: 'a1000000-0000-4000-8000-00000000000e',
    session: 'b2000000-0000-4000-8000-00000000000e',
    input: 'c3000000-0000-4000-8000-00000000000e',
  },
} as const;

interface SeedSpec {
  ticket: string;
  session: string;
  title: string;
  status: SessionStatus;
  state: string;
  workflow: WorkflowDefinition;
  ageMin: number;
  activeMinAgo: number;
  spend: number;
  input?: Omit<InputRequestDto, 'session_id' | 'answer' | 'answered_by' | 'answered_at'>;
  returnTo?: string;
  slot?: boolean;
  context?: MockSession['context'];
  output?: string[];
  /** Claude-transcript history, as [stream, text] pairs (ADR-0008). */
  transcript?: [OutputChunk['stream'], string][];
  /** When the transcript's chunks were written, in minutes ago; default activeMinAgo + 1. */
  transcriptAt?: number;
  /** UX-2: the ticket body (the Brief); absent → as from an older server. */
  ticketBody?: string;
  /** SessionDetail.moves as [minutes ago, from, to, transition]; absent → none (UXR-88). */
  moves?: [number, string | null, string, string | null][];
}

function seed(now: Date, s: SeedSpec): MockSeed {
  const input: InputRequestDto | null = s.input
    ? { ...s.input, session_id: s.session, answer: null, answered_by: null, answered_at: null }
    : null;
  const card: BoardCard = {
    ...BOARD_CARD_FIXTURE,
    ticket_id: s.ticket,
    session_id: s.session,
    title: s.title,
    workflow_id: s.workflow.id,
    workflow_state: s.state,
    status: s.status,
    column: 'queued', // fixed up by the mock (placeCard)
    badges: s.slot ? ['waiting_for_build_slot'] : [],
    machine_id: s.status === 'waiting_external' ? null : 'mbp-ben',
    spend_usd: s.spend,
    input_request: input,
    created_at: ago(now, s.ageMin),
    updated_at: ago(now, s.activeMinAgo),
  };
  const output = (s.output ?? [OUTPUT_CHUNK_FIXTURE.text]).map((text, seq): OutputChunk => ({
    ...OUTPUT_CHUNK_FIXTURE,
    session_id: s.session,
    seq,
    text,
    ts: ago(now, s.activeMinAgo),
  }));
  return {
    card,
    session: {
      workflow: s.workflow,
      context: s.context ?? {},
      return_to: s.returnTo ?? null,
      state_entered_at: ago(now, s.activeMinAgo),
      wall_seconds: (s.ageMin - s.activeMinAgo) * 60 + 30,
      branch: sessionBranch({ title: s.title, external_ref: null }, s.session),
      output,
      moves: (s.moves ?? []).map(([min, from, to, transition]) => ({
        at: ago(now, min),
        from,
        to,
        transition,
        reason: null,
        actor:
          from === null ? null : from === 'implement' ? ('agent' as const) : ('system' as const),
      })),
      ...(s.ticketBody !== undefined ? { ticket_body: s.ticketBody } : {}),
      ...(s.transcript
        ? {
            transcript: s.transcript.map(([stream, text], seq): OutputChunk => ({
              session_id: s.session,
              seq,
              stream,
              text,
              ts: ago(now, s.transcriptAt ?? s.activeMinAgo + 1),
            })),
          }
        : {}),
    },
  };
}

/**
 * ADR-0011 seeds on conductor v2 (CONDUCTOR_V2_DRAFT_DEF), from the shared fixtures: a work card
 * held in Implementing with its "waiting for" checklist, and a personal Needs-input card with
 * its human transition buttons.
 */
function transitionSeeds(now: Date): MockSeed[] {
  const session = (over: Partial<MockSession>): MockSession => ({
    workflow: CONDUCTOR_V2_DRAFT_DEF,
    context: {},
    return_to: null,
    state_entered_at: ago(now, 10),
    wall_seconds: 900,
    branch: null,
    output: [],
    moves: [],
    ...over,
  });
  const pending = { ...BOARD_CARD_PENDING_FIXTURE, session_id: SEED_IDS.pending.session };
  const asking = BOARD_CARD_NEEDS_INPUT_FIXTURE;
  const minutesAgo = [200, 170, 140];
  return [
    {
      card: {
        ...pending,
        title: 'Ship the /health endpoint',
        created_at: ago(now, 210),
        updated_at: ago(now, 6),
      },
      session: session({
        branch: sessionBranch(
          { title: 'Ship the /health endpoint', external_ref: null },
          pending.session_id,
        ),
        state_entered_at: ago(now, 140),
        output: [{ ...OUTPUT_CHUNK_FIXTURE, session_id: pending.session_id, ts: ago(now, 141) }],
        moves: SESSION_MOVES_FIXTURE.slice(0, 3).map((m, i) => ({
          ...m,
          at: ago(now, minutesAgo[i]!),
        })),
      }),
    },
    {
      card: {
        ...asking,
        created_at: ago(now, 50),
        updated_at: ago(now, 8),
        input_request: { ...asking.input_request!, created_at: ago(now, 8) },
      },
      session: session({
        return_to: 'planning',
        state_entered_at: ago(now, 8),
        output: [
          {
            ...OUTPUT_CHUNK_FIXTURE,
            session_id: asking.session_id!,
            stream: 'assistant',
            text: 'Before I plan the beds I need one decision from you.',
            ts: ago(now, 9),
          },
        ],
        moves: [
          {
            at: ago(now, 40),
            from: null,
            to: 'planning',
            transition: null,
            reason: null,
            actor: null,
          },
          {
            at: ago(now, 8),
            from: 'planning',
            to: 'needs_input',
            transition: 'needs_product_context',
            reason: asking.input_request!.question,
            actor: 'agent',
          },
        ],
      }),
    },
  ];
}

/** UX-4: a finished agent's report, opened by `personal_pr_ready_for_review`, with its PR. */
function reviewSeed(now: Date): MockSeed {
  const id = SEED_IDS.review;
  const base = seed(now, {
    ...id,
    title: 'Board cards: review requests vs questions',
    status: 'needs_input',
    state: 'needs_input',
    workflow: CONDUCTOR_V2_DRAFT_DEF,
    ageMin: 95,
    activeMinAgo: 19,
    spend: 2.4,
    returnTo: 'implementing',
    input: {
      id: id.input,
      kind: 'agent_question',
      question: implementerReport(40),
      created_at: ago(now, 19),
      origin_transition: 'personal_pr_ready_for_review',
      step_failed: false,
    },
  });
  return {
    card: {
      ...base.card,
      kind: 'personal',
      pr_url: 'https://github.com/benjgrad/conductor/pull/42',
      // UXR-36: the workflow's buttons, so the review shows Approve (its `done`).
      human_transitions: humanTransitionOptions(
        CONDUCTOR_V2_DRAFT_DEF,
        'needs_input',
        'personal',
        'implementing',
      ),
    },
    session: {
      ...base.session!,
      context: {
        __pr: { pr_url: 'https://github.com/benjgrad/conductor/pull/42' },
        // 06 §Proposed tickets: follow-ups the implementer noticed (and one malformed, dropped).
        implementing: {
          summary: 'Review requests and questions now look different on the board.',
          proposed_tickets: MOCK_PROPOSED_TICKETS,
        },
      },
    },
  };
}

/** The review seed's proposed follow-up tickets (the third is malformed: dropped). */
export const MOCK_PROPOSED_TICKETS = [
  {
    title: 'Group review requests by repo',
    repo: 'github.com/benjgrad/conductor',
    why: 'With several PRs waiting, the Needs input column gets long; grouping would help.',
  },
  {
    title: 'Show the PR check status on review cards',
    repo: 'github.com/benjgrad/conductor',
    why: 'Reviewers open the PR just to see whether CI passed.',
  },
  { title: 'no why or repo' },
];

/** A planner's plan, long enough to clamp: a table, steps and risks (06 §Plan approval). */
export const MOCK_PLAN = `# Plan: rate limiting on /login

## Approach
Add a fixed-window limiter in front of the login route, keyed by client IP and by account.

| File | Change |
|---|---|
| \`src/middleware/rate-limit.ts\` | New: a fixed-window limiter backed by Redis |
| \`src/routes/login.ts\` | Mount the limiter before the handler |
| \`src/config.ts\` | \`LOGIN_LIMIT_PER_MIN\` (default 10) |

## Steps
1. Write the limiter as a pure function over a store interface, plus the Redis store.
2. Mount it on \`POST /login\` only; other routes keep their current behaviour.
3. Return 429 with a \`Retry-After\` header when the window is full.
4. Log each block at \`warn\` with the key, never the password.

## Tests
- Unit: the window resets, the per-account and per-IP keys are independent.
- Route: the 11th attempt in a minute gets 429 and \`Retry-After\`.

## Risks
- Behind the load balancer the client IP is in \`X-Forwarded-For\`; trust it only from the proxy.
- Redis down: fail open (log an error), so logins keep working.
`;

/** 06 §Plan approval: the planner asks to approve its plan (`plan_needs_approval`). */
function planApprovalSeed(now: Date): MockSeed {
  const id = SEED_IDS.planApproval;
  const base = seed(now, {
    ...id,
    title: 'Add rate limiting to /login',
    status: 'needs_input',
    state: 'needs_input',
    workflow: CONDUCTOR_V2_DRAFT_DEF,
    ageMin: 35,
    activeMinAgo: 3,
    spend: 0.58,
    returnTo: 'planning',
    context: { planning: { plan: MOCK_PLAN } },
    ticketBody: UX2_TICKET_BODY,
    input: {
      id: id.input,
      kind: 'agent_question',
      question: 'The plan is ready. Approve it, or tell me what to change.',
      created_at: ago(now, 3),
      origin_transition: 'plan_needs_approval',
      step_failed: false,
    },
    output: [
      'Reading src/routes/login.ts\n',
      'Reading src/middleware/index.ts\n',
      'The login route has no limiter today; I will add one in front of it.\n',
    ],
  });
  // The seeds keep the fixture's buttons; this one needs the workflow's, for the $return_to answer.
  const card = { ...base.card, kind: 'personal' as const };
  return {
    ...base,
    card: {
      ...card,
      human_transitions: humanTransitionOptions(
        CONDUCTOR_V2_DRAFT_DEF,
        'needs_input',
        card.kind,
        'planning',
      ),
    },
  };
}

/**
 * UX-5: `card.checking` of a `personal_pr_ready_for_review` step at item `current` (0-based).
 * UXR-75: `source` says whose checks they are (the demo card's repo has an override).
 */
export function mockChecking(
  current: number,
  source: BoardChecking['checks_source'] = 'workflow',
): BoardChecking {
  const labels = ['Typecheck', 'Lint', 'Unit tests', 'Build passes', 'PR opened'];
  return {
    to: 'needs_input',
    title: 'Needs input',
    phase: current < 4 ? 'checks' : 'actions',
    label: 'Checks before PR ready for review',
    transition: 'personal_pr_ready_for_review',
    items: labels.map((label, i) => ({
      label,
      kind: i < 4 ? 'check' : 'action',
      status: i < current ? 'passed' : i === current ? 'running' : 'todo',
      detail: null,
    })),
    current,
    checks_source: source,
  };
}

/** UX-6: a step's check output: the daemon's debug marker before each run, then its output. */
function checkOutput(sessionId: string, ts: string): OutputChunk[] {
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const chunks: [OutputChunk['stream'], string][] = [
    ['debug', `conductor: setup \`npm ci\` in a fresh checkout of ${sha}`],
    [
      'stdout',
      'Scope: all 5 workspace projects\nProgress: resolved 453, reused 453, downloaded 0\n',
    ],
    ['stderr', ' WARN  Failed to create bin at node_modules/.bin/tsc\n'],
    ['stdout', 'Done in 3.2s\n'],
    ['debug', `conductor: \`npm run build\` in a fresh checkout of ${sha}`],
    ['stdout', '\n> conductor@ build\n> tsc -b && vite build\n\n'],
  ];
  return chunks.map(([stream, text], seq) => ({ session_id: sessionId, seq, stream, text, ts }));
}

/** UX-5: conductor running a move step (the agent took `personal_pr_ready_for_review` and exited). */
function checkingSeeds(now: Date): MockSeed[] {
  const state = moveStateLabel('implementing', 'needs_input', 'personal_pr_ready_for_review');
  const step = (s: MockSeed, slot: boolean): MockSeed => ({
    ...s,
    // UX-6: the move into the step, and the step's check output as the daemon streams it.
    session: {
      ...s.session!,
      moves: [
        {
          at: ago(now, 180),
          from: null,
          to: 'implementing',
          transition: null,
          reason: null,
          actor: null,
        },
        {
          at: ago(now, 2),
          from: 'implementing',
          to: state,
          transition: 'personal_pr_ready_for_review',
          reason: 'Implemented and tested.',
          actor: 'agent',
        },
      ],
      output: slot ? [] : checkOutput(s.card.session_id!, ago(now, 1)),
    },
    card: {
      ...s.card,
      kind: 'personal',
      badges: slot ? ['waiting_for_build_slot', 'checking'] : ['checking'],
      // UXR-75: the demo card's repo has the seeded override (mockRepoChecks), so its checks
      // are the repo's; the build-slot card runs the workflow's.
      ...(slot ? {} : { repo: 'github.com/acme/shop' }),
      checking: mockChecking(slot ? 0 : 2, slot ? 'workflow' : 'repo'),
    },
  });
  const spec = {
    status: 'running' as const,
    state,
    workflow: CONDUCTOR_V2_DRAFT_DEF,
    ageMin: 180,
    spend: 2.1,
  };
  return [
    step(
      seed(now, { ...SEED_IDS.checking, ...spec, title: 'Conductor checks demo', activeMinAgo: 1 }),
      false,
    ),
    step(
      seed(now, {
        ...SEED_IDS.buildSlot,
        ...spec,
        title: 'Waiting for a build slot',
        activeMinAgo: 2,
      }),
      true,
    ),
  ];
}

/** M2-T11: a seed whose session changed `.git` in a checkout-mode repo (an open machine alert). */
function withAlert(now: Date, s: SeedSpec): MockSeed {
  const out = seed(now, s);
  return {
    ...out,
    card: {
      ...out.card,
      alerts: [{ kind: 'git_tamper', files: ['.git/hooks/pre-commit'], at: ago(now, 1) }],
    },
  };
}

export function mockSeeds(now: Date): MockSeed[] {
  const id = SEED_IDS;
  return [
    ...transitionSeeds(now),
    ...checkingSeeds(now),
    {
      card: { ...BOARD_CARD_FIXTURE, created_at: ago(now, 3), updated_at: ago(now, 3) },
      session: null,
    },
    {
      card: {
        ...BOARD_CARD_FIXTURE,
        ticket_id: id.queuedUrgent.ticket,
        title: 'Hotfix: crash on empty cart',
        priority: 5,
        external_ref: 'GH-412',
        created_at: ago(now, 1),
        updated_at: ago(now, 1),
        // M2-T11: no online machine can take it (ADR-0013 §Routing).
        routing: {
          missing_repo: 'github.com/acme/shop',
          missing_capabilities: ['cli:az:authed'],
        },
      },
      session: null,
    },
    seed(now, {
      ...id.runningSlot,
      title: 'Migrate settings page to new form lib',
      status: 'running',
      state: 'build',
      workflow: M1_BASIC,
      ageMin: 40,
      activeMinAgo: 2,
      spend: 0.61,
      slot: true,
      output: ['> npm run build\n', 'waiting for a build slot (2/2 in use)…\n'],
    }),
    withAlert(now, {
      ...id.running,
      title: 'Add pagination to /orders',
      status: 'running',
      state: 'implement',
      workflow: M1_BASIC,
      ageMin: 25,
      activeMinAgo: 1,
      spend: 0.33,
      output: ['Reading src/routes/orders.ts\n', 'Editing src/routes/orders.ts\n'],
      ticketBody: UX2_TICKET_BODY,
    }),
    seed(now, {
      ...id.askNewer,
      title: 'Add audit log table',
      status: 'needs_input',
      state: 'needs_input',
      workflow: M1_BASIC,
      ageMin: 30,
      activeMinAgo: 4,
      spend: 0.42,
      returnTo: 'implement',
      input: {
        id: id.askNewer.input,
        kind: BOARD_SSE_FIXTURES['input.requested'].kind,
        question: BOARD_SSE_FIXTURES['input.requested'].question,
        created_at: ago(now, 4),
        // Questions UX: the agent's choices, clickable on the card and in the panel.
        options: {
          multi_select: false,
          items: [
            { label: 'Postgres', description: 'Recommended: the app already uses it' },
            { label: 'SQLite', description: 'A local file; no server' },
            { label: 'MySQL' },
          ],
        },
      },
    }),
    seed(now, {
      ...id.askOlder,
      title: 'Fix flaky checkout test',
      status: 'needs_input',
      state: 'needs_input',
      workflow: M1_BASIC,
      ageMin: 90,
      activeMinAgo: 20,
      spend: 1.12,
      returnTo: 'test',
      input: {
        id: id.askOlder.input,
        kind: 'retries_exhausted',
        question: 'Tests failed 3 times. Last output attached. Retry, skip, or abort?',
        created_at: ago(now, 20),
      },
      output: ['> npm test\n', 'FAIL checkout.spec.ts › applies coupon\n', 'Tests: 1 failed\n'],
    }),
    reviewSeed(now),
    planApprovalSeed(now),
    seed(now, {
      ...id.stepFailed,
      title: 'Add CSV export',
      status: 'needs_input',
      state: 'needs_input',
      workflow: CONDUCTOR_V2_DRAFT_DEF,
      ageMin: 120,
      activeMinAgo: 12,
      spend: 0.8,
      returnTo: 'implementing',
      input: {
        id: id.stepFailed.input,
        kind: 'retries_exhausted',
        question:
          'Conductor could not PR opened to enter "Needs input": gh: GraphQL: No commits between main and conductor/b2000000 (createPullRequest). Retry, skip, or abort?',
        created_at: ago(now, 12),
        origin_transition: null,
        step_failed: true,
      },
    }),
    seed(now, {
      ...id.approval,
      title: 'Bump node to 22 in CI',
      status: 'waiting_external',
      state: 'await_approval',
      workflow: PR_FLOW,
      ageMin: 300,
      activeMinAgo: 60,
      spend: 0.9,
      context: { open_pr: { pr_url: 'https://github.com/benjgrad/fixture-app/pull/7' } },
    }),
    seed(now, {
      ...id.done,
      title: 'Rename user.fullname',
      status: 'done',
      state: 'done',
      workflow: M1_BASIC,
      ageMin: 600,
      activeMinAgo: 500,
      spend: 0.27,
      // UXR-88: the Steps section (Details tab) reads these.
      moves: [
        [600, null, 'implement', null],
        [520, 'implement', 'build', 'done'],
        [512, 'build', 'test', 'exit_0'],
        [500, 'test', 'done', 'exit_0'],
      ],
      context: {
        implement: {
          summary: 'Renamed `user.fullname` to `full_name` in 2 files.',
          files: ['src/models/user.ts', 'src/api/users.ts'],
        },
      },
      transcriptAt: 530,
      // As after an orchestrator restart: the ring is empty, the history comes from the transcript.
      output: [],
      transcript: [
        [
          'user',
          `# Ticket: Rename user.fullname\n\nRename the field to \`full_name\` everywhere.\n\nRepository: ${BOARD_CARD_FIXTURE.repo}`,
        ],
        ['assistant', 'Renaming `fullname` to `full_name` in the model and its callers.'],
        ['tool_use', 'Bash {"command":"grep -rn fullname src"}'],
        [
          'tool_result',
          'src/models/user.ts:12:  fullname: string;\nsrc/api/users.ts:40:  user.fullname',
        ],
        ['tool_use', 'mcp__conductor__complete_state {"result":{"summary":"Renamed in 2 files"}}'],
        ['tool_result', 'Recorded. Stop now: do not call any other tool and end your turn.'],
        ['assistant', 'Renamed the field in 2 files and committed.'],
      ],
    }),
    seed(now, {
      ...id.failed,
      title: 'Upgrade webpack',
      status: 'lost',
      state: 'build',
      workflow: M1_BASIC,
      ageMin: 700,
      activeMinAgo: 650,
      spend: 1.9,
    }),
  ];
}

/**
 * ADR-0030: one repo with its own checks (a pnpm repo the workflow's `npm` defaults don't fit),
 * so the Repo checks page has a row in dev.
 */
export function mockRepoChecks(now: Date): RepoChecksDto[] {
  return [
    {
      repo: 'github.com/acme/shop',
      setup: 'pnpm install --frozen-lockfile',
      checks: [
        { name: 'Build', cmd: 'pnpm build' },
        { name: 'Tests', cmd: 'pnpm test', timeout: '10m' },
      ],
      updated_at: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
      updated_by: 'ben@example.com',
    },
  ];
}

/**
 * UXR-73: the open workflow proposal's change to the latest mock `conductor`: a column renamed, and
 * a check and a condition added to Implementing → Waiting external.
 */
export function proposedConductor(): WorkflowDefinition {
  const def = structuredClone(CONDUCTOR_TRANSITIONS);
  def.states.waiting_external!.title = 'Waiting on review';
  const s = def.states.implementing!;
  if (s.type !== 'terminal') {
    const t = s.on!.ready_for_testing!;
    if (typeof t !== 'string') {
      t.requires = {
        ...t.requires,
        checks: [...(t.requires?.checks ?? []), { name: 'Typecheck', cmd: 'pnpm typecheck' }],
        conditions: [
          ...(t.requires?.conditions ?? []),
          { type: 'pr_screenshots', ui_paths: ['packages/web/**'] },
        ],
      };
    }
  }
  return def;
}

/** UXR-73: the applied proposal's change (planning retitled), from the version before it. */
function retitledPlanning(): WorkflowDefinition {
  const def = structuredClone(CONDUCTOR);
  def.states.planning!.title = 'Plan it';
  return def;
}

/**
 * ADR-0033 P3: the workflow advisor's proposals in the mock: an open workflow change (UXR-73), an
 * open repo-checks change, and an applied workflow change with its review. Each carries its whole
 * change (the REST detail's bodies) for the readable diff.
 */
export function mockChangeProposals(now: Date): ChangeProposalDetail[] {
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const proposed = proposedConductor();
  const openDiff = diffWorkflow(CONDUCTOR_TRANSITIONS, proposed);
  return [
    {
      id: '7a1c0e52-5f3b-4c1e-9d2a-0b6f1e2a3c03',
      kind: 'workflow',
      status: 'proposed',
      title: 'Typecheck before testing, and ask for UI screenshots',
      target: CONDUCTOR_WORKFLOW_ID,
      requires_admin: true,
      changes: openDiff.length,
      expected_effect: 'Fewer tickets sent back from testing.',
      created_at: ago(0.1),
      applied_at: null,
      rationale:
        'Half the tickets sent back from Waiting external failed a typecheck, and UI changes ' +
        'came without screenshots.',
      evidence: [
        { finding_id: 'reentries:implementing', text: '6 of 12 tickets came back to Implementing' },
      ],
      effect: {
        metric: 'reentries',
        scope: { state: 'implementing' },
        direction: 'down',
        text: 'Fewer tickets sent back from testing.',
      },
      rollback: 'Save v3 again.',
      diff: { changes: openDiff, more_changes: 0 },
      base_version: 3,
      created_by: 'mcp:ben@example.com',
      decided_by: null,
      decided_at: null,
      applied_version: null,
      error: null,
      review: null,
      warning:
        'Workflows are shared by every account on this instance: applying this changes the ' +
        'workflow for all of them, and only an instance admin can apply it.',
      base_definition: CONDUCTOR_TRANSITIONS,
      proposed_definition: proposed,
    },
    {
      id: '7a1c0e52-5f3b-4c1e-9d2a-0b6f1e2a3c01',
      kind: 'repo_checks',
      status: 'proposed',
      title: 'Build the web app inside m-one',
      target: 'github.com/acme/api',
      requires_admin: false,
      changes: 2,
      expected_effect: 'The build check stops failing on every ticket.',
      created_at: ago(0.2),
      applied_at: null,
      rationale:
        'The repo has no package.json at its root, so the default `npm run build` fails before ' +
        'any work is checked.',
      evidence: [
        { finding_id: 'failing_check:npm run build', text: '6 of 6 runs failed in 30 days' },
      ],
      effect: {
        metric: 'check_failure_rate',
        scope: { check: 'npm run build' },
        direction: 'down',
        text: 'The build check stops failing on every ticket.',
      },
      rollback: 'Clear the repo’s checks: tickets run the workflow’s default checks again.',
      diff: {
        changes: [
          {
            op: 'add',
            path: 'checks.Web build',
            after: { name: 'Web build', cmd: 'cd m-one && npm ci && npm run build' },
          },
          {
            op: 'add',
            path: 'override',
            after: { checks: [{ name: 'Web build', cmd: 'cd m-one && npm ci && npm run build' }] },
          },
        ],
        more_changes: 0,
      },
      base_version: null,
      created_by: 'mcp:ben@example.com',
      decided_by: null,
      decided_at: null,
      applied_version: null,
      error: null,
      review: null,
      warning: null,
      checks_before: null,
      checks_after: { checks: [{ name: 'Web build', cmd: 'cd m-one && npm ci && npm run build' }] },
    },
    {
      id: '7a1c0e52-5f3b-4c1e-9d2a-0b6f1e2a3c02',
      kind: 'workflow',
      status: 'applied',
      title: 'Give planning a clearer title',
      target: CONDUCTOR_WORKFLOW_ID,
      requires_admin: true,
      changes: 1,
      expected_effect: 'Fewer questions while planning.',
      created_at: ago(9),
      applied_at: ago(8),
      rationale: 'Agents asked what “plan” meant in 4 of 10 tickets.',
      evidence: [
        { finding_id: 'frequent_question:planning', text: 'Questions in 40 % of tickets' },
      ],
      effect: {
        metric: 'questions',
        scope: { state: 'planning' },
        direction: 'down',
        text: 'Fewer questions while planning.',
      },
      rollback: 'Save the previous version again (get_workflow version 2).',
      diff: {
        changes: [
          { op: 'change', path: 'states.planning.title', before: 'Planning', after: 'Plan it' },
        ],
        more_changes: 0,
      },
      base_version: 2,
      created_by: 'mcp:ben@example.com',
      decided_by: 'ben@example.com',
      decided_at: ago(8),
      applied_version: 3,
      error: null,
      review: {
        metric: 'questions',
        scope: { state: 'planning' },
        direction: 'down',
        window_days: 8,
        before: { value: 0.4, sample: 10 },
        after: { value: 0.1, sample: 10 },
        delta: -0.3,
        direction_met: true,
        too_early: false,
        reviewed_at: ago(0.5),
      },
      warning:
        'Workflows are shared by every account on this instance: applying this changes the ' +
        'workflow for all of them, and only an instance admin can apply it.',
      base_definition: CONDUCTOR,
      proposed_definition: retitledPlanning(),
    },
  ];
}

/**
 * M2-T11: the mock's machines. `mbp-ben` (the cards' machine) is online with an open `.git`
 * alert; `linux-box` is offline, runs an outdated daemon, and has a gh too old for open_pr.
 * running_sessions and live_sessions are filled from the cards by the mock.
 */
export function mockMachines(now: Date): MachineDetail[] {
  return [
    {
      id: 'mbp-ben',
      hostname: 'bens-macbook-pro.local',
      name: "Ben's MacBook",
      status: 'online',
      tags: ['macos', 'arm64'],
      last_heartbeat_at: now.toISOString(),
      max_sessions: 3,
      running_sessions: 0,
      cpu_free: 0.62,
      mem_free_mb: 9_400,
      daemon_version: '0.3.0+5c1d2e0',
      claude_version: '2.1.0',
      outdated: false,
      repo_count: 2,
      revoked_at: null,
      repo_allow: null,
      repo_exclusive: [],
      upgrade_command: null,
      upgrade_command_windows: null,
      git_identity_missing: false,
      os: 'darwin',
      arch: 'arm64',
      repos: [
        {
          remote: 'github.com/acme/shop',
          path: '/Users/ben/code/shop',
          mode: 'reference',
          default_branch: 'main',
        },
        {
          remote: 'github.com/benjgrad/conductor',
          path: '/Users/ben/code/conductor',
          mode: 'checkout',
          default_branch: 'main',
        },
      ],
      capabilities: {
        cli: [
          { name: 'gh', version: '2.62.0', authed: true, repo: null },
          { name: 'git', version: '2.47.1', authed: false, repo: null },
        ],
        mcp: [{ name: 'slack', version: null, authed: null, repo: null }],
        skill: [{ name: 'pr', version: null, authed: null, repo: 'github.com/benjgrad/conductor' }],
        agent: [],
        claude: [{ name: 'claude', version: '2.1.0', authed: null, repo: null }],
      },
      alerts: [
        {
          id: 'd4000000-0000-4000-8000-000000000001',
          kind: 'git_tamper',
          repo: 'github.com/benjgrad/conductor',
          session_id: SEED_IDS.running.session,
          files: ['.git/hooks/pre-commit'],
          created_at: ago(now, 1),
        },
      ],
      live_sessions: [],
      // M2-T16a: the Queued hotfix needs a repo and az, which this machine lacks.
      cannot_take: [
        {
          ticket_id: SEED_IDS.queuedUrgent.ticket,
          title: 'Hotfix: crash on empty cart',
          missing_repo: 'github.com/acme/shop',
          missing_capabilities: ['cli:az:authed'],
        },
      ],
    },
    {
      id: 'linux-box',
      hostname: 'old-linux-box',
      name: 'old-linux-box',
      status: 'offline',
      tags: ['linux', 'x64'],
      last_heartbeat_at: ago(now, 3 * 24 * 60),
      max_sessions: 1,
      running_sessions: 0,
      cpu_free: null,
      mem_free_mb: null,
      daemon_version: '0.1.0+2e88cf8',
      claude_version: '2.0.14',
      outdated: true,
      repo_count: 1,
      revoked_at: null,
      repo_allow: null,
      repo_exclusive: [],
      // Stopgap until ADR-0021 auto-update: the server sends these for an outdated machine.
      upgrade_command: 'curl -fsSL http://localhost/install.sh | sh',
      upgrade_command_windows: 'irm http://localhost/install.ps1 | iex',
      // WF-T02: shows the Machines page's git identity warning.
      git_identity_missing: true,
      os: 'linux',
      arch: 'x64',
      repos: [{ remote: null, path: '/home/ben/scratch', mode: 'reference', default_branch: null }],
      capabilities: {
        cli: [{ name: 'gh', version: '2.14.0', authed: true, repo: null }],
        mcp: [],
        skill: [],
        agent: [],
        claude: [{ name: 'claude', version: '2.0.14', authed: null, repo: null }],
      },
      alerts: [],
      live_sessions: [],
      cannot_take: [],
    },
  ];
}

/** ADR-0032: fixed schedule ids, so tests and screenshots can address them. */
export const SCHEDULE_IDS = {
  prSweep: 'e5000000-0000-4000-8000-000000000001',
  weekly: 'e5000000-0000-4000-8000-000000000002',
  monthly: 'e5000000-0000-4000-8000-000000000003',
} as const;

/**
 * ADR-0032: three recurring jobs for the Schedules page. "PR sweep" runs on weekdays and its last
 * run (the running seed) is still open, so its last due run was skipped and Run now is refused;
 * the weekly one is paused and pinned to a machine; the monthly one never ran and no machine has
 * its repo.
 */
export function mockSchedules(now: Date): ScheduleDto[] {
  const day = 86_400_000;
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
  const runs = (cron: string, tz: string) =>
    nextRuns(cron, tz, now, SCHEDULE_PREVIEW_RUNS).map((d) => d.toISOString());
  const base = {
    workflow_id: ROUTINE_WORKFLOW_ID,
    priority: 0,
    created_by: 'ben@example.com',
    created_at: at(-30 * day),
    updated_at: at(-2 * day),
    last_skipped_at: null,
    last_skip_reason: null,
  } as const;
  const sweep = runs('0 9 * * 1-5', 'America/Toronto');
  const monthly = runs('0 10 1 * *', 'Europe/London');
  return [
    {
      ...base,
      id: SCHEDULE_IDS.prSweep,
      name: 'PR sweep',
      cron: '0 9 * * 1-5',
      timezone: 'America/Toronto',
      enabled: true,
      title: 'Sweep open PRs',
      body: 'Go through the open PRs on the repo. Rebase the stale ones and list what needs review.',
      repo: 'github.com/benjgrad/conductor',
      kind: 'work',
      required_tags: [],
      machine_ids: null,
      next_run_at: sweep[0] ?? null,
      next_runs: sweep,
      last_run_at: at(-day),
      last_ticket: { id: SEED_IDS.running.ticket, status: 'in_progress' },
      last_skipped_at: at(-60 * 60_000),
      last_skip_reason: 'previous_run_open',
    },
    {
      ...base,
      id: SCHEDULE_IDS.weekly,
      name: 'Weekly dependency bump',
      cron: '30 8 * * 1',
      timezone: 'UTC',
      enabled: false,
      title: 'Bump dependencies',
      body: 'Update the dependencies one minor version at a time and open a PR.',
      repo: 'github.com/acme/shop',
      kind: 'work',
      required_tags: [],
      machine_ids: ['mbp-ben'],
      next_run_at: null,
      next_runs: [],
      last_run_at: at(-9 * day),
      last_ticket: { id: SEED_IDS.done.ticket, status: 'done' },
    },
    {
      ...base,
      id: SCHEDULE_IDS.monthly,
      name: 'Monthly report',
      cron: '0 10 1 * *',
      timezone: 'Europe/London',
      enabled: true,
      title: 'Write the monthly spend report',
      body: 'Summarise last month: tickets done, time per state and spend.',
      repo: 'github.com/ben/notes',
      kind: 'personal',
      required_tags: [],
      machine_ids: null,
      next_run_at: monthly[0] ?? null,
      next_runs: monthly,
      last_run_at: null,
      last_ticket: null,
      warnings: ['no_machine_has_repo'],
    },
  ];
}
