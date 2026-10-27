import { describe, expect, it } from 'vitest';
import type { TicketStatus } from '../domain.js';
import { PR_CONTEXT_KEY, REVIEW_CONTEXT_KEY, STEP_CONTEXT_KEY } from '../engine/review.js';
import { APPLY_REJECT_REASONS } from '../engine/types.js';
import { boardColumns, CONDUCTOR_V1_DEF } from '../workflow/conductor.js';
import { WorkflowDefinitionSchema } from '../workflow/schema.js';
import {
  BOARD_CARD_ALERT_FIXTURE,
  BOARD_CARD_FIXTURE,
  BOARD_CARD_ROUTING_FIXTURE,
} from './fixtures.js';
import {
  API_PATHS,
  APPLY_REJECT_HTTP,
  ApproveSessionRequestSchema,
  BoardCardSchema,
  conductorPort,
  DEFAULT_CONDUCTOR_PORT,
  httpForApplyResult,
  toBoardCard,
  toInputRequestDto,
  type CardView,
} from './rest.js';

const ticket = {
  id: BOARD_CARD_FIXTURE.ticket_id,
  status: 'in_progress' as TicketStatus,
  title: 'Add /health',
  external_ref: null,
  repo: 'github.com/benjgrad/fixture-app',
  priority: 0,
  workflow_id: 'conductor',
  created_at: new Date('2026-10-22T12:00:00.000Z'),
  updated_at: new Date('2026-10-22T12:00:00.000Z'),
};
const session = {
  id: '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f',
  workflow_state: 'needs_input' as string | null,
  status: 'needs_input' as const,
  machine_id: 'mbp-ben',
  spend_usd: '0.4200',
  waiting_for_build_slot: false,
  context: {} as Record<string, unknown>,
  updated_at: new Date('2026-10-22T12:05:00.000Z'),
};
const input = {
  id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  session_id: session.id,
  kind: 'agent_question' as const,
  question: 'Which DB?',
  answer: null,
  answered_by: null,
  created_at: new Date('2026-10-22T12:04:00.000Z'),
  answered_at: null,
};

/** The board of conductor v1, for a session pinned to conductor v1. */
const VIEW: CardView = { columns: boardColumns(CONDUCTOR_V1_DEF), def: CONDUCTOR_V1_DEF };

/** An old m1_basic-shaped definition (no columns): implement → build → test → done. */
const M1 = WorkflowDefinitionSchema.parse({
  id: 'm1_basic',
  version: 1,
  start: 'implement',
  budget: { usd: 1, minutes: 10, max_loop_retries: 1 },
  states: {
    implement: { type: 'agent', prompt: 'ticket_template', on: { done: 'build' } },
    build: { type: 'command', cmd: 'npm run build', on: { exit_0: 'wait' } },
    wait: { type: 'event', wait_for: ['ui.approve'], on: { 'ui.approve': 'done' } },
    needs_input: { type: 'human' },
    done: { type: 'terminal' },
  },
});
const OLD_VIEW: CardView = { columns: boardColumns(CONDUCTOR_V1_DEF), def: M1 };

describe('toBoardCard / toInputRequestDto', () => {
  it('a sessionless ticket equals BOARD_CARD_FIXTURE', () => {
    expect(toBoardCard({ ...ticket, status: 'ready' }, null, null, VIEW)).toEqual(
      BOARD_CARD_FIXTURE,
    );
  });

  it('derives column, spend (numeric string), open input and the latest updated_at', () => {
    const card = BoardCardSchema.parse(toBoardCard(ticket, session, input, VIEW));
    expect(card).toMatchObject({
      session_id: session.id,
      status: 'needs_input',
      column: 'needs_input',
      spend_usd: 0.42,
      machine_id: 'mbp-ben',
      badges: [],
      checking: null,
      pr_url: null,
      updated_at: '2026-10-22T12:05:00.000Z',
    });
    expect(card.input_request).toEqual(toInputRequestDto(input));
    expect(card.input_request?.created_at).toBe('2026-10-22T12:04:00.000Z');
  });

  it('badges the build-slot wait and drops an answered request', () => {
    const card = toBoardCard(
      ticket,
      {
        ...session,
        status: 'running',
        workflow_state: 'implementing',
        waiting_for_build_slot: true,
      },
      { ...input, answer: 'pg', answered_by: 'ben', answered_at: '2026-10-22T12:06:00Z' },
      VIEW,
    );
    expect(card.badges).toEqual(['waiting_for_build_slot']);
    expect(card.column).toBe('implementing');
    expect(card.input_request).toBeNull();
  });

  it('drops a still-open request once the session left needs_input (TD-079: cancel)', () => {
    const card = toBoardCard(
      { ...ticket, status: 'cancelled' },
      { ...session, status: 'failed' },
      input,
      VIEW,
    );
    expect(card.column).toBe('done');
    expect(card.badges).toEqual(['cancelled']);
    expect(card.input_request).toBeNull();
  });
});

describe('placeCard: the column-for-card rules (ADR-0010 §Board)', () => {
  const place = (s: Partial<typeof session> | null, view = VIEW, status = ticket.status) =>
    toBoardCard({ ...ticket, status }, s === null ? null : { ...session, ...s }, null, view);

  it('queued: no session, or a session before its first state', () => {
    expect(place(null, VIEW, 'ready').column).toBe('queued');
    expect(place({ status: 'queued' as never, workflow_state: null }).column).toBe('queued');
    expect(place({ status: 'assigned' as never, workflow_state: null }).column).toBe('queued');
  });

  it('a state that is a column is its own column, whatever the status', () => {
    for (const st of ['planning', 'implementing', 'needs_input', 'waiting_external', 'done']) {
      expect(place({ status: 'running' as never, workflow_state: st }).column).toBe(st);
    }
    // Requeued mid-flight: still the state's column.
    expect(place({ status: 'queued' as never, workflow_state: 'implementing' }).column).toBe(
      'implementing',
    );
  });

  it('failed / lost / cancelled land in Done with a badge', () => {
    expect(place({ status: 'failed' as never, workflow_state: 'implementing' })).toMatchObject({
      column: 'done',
      badges: ['failed'],
    });
    expect(place({ status: 'lost' as never, workflow_state: 'planning' })).toMatchObject({
      column: 'done',
      badges: ['lost'],
    });
    expect(
      place({ status: 'failed' as never, workflow_state: 'planning' }, VIEW, 'cancelled'),
    ).toMatchObject({ column: 'done', badges: ['cancelled'] });
    // Cancelled before any session ran.
    expect(place(null, VIEW, 'cancelled')).toMatchObject({ column: 'done', badges: ['cancelled'] });
  });

  it('an entry step stays in its source column, badged checking with {to, title, phase}', () => {
    const step = {
      kind: 'entry',
      from: 'implementing',
      outcome: 'done',
      to: 'waiting_external',
      attachment: null,
      subject: '',
      claude_session_id: null,
      nudged: false,
      phase: 'checks',
      index: 1,
    };
    const card = place({
      status: 'running' as never,
      workflow_state: 'implementing → waiting_external (entry)',
      context: { [STEP_CONTEXT_KEY]: step, implementing: { summary: 'x' } },
    });
    expect(card).toMatchObject({
      column: 'implementing',
      badges: ['checking'],
      checking: { to: 'waiting_external', title: 'Waiting external', phase: 'checks' },
    });
  });

  it('a legacy ADR-0009 review (context.__review) is a checking card too', () => {
    const card = place(
      {
        status: 'running' as never,
        workflow_state: 'implement → build (review)',
        context: {
          [REVIEW_CONTEXT_KEY]: {
            from: 'implement',
            outcome: 'done',
            to: 'build',
            attachment: null,
            subject: '',
            claude_session_id: null,
            nudged: false,
          },
        },
      },
      OLD_VIEW,
    );
    expect(card).toMatchObject({
      column: 'implementing',
      badges: ['checking'],
      checking: { to: 'build', title: 'Build', phase: 'review' },
    });
  });

  it('older workflows map by state type (terminal, human, event, agent/command)', () => {
    const col = (st: string) => place({ status: 'running' as never, workflow_state: st }, OLD_VIEW);
    expect(col('done').column).toBe('done');
    expect(col('needs_input').column).toBe('needs_input');
    expect(col('wait').column).toBe('waiting_external');
    expect(col('implement').column).toBe('implementing');
    expect(col('build').column).toBe('implementing');
    expect(col('no_such_state').column).toBe('implementing');
  });

  it('shows only the PR conductor recorded (context.__pr), only a GitHub PR URL', () => {
    const at = (context: Record<string, unknown>) =>
      place({ status: 'waiting_external' as never, workflow_state: 'waiting_external', context });
    expect(at({ [PR_CONTEXT_KEY]: { pr_url: 'https://github.com/o/r/pull/1' } }).pr_url).toBe(
      'https://github.com/o/r/pull/1',
    );
    // An agent's complete_state result carrying pr_url is never shown (security review).
    expect(at({ implementing: { pr_url: 'https://github.com/o/r/pull/2' } }).pr_url).toBeNull();
    expect(at({ waiting_external: { pr_url: 'https://github.com/o/r/pull/3' } }).pr_url).toBeNull();
    // Not a GitHub PR URL → null.
    for (const bad of [
      'https://evil.example/o/r/pull/1',
      'javascript:alert(1)',
      'https://github.com/o/r/pull/1?x=<script>',
      'https://github.com/o/r/issues/1',
    ]) {
      expect(at({ [PR_CONTEXT_KEY]: { pr_url: bad } }).pr_url).toBeNull();
    }
  });

  it('BoardCardSchema turns an invalid pr_url into null', () => {
    const parsed = BoardCardSchema.parse({ ...BOARD_CARD_FIXTURE, pr_url: 'javascript:alert(1)' });
    expect(parsed.pr_url).toBeNull();
    const ok = BoardCardSchema.parse({
      ...BOARD_CARD_FIXTURE,
      pr_url: 'https://github.com/o/r/pull/9',
    });
    expect(ok.pr_url).toBe('https://github.com/o/r/pull/9');
  });
});

describe('REST error map', () => {
  it('maps every reject reason', () => {
    expect(Object.keys(APPLY_REJECT_HTTP).sort()).toEqual([...APPLY_REJECT_REASONS].sort());
    expect(
      httpForApplyResult('input', { status: 'rejected', reason: 'input_already_answered' }),
    ).toEqual({ status: 409, code: 'input_already_answered' });
    expect(httpForApplyResult('cancel', { status: 'rejected', reason: 'unknown_session' })).toEqual(
      { status: 404, code: 'not_found' },
    );
  });

  it('maps ignored per route', () => {
    expect(httpForApplyResult('input', { status: 'ignored', reason: 'wrong_status' })).toEqual({
      status: 409,
      code: 'input_not_pending',
    });
    expect(httpForApplyResult('approve', { status: 'ignored', reason: 'not_awaited' })).toEqual({
      status: 409,
      code: 'conflict',
    });
  });

  it('approve body is an optional comment', () => {
    expect(ApproveSessionRequestSchema.parse({})).toEqual({});
    expect(ApproveSessionRequestSchema.parse({ comment: 'lgtm' })).toEqual({ comment: 'lgtm' });
  });
});

describe('ports and paths', () => {
  it('reads CONDUCTOR_PORT with a default', () => {
    expect(conductorPort({})).toBe(DEFAULT_CONDUCTOR_PORT);
    expect(conductorPort({ CONDUCTOR_PORT: '8080' })).toBe(8080);
    expect(() => conductorPort({ CONDUCTOR_PORT: 'x' })).toThrow();
    expect(API_PATHS.daemonWs).toBe('/ws/daemon');
  });
});

describe('M2 card fields (routing, alerts)', () => {
  it('a card with routing and alerts parses and keeps them', () => {
    const routed = BoardCardSchema.parse(BOARD_CARD_ROUTING_FIXTURE);
    expect(routed.routing).toEqual({
      missing_repo: 'github.com/benjgrad/fixture-app',
      missing_capabilities: ['cli:az:authed'],
    });
    const alerted = BoardCardSchema.parse(BOARD_CARD_ALERT_FIXTURE);
    expect(alerted.alerts).toEqual(BOARD_CARD_ALERT_FIXTURE.alerts);
    expect(
      BoardCardSchema.parse({ ...BOARD_CARD_FIXTURE, routing: { missing_capabilities: [] } })
        .routing,
    ).toEqual({ missing_capabilities: [] });
  });

  it('an old card without them parses (both absent)', () => {
    const old = BoardCardSchema.parse(BOARD_CARD_FIXTURE);
    expect(old.routing).toBeUndefined();
    expect(old.alerts).toBeUndefined();
    expect(old).toEqual(BOARD_CARD_FIXTURE);
  });

  it('refuses an unknown alert kind', () => {
    const bad = {
      ...BOARD_CARD_FIXTURE,
      alerts: [{ kind: 'other', files: [], at: BOARD_CARD_FIXTURE.created_at }],
    };
    expect(BoardCardSchema.safeParse(bad).success).toBe(false);
  });
});
