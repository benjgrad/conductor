import {
  BOARD_CARD_FIXTURE,
  BOARD_SSE_FIXTURES,
  OUTPUT_CHUNK_FIXTURE,
  WorkflowDefinitionSchema,
  type BoardCard,
  type InputRequestDto,
  type OutputChunk,
  type SessionDetail,
  type SessionStatus,
  type WorkflowDefinition,
} from '@conductor/shared';

// Seed data for the mock API, built from the frozen shared fixtures so the mock drifts with the
// contracts. Timestamps are relative to `now` so the board reads naturally in dev.

// Copies of docs/design/workflows/*.v1.json (the web tsconfig only includes src/).
export const M1_BASIC: WorkflowDefinition = WorkflowDefinitionSchema.parse({
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

export const MOCK_WORKFLOWS = [M1_BASIC, PR_FLOW];

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
    column: 'queued', // fixed up by the mock via columnFor
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
      branch: `conductor/${s.session.slice(0, 8)}`,
      output,
      ...(s.transcript
        ? {
            transcript: s.transcript.map(([stream, text], seq): OutputChunk => ({
              session_id: s.session,
              seq,
              stream,
              text,
              ts: ago(now, s.activeMinAgo + 1),
            })),
          }
        : {}),
    },
  };
}

export function mockSeeds(now: Date): MockSeed[] {
  const id = SEED_IDS;
  return [
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
    seed(now, {
      ...id.running,
      title: 'Add pagination to /orders',
      status: 'running',
      state: 'implement',
      workflow: M1_BASIC,
      ageMin: 25,
      activeMinAgo: 1,
      spend: 0.33,
      output: ['Reading src/routes/orders.ts\n', 'Editing src/routes/orders.ts\n'],
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
      // As after an orchestrator restart: the ring is empty, the history comes from the transcript.
      output: [],
      transcript: [
        ['user', '# Ticket: Rename user.fullname\n\nRename the field to `full_name` everywhere.'],
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
