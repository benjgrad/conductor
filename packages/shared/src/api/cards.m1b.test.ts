import { describe, expect, it } from 'vitest';
import type { TicketStatus } from '../domain.js';
import { MOVE_STEP_FIXTURE, M1B_EVENT_FIXTURES } from '../engine/fixtures.js';
import { STEP_CONTEXT_KEY } from '../engine/review.js';
import {
  CONDITIONS_NO_MACHINE_NOTE,
  EngineEventSchema,
  GateStepSchema,
  moveCounterKey,
  moveStateLabel,
  type GateStep,
} from '../engine/types.js';
import { boardColumns, CONDUCTOR_V1_DEF } from '../workflow/conductor.js';
import { CONDUCTOR_V2_DRAFT_DEF } from '../workflow/fixtures.js';
import {
  BOARD_CARD_FIXTURE,
  BOARD_CARD_NEEDS_INPUT_FIXTURE,
  BOARD_CARD_PENDING_FIXTURE,
  SESSION_MOVES_FIXTURE,
  TRANSITION_REQUEST_FIXTURES,
} from './fixtures.js';
import {
  API_PATHS,
  BoardCardSchema,
  CreateTicketRequestSchema,
  MoveDtoSchema,
  SessionDetailSchema,
  TransitionSessionRequestSchema,
  httpForApplyResult,
  pendingOfStep,
  toBoardCard,
  type CardTicketLike,
  type CardView,
} from './rest.js';

// M1b-T01: the ADR-0011 card fields (`kind`, `pending`, `human_transitions`), moves, and the
// transition route's DTOs.

const V2: CardView = { columns: boardColumns(CONDUCTOR_V2_DRAFT_DEF), def: CONDUCTOR_V2_DRAFT_DEF };
const V1: CardView = { columns: boardColumns(CONDUCTOR_V1_DEF), def: CONDUCTOR_V1_DEF };
const PR = { pr_url: 'https://github.com/benjgrad/fixture-app/pull/7', state: 'open' };

const ticket = (id: string, kind: 'work' | 'personal' | null, title = 'Add /health') => ({
  id,
  status: 'in_progress' as TicketStatus,
  kind,
  title,
  external_ref: null,
  repo: 'github.com/benjgrad/fixture-app',
  priority: 0,
  workflow_id: 'conductor',
  created_at: new Date('2026-10-22T12:00:00.000Z'),
  updated_at: new Date('2026-10-22T12:00:00.000Z'),
});

const session = (over: Record<string, unknown>) => ({
  id: '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f',
  workflow_state: 'implementing' as string | null,
  status: 'running' as const,
  machine_id: 'mbp-ben',
  spend_usd: 0,
  waiting_for_build_slot: false,
  context: {} as Record<string, unknown>,
  return_to: null as string | null,
  updated_at: new Date('2026-10-22T12:00:00.000Z'),
  ...over,
});

const inStep = (step: GateStep) =>
  session({
    workflow_state: moveStateLabel(step.from, step.to, step.transition ?? step.outcome),
    status: 'waiting_external',
    context: { [STEP_CONTEXT_KEY]: step, __pr: PR },
  });

describe('BoardCard.pending (ADR-0011 checklist)', () => {
  it('a move step in `conditions` yields pending.items with statuses (= the fixture)', () => {
    const card = toBoardCard(
      ticket(BOARD_CARD_PENDING_FIXTURE.ticket_id, 'work'),
      inStep(MOVE_STEP_FIXTURE),
      null,
      V2,
    );
    expect(BoardCardSchema.parse(card)).toEqual(BOARD_CARD_PENDING_FIXTURE);
    expect(card.column).toBe('implementing'); // stays in its source column
    expect(card.human_transitions).toEqual([]);
  });

  it('earlier phases: checks running at index 1, later items todo, disabled conditions greyed', () => {
    const step: GateStep = {
      ...MOVE_STEP_FIXTURE,
      phase: 'checks',
      index: 1,
      conditions: [],
    };
    expect(pendingOfStep(CONDUCTOR_V2_DRAFT_DEF, step)?.items).toEqual([
      { label: 'Build passes', status: 'met', detail: null },
      { label: 'Tests pass', status: 'running', detail: null },
      { label: 'PR opened', status: 'todo', detail: null },
      { label: 'PR checks green', status: 'todo', detail: null },
      { label: 'PR approved', status: 'todo', detail: null },
      { label: 'Jira fields set: resolution', status: 'disabled', detail: null },
      { label: 'Pipeline ci succeeded', status: 'disabled', detail: null },
    ]);
  });

  it('carries the no-machine note (U-058)', () => {
    const step = { ...MOVE_STEP_FIXTURE, conditions_note: CONDITIONS_NO_MACHINE_NOTE };
    expect(pendingOfStep(CONDUCTOR_V2_DRAFT_DEF, step)?.note).toBe(CONDITIONS_NO_MACHINE_NOTE);
  });

  it('an ADR-0010 entry step (conductor v1) fills pending from the entry, and checking', () => {
    const step = GateStepSchema.parse({
      kind: 'entry',
      from: 'implementing',
      outcome: 'done',
      to: 'waiting_external',
      attachment: null,
      subject: '',
      claude_session_id: null,
      nudged: false,
      phase: 'actions',
      index: 0,
    });
    const card = toBoardCard(
      ticket(BOARD_CARD_FIXTURE.ticket_id, null),
      session({ workflow_state: 'x', status: 'running', context: { [STEP_CONTEXT_KEY]: step } }),
      null,
      V1,
    );
    expect(card.checking).toEqual({
      to: 'waiting_external',
      title: 'Waiting external',
      phase: 'actions',
      label: 'Checks before Waiting external',
      transition: 'done',
      items: [
        { label: 'Build passes', kind: 'check', status: 'passed', detail: null },
        { label: 'Tests pass', kind: 'check', status: 'passed', detail: null },
        { label: 'PR opened', kind: 'action', status: 'running', detail: null },
      ],
      current: 2,
    });
    expect(card.pending).toEqual({
      transition: 'done',
      to: 'waiting_external',
      title: 'Waiting external',
      items: [
        { label: 'Build passes', status: 'met', detail: null },
        { label: 'Tests pass', status: 'met', detail: null },
        { label: 'PR opened', status: 'running', detail: null },
      ],
      note: null,
    });
  });

  it('no step → pending null; an unknown definition → items []', () => {
    expect(toBoardCard(ticket('a', 'work'), session({}), null, V2).pending).toBeNull();
    expect(pendingOfStep(null, MOVE_STEP_FIXTURE)?.items).toEqual([]);
  });
});

describe('BoardCard.human_transitions (ADR-0011 buttons)', () => {
  const needsInput = (returnTo: string | null) =>
    session({
      id: BOARD_CARD_NEEDS_INPUT_FIXTURE.session_id,
      workflow_state: 'needs_input',
      status: 'needs_input',
      return_to: returnTo,
    });
  const ir = {
    ...BOARD_CARD_NEEDS_INPUT_FIXTURE.input_request!,
    created_at: new Date(BOARD_CARD_NEEDS_INPUT_FIXTURE.input_request!.created_at),
    answered_at: null,
  };

  it('a needs_input card yields its human transitions (= the fixture)', () => {
    const card = toBoardCard(
      ticket(BOARD_CARD_NEEDS_INPUT_FIXTURE.ticket_id, 'personal', 'Plan the garden'),
      needsInput('planning'),
      ir,
      V2,
    );
    expect(BoardCardSchema.parse(card)).toEqual(BOARD_CARD_NEEDS_INPUT_FIXTURE);
  });

  it('filters by kind', () => {
    const def = structuredClone(CONDUCTOR_V2_DRAFT_DEF);
    const ni = def.states.needs_input!;
    if (ni.type !== 'human') throw new Error('fixture');
    ni.on!.escalate = { goto: 'done', actor: 'human', kinds: ['work'] };
    const view: CardView = { ...V2, def };
    const names = (kind: 'work' | 'personal' | null) =>
      toBoardCard(ticket('a', kind), needsInput('implementing'), null, view).human_transitions.map(
        (h) => h.name,
      );
    expect(names('work')).toEqual(['answer', 'waiting_on_someone', 'done', 'escalate']);
    expect(names('personal')).toEqual(['answer', 'waiting_on_someone', 'done']);
    expect(names(null)).toEqual(['answer', 'waiting_on_someone', 'done', 'escalate']);
  });

  it('waiting_external in an event state offers its human transitions; running offers none', () => {
    const waiting = session({ workflow_state: 'waiting_external', status: 'waiting_external' });
    expect(
      toBoardCard(ticket('a', 'work'), waiting, null, V2).human_transitions.map((h) => h.name),
    ).toEqual(['back_to_implementing']);
    expect(toBoardCard(ticket('a', 'work'), session({}), null, V2).human_transitions).toEqual([]);
    // conductor v1's needs_input has no transitions: the old quick actions stay (T07)
    expect(
      toBoardCard(ticket('a', null), needsInput('implementing'), null, V1).human_transitions,
    ).toEqual([]);
  });

  it('a ticket row without kind (before the migration) reads as null', () => {
    const row: CardTicketLike = { ...ticket('a', 'work') };
    delete row.kind;
    expect('kind' in row).toBe(false);
    expect(toBoardCard(row, null, null, V2).kind).toBeNull();
    expect(toBoardCard(ticket('a', 'work'), null, null, V2).kind).toBe('work');
  });
});

describe('BoardCard backward compatibility', () => {
  it('a pre-M1b card (no kind / pending / human_transitions / checking) still parses', () => {
    const old = {
      ticket_id: '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2',
      session_id: '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f',
      title: 'Add /health',
      external_ref: null,
      repo: 'github.com/benjgrad/fixture-app',
      priority: 0,
      workflow_id: 'conductor',
      workflow_state: 'implementing',
      status: 'running',
      column: 'implementing',
      badges: [],
      pr_url: null,
      machine_id: 'mbp-ben',
      spend_usd: 0.12,
      input_request: null,
      created_at: '2026-10-22T12:00:00.000Z',
      updated_at: '2026-10-22T12:05:00.000Z',
    };
    expect(BoardCardSchema.parse(JSON.parse(JSON.stringify(old)))).toEqual({
      ...old,
      checking: null,
      kind: null,
      pending: null,
      human_transitions: [],
    });
  });
});

describe('moves, the transition route, ticket kind', () => {
  it('SESSION_MOVES_FIXTURE parses; SessionDetail.moves is optional', () => {
    for (const m of SESSION_MOVES_FIXTURE) expect(MoveDtoSchema.parse(m)).toEqual(m);
    expect(SessionDetailSchema.shape.moves.safeParse(undefined).success).toBe(true);
    expect(SessionDetailSchema.shape.moves.parse(SESSION_MOVES_FIXTURE)).toEqual(
      SESSION_MOVES_FIXTURE,
    );
  });

  it('TransitionSessionRequest fixtures parse; name required, text trimmed', () => {
    for (const r of Object.values(TRANSITION_REQUEST_FIXTURES)) {
      expect(TransitionSessionRequestSchema.parse(r)).toEqual(r);
    }
    expect(TransitionSessionRequestSchema.safeParse({ text: 'x' }).success).toBe(false);
    expect(TransitionSessionRequestSchema.safeParse({ name: 'done', text: '  ' }).success).toBe(
      false,
    );
    expect(API_PATHS.sessionTransition('s1')).toBe('/api/sessions/s1/transition');
  });

  it('an ignored transition is 409 conflict', () => {
    expect(
      httpForApplyResult('transition', { status: 'ignored', reason: 'transition_not_allowed' }),
    ).toEqual({ status: 409, code: 'conflict' });
    expect(
      httpForApplyResult('transition', { status: 'rejected', reason: 'unknown_session' }),
    ).toEqual({ status: 404, code: 'not_found' });
  });

  it('CreateTicketRequest accepts kind (required by the route, M1b-T04)', () => {
    expect(
      CreateTicketRequestSchema.parse({ title: 't', body: '', repo: 'r', kind: 'personal' }).kind,
    ).toBe('personal');
    expect(
      CreateTicketRequestSchema.safeParse({ title: 't', body: '', repo: 'r', kind: 'home' })
        .success,
    ).toBe(false);
  });
});

describe('engine contract (ADR-0011)', () => {
  it('M1B_EVENT_FIXTURES parse as engine events', () => {
    for (const ev of Object.values(M1B_EVENT_FIXTURES)) {
      expect(EngineEventSchema.parse(ev)).toEqual(ev);
    }
    expect(EngineEventSchema.parse({ type: 'agent.complete_state', result: {} })).toEqual({
      type: 'agent.complete_state',
      result: {},
    });
  });

  it('an M1-era step row parses with the new fields defaulted', () => {
    const legacy = {
      from: 'a',
      outcome: 'done',
      to: 'b',
      attachment: null,
      subject: '',
      claude_session_id: null,
      nudged: false,
    };
    expect(GateStepSchema.parse(legacy)).toMatchObject({
      kind: 'transition',
      phase: 'review',
      transition: null,
      actor: null,
      reason: null,
      conditions: [],
      conditions_deadline: null,
      conditions_poll_ms: null,
      conditions_note: null,
    });
    expect(GateStepSchema.parse(MOVE_STEP_FIXTURE)).toEqual(MOVE_STEP_FIXTURE);
  });

  it('move counter and label', () => {
    expect(moveCounterKey('implementing', 'ready_for_testing')).toBe(
      'move:implementing:ready_for_testing',
    );
    expect(moveStateLabel('implementing', 'waiting_external', 'ready_for_testing')).toBe(
      'implementing → waiting_external (move: ready_for_testing)',
    );
  });
});
