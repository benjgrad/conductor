import { describe, expect, it } from 'vitest';
import {
  checkFailureRates,
  FindingSchema,
  FINDING_RULES,
  GROUPS_MAX,
  inputStats,
  loopCounts,
  median,
  percentile,
  permissionStats,
  presetUses,
  processMetrics,
  ProcessMetricsSchema,
  rankFindings,
  stateDurations,
  type AdvisorRows,
  type CheckRunRow,
  type InputRow,
  type MoveRow,
  type PermissionRow,
} from './metrics.js';
import type { InputClass } from './gates.js';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

/** A session's moves through `states`, entering each at the given minute. */
function walk(
  ticket: string,
  steps: [state: string, min: number, transition?: string][],
  extra: Partial<MoveRow> = {},
): MoveRow[] {
  const visits = new Map<string, number>();
  let from: string | null = null;
  return steps.map(([to, min, transition]) => {
    const visit = (visits.get(to) ?? 0) + 1;
    visits.set(to, visit);
    const row: MoveRow = {
      session_id: `s-${ticket}`,
      ticket_id: ticket,
      repo: 'github.com/acme/app',
      workflow_id: 'conductor',
      machine_id: 'm1',
      from,
      to,
      transition: transition ?? null,
      visit,
      at: at(min),
      ...extra,
    };
    from = to;
    return row;
  });
}

const check = (ticket: string, cmd: string, exit: number | null, o: Partial<CheckRunRow> = {}) =>
  ({
    session_id: `s-${ticket}`,
    ticket_id: ticket,
    repo: 'github.com/acme/app',
    machine_id: 'm1',
    state: 'implementing',
    cmd,
    exit_code: exit,
    timed_out: false,
    setup_failed: false,
    started_at: at(0),
    at: at(2),
    ...o,
  }) satisfies CheckRunRow;

const question = (ticket: string, state: string | null, answeredAfter: number | null) =>
  ({
    session_id: `s-${ticket}`,
    ticket_id: ticket,
    repo: 'github.com/acme/app',
    machine_id: 'm1',
    state,
    kind: 'agent_question',
    created_at: at(10),
    answered_at: answeredAfter === null ? null : at(10 + answeredAfter),
  }) satisfies InputRow;

const prompt = (ticket: string, status: PermissionRow['status'], o: Partial<PermissionRow> = {}) =>
  ({
    session_id: `s-${ticket}`,
    ticket_id: ticket,
    repo: 'github.com/acme/app',
    machine_id: 'm1',
    tool: 'Bash',
    always_rule: 'Bash(pnpm i)',
    status,
    scope: status === 'allowed' ? 'once' : null,
    created_at: at(5),
    ...o,
  }) satisfies PermissionRow;

const EMPTY: AdvisorRows = { moves: [], checks: [], inputs: [], permissions: [] };

describe('median / percentile', () => {
  it('handle empty, odd and even lists', () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(percentile([], 0.9)).toBe(0);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });
});

describe('stateDurations', () => {
  it('closes each stay at the next entry and leaves the last (running or terminal) one out', () => {
    const spans = stateDurations([
      ...walk('a', [
        ['planning', 0],
        ['implementing', 30],
        ['done', 90],
      ]),
      // Still running: only planning is closed.
      ...walk('b', [
        ['planning', 0],
        ['implementing', 10],
      ]),
    ]);
    expect(spans.map((s) => [s.ticket_id, s.state, s.minutes])).toEqual([
      ['a', 'planning', 30],
      ['a', 'implementing', 60],
      ['b', 'planning', 10],
    ]);
  });

  it('orders by time, whatever order the rows come in', () => {
    const rows = walk('a', [
      ['planning', 0],
      ['implementing', 5],
      ['done', 6],
    ]).reverse();
    expect(stateDurations(rows).map((s) => s.minutes)).toEqual([5, 1]);
  });

  it('is empty for an empty window', () => {
    expect(stateDurations([])).toEqual([]);
  });
});

describe('loopCounts', () => {
  it('counts re-entries, transitions and qa_fail per ticket', () => {
    const res = loopCounts(
      walk('a', [
        ['implementing', 0],
        ['qa', 10, 'ready_for_testing'],
        ['implementing', 20, 'qa_fail'],
        ['qa', 30, 'ready_for_testing'],
        ['implementing', 40, 'qa_fail'],
      ]),
    );
    expect(res.reentries).toEqual([
      { state: 'implementing', count: 2, tickets: 1, examples: ['a'] },
      { state: 'qa', count: 1, tickets: 1, examples: ['a'] },
    ]);
    expect(res.transitions).toEqual([
      { name: 'qa_fail', count: 2 },
      { name: 'ready_for_testing', count: 2 },
    ]);
    expect(res.tickets).toEqual([
      { ticket_id: 'a', state: 'implementing', extra_visits: 2, qa_fail: 2 },
    ]);
  });

  it('lists no ticket that went straight through', () => {
    expect(
      loopCounts(
        walk('a', [
          ['planning', 0],
          ['done', 1],
        ]),
      ).tickets,
    ).toEqual([]);
  });
});

describe('checkFailureRates', () => {
  it('counts exits, timeouts and setup failures as failures', () => {
    const stats = checkFailureRates([
      check('a', 'npm test', 0),
      check('b', 'npm test', 1),
      check('c', 'npm test', null, { timed_out: true }),
      check('d', 'npm test', null, { setup_failed: true, state: 'review' }),
      check('a', 'npm run build', 0),
    ]);
    expect(stats[0]).toMatchObject({
      check: 'npm test',
      states: ['implementing', 'review'],
      runs: 4,
      failures: 3,
      timeouts: 1,
      setup_failures: 1,
      failure_rate: 0.75,
      median_minutes: 2,
      examples: ['b', 'c', 'd'],
    });
    expect(stats[1]).toMatchObject({ check: 'npm run build', failures: 0, failure_rate: 0 });
  });
});

describe('inputStats', () => {
  it('groups by the asking state, with answer latency over answered ones only', () => {
    const stats = inputStats([
      question('a', 'planning', 30),
      question('b', 'planning', 10),
      question('b', 'planning', null),
      question('c', null, 5),
    ]);
    expect(stats[0]).toMatchObject({
      state: 'planning',
      asked: 3,
      tickets: 2,
      answered: 2,
      median_answer_minutes: 20,
      kinds: { agent_question: 3 },
    });
    expect(stats[1]).toMatchObject({ state: 'unknown', asked: 1 });
  });
});

describe('permissionStats', () => {
  it('counts denied and expired as denials, per machine and tool, with the common rule', () => {
    const stats = permissionStats([
      prompt('a', 'denied'),
      prompt('b', 'expired'),
      prompt('c', 'allowed', { scope: 'always' }),
      prompt('d', 'pending', { always_rule: null }),
      prompt('e', 'denied', { machine_id: 'm2' }),
    ]);
    expect(stats[0]).toEqual({
      machine_id: 'm1',
      tool: 'Bash',
      rule: 'Bash(pnpm i)',
      prompts: 4,
      denied: 2,
      allowed: 1,
      allowed_always: 1,
      examples: ['a', 'b'],
    });
    expect(stats[1]).toMatchObject({ machine_id: 'm2', denied: 1 });
  });
});

describe('processMetrics', () => {
  const rows: AdvisorRows = {
    moves: [
      ...walk('a', [
        ['planning', 0],
        ['implementing', 60],
        ['done', 120],
      ]),
      ...walk(
        'b',
        [
          ['planning', 0],
          ['implementing', 30],
          ['done', 40],
        ],
        { repo: 'github.com/acme/api', machine_id: 'm2' },
      ),
    ],
    checks: [check('a', 'npm test', 1), check('a', 'npm test', 0)],
    inputs: [question('a', 'planning', 5)],
    permissions: [prompt('a', 'denied')],
  };

  it('groups by state, sorted by total time', () => {
    const m = processMetrics(rows, 'state');
    expect(ProcessMetricsSchema.parse(m)).toEqual(m);
    expect(m.totals).toEqual({
      tickets: 2,
      sessions: 2,
      moves: 6,
      check_runs: 2,
      questions: 1,
      handoffs: 0,
      stops: 0,
      permission_prompts: 1,
    });
    expect(m.groups.map((g) => [g.key, g.stays, g.total_hours])).toEqual([
      ['planning', 2, 1.5],
      ['implementing', 2, 1.2],
    ]);
    expect(m.groups[1]).toMatchObject({ check_runs: 2, check_failures: 1 });
    expect(m.groups[0]).toMatchObject({ questions: 1, permission_denials: 0 });
  });

  it('groups by repo and machine, counting permission denials there', () => {
    const byRepo = processMetrics(rows, 'repo');
    expect(byRepo.groups.map((g) => g.key)).toEqual(['github.com/acme/app', 'github.com/acme/api']);
    expect(byRepo.groups[0]).toMatchObject({ permission_denials: 1, stays: 2 });
    expect(processMetrics(rows, 'machine').groups.map((g) => g.key)).toEqual(['m1', 'm2']);
  });

  it('groups by check: only check runs', () => {
    const m = processMetrics(rows, 'check');
    expect(m.groups).toEqual([
      expect.objectContaining({ key: 'npm test', check_runs: 2, check_failures: 1, stays: 0 }),
    ]);
  });

  it('caps the groups and says how many were left out', () => {
    const many = Array.from({ length: GROUPS_MAX + 4 }, (_, i) => check('a', `cmd ${i}`, 0));
    const m = processMetrics({ ...EMPTY, checks: many }, 'check');
    expect(m.groups).toHaveLength(GROUPS_MAX);
    expect(m.more_groups).toBe(4);
  });

  it('is all zeros for an empty window', () => {
    const m = processMetrics(EMPTY, 'state');
    expect(m.groups).toEqual([]);
    expect(m.totals.tickets).toBe(0);
  });
});

describe('rankFindings', () => {
  it('finds nothing in an empty window', () => {
    expect(rankFindings(EMPTY)).toEqual([]);
  });

  it('flags a state whose median stay is over 3× the overall median', () => {
    const moves = ['a', 'b', 'c'].flatMap((t) =>
      walk(t, [
        ['planning', 0],
        ['implementing', 10],
        ['review', 20],
        ['done', 200],
      ]),
    );
    const f = rankFindings({ ...EMPTY, moves });
    expect(f.map((x) => x.id)).toEqual(['slow_state:review']);
    // 180 min against an overall median of 10: 18×, over twice the factor.
    expect(f[0]!.severity).toBe(3);
  });

  it('needs at least the minimum stays before calling a state slow', () => {
    const moves = walk('a', [
      ['planning', 0],
      ['implementing', 1],
      ['review', 2],
      ['done', 500],
    ]);
    expect(rankFindings({ ...EMPTY, moves })).toEqual([]);
  });

  it('flags a check failing on more than 30 % of at least 3 runs', () => {
    const checks = [
      check('a', 'npm test', 1),
      check('b', 'npm test', 0),
      check('c', 'npm test', 0),
    ];
    expect(rankFindings({ ...EMPTY, checks }).map((x) => x.id)).toEqual(['failing_check:npm test']);
    const fine = [...checks, check('d', 'npm test', 0)];
    expect(rankFindings({ ...EMPTY, checks: fine })).toEqual([]);
  });

  it('suggests a repo setup when checks fail in setup', () => {
    const checks = ['a', 'b', 'c'].map((t) => check(t, 'npm test', null, { setup_failed: true }));
    const [f] = rankFindings({ ...EMPTY, checks });
    expect(f).toMatchObject({ severity: 3, suggested_tool: 'set_repo_checks' });
    expect(f!.suggestion).toContain('setup');
  });

  it('flags a tool denied 3+ times on one machine, pointing at the board', () => {
    const permissions = [prompt('a', 'denied'), prompt('b', 'expired'), prompt('c', 'denied')];
    const [f] = rankFindings({ ...EMPTY, permissions });
    expect(f).toMatchObject({
      id: 'permission_denials:m1:Bash',
      suggested_tool: 'board',
      example_ticket_ids: ['a', 'b', 'c'],
    });
    expect(f!.suggestion).toContain('Bash(pnpm i)');
    expect(rankFindings({ ...EMPTY, permissions: permissions.slice(0, 2) })).toEqual([]);
  });

  it('flags a question asked in more than 25 % of the tickets entering the state', () => {
    const moves = ['a', 'b', 'c', 'd', 'e'].flatMap((t) => walk(t, [['planning', 0]]));
    const two = [question('a', 'planning', 5), question('b', 'planning', 5)];
    expect(rankFindings({ ...EMPTY, moves, inputs: two }).map((x) => x.id)).toEqual([
      'frequent_question:planning',
    ]);
    // One ticket is below the minimum, whatever the share.
    expect(rankFindings({ ...EMPTY, moves, inputs: two.slice(0, 1) })).toEqual([]);
  });

  it('flags tickets that loop through qa_fail, and re-entered states', () => {
    const qa = walk('a', [
      ['implementing', 0],
      ['qa', 1],
      ['implementing', 2, 'qa_fail'],
      ['qa', 3],
      ['implementing', 4, 'qa_fail'],
    ]);
    const plan = walk('b', [
      ['planning', 0],
      ['needs_input', 1],
      ['planning', 2],
      ['needs_input', 3],
      ['planning', 4],
    ]);
    const ids = rankFindings({ ...EMPTY, moves: [...qa, ...plan] })
      .filter((f) => f.category === 'rework_loop')
      .map((f) => f.id);
    expect(ids).toEqual(['rework_loop:planning', 'rework_loop:qa_fail']);
  });

  it('returns schema-valid findings, most severe first', () => {
    const checks = ['a', 'b', 'c'].map((t) => check(t, 'npm test', null, { setup_failed: true }));
    const permissions = [prompt('a', 'denied'), prompt('b', 'denied'), prompt('c', 'denied')];
    const f = rankFindings({ ...EMPTY, checks, permissions });
    for (const x of f) expect(FindingSchema.parse(x)).toEqual(x);
    expect(f.map((x) => x.severity)).toEqual([3, 2]);
    expect(FINDING_RULES.permissionDenials).toBe(3);
  });
});

describe('what is counted (the 2026-11 metric fixes)', () => {
  const v4 = 'implementing → needs_input (move: personal_pr_ready_for_review)';
  const v5 = 'implementing → in_review (move: personal_pr_ready_for_review)';
  const testing = 'implementing → waiting_external (move: ready_for_testing)';
  const input = (ticket: string, cls: InputClass, o: Partial<InputRow> = {}): InputRow => ({
    ...question(ticket, 'implementing', 5),
    class: cls,
    ...o,
  });

  // Two tickets go round the same PR gate, one under each workflow version (v4 → needs_input, v5 →
  // in_review). A third waits on an approval, then in waiting_external, for a long time.
  const moves = [
    ...walk('a', [
      ['implementing', 0],
      [v4, 10, 'personal_pr_ready_for_review'],
      ['implementing', 12],
      [v4, 20, 'personal_pr_ready_for_review'],
      ['implementing', 22],
      [v4, 30, 'personal_pr_ready_for_review'],
      ['needs_input', 32, 'personal_pr_ready_for_review'],
    ]),
    ...walk('b', [
      ['implementing', 0],
      [v5, 10, 'personal_pr_ready_for_review'],
      ['implementing', 12],
      [v5, 20, 'personal_pr_ready_for_review'],
      ['implementing', 22],
      [v5, 30, 'personal_pr_ready_for_review'],
      ['in_review', 32, 'personal_pr_ready_for_review'],
    ]),
    ...(['c', 'd', 'e'] as const).flatMap((t) =>
      walk(t, [
        ['implementing', 0],
        [testing, 10, 'ready_for_testing'],
        ['waiting_external', 2_000],
        ['done', 4_000, 'ui.approve'],
      ]),
    ),
  ];
  const rows: AdvisorRows = {
    moves,
    checks: [
      check('a', 'mtd build', 1, {
        state: 'implementing.personal_pr_ready_for_review',
        name: 'Backend builds',
        source: 'repo',
      }),
      check('b', 'mtd build', 1, {
        state: 'implementing.personal_pr_ready_for_review',
        name: 'Backend builds',
        source: 'repo',
      }),
      check('c', 'mtd build', 0, {
        state: 'implementing.personal_pr_ready_for_review',
        name: 'Backend builds',
        source: 'repo',
      }),
      check('a', 'mtd build', null, {
        state: 'implementing.personal_pr_ready_for_review',
        name: 'Repo setup',
        role: 'setup',
        source: 'repo',
        setup_failed: true,
      }),
      check('b', 'mtd build', null, {
        state: 'implementing.personal_pr_ready_for_review',
        name: 'Repo setup',
        role: 'setup',
        source: 'repo',
        setup_failed: true,
      }),
      check('c', 'mtd build', null, {
        state: 'implementing.personal_pr_ready_for_review',
        name: 'Repo setup',
        role: 'setup',
        source: 'repo',
        setup_failed: true,
      }),
    ],
    inputs: [
      input('a', 'handoff', { state: v4 }),
      input('a', 'handoff', { state: v4 }),
      input('b', 'handoff', { state: v5 }),
      input('b', 'question'),
      input('c', 'stop', { kind: 'timeout' }),
    ],
    permissions: [],
    waits: {
      waiting_external: { ceiling_minutes: null },
      'implementing.ready_for_testing': { ceiling_minutes: 4320 },
    },
  };

  it('counts only questions as questions; hand-offs and engine stops apart (FR-1)', () => {
    const m = processMetrics(rows, 'state');
    expect(m.totals).toMatchObject({ questions: 1, handoffs: 3, stops: 1 });
    expect(inputStats(rows.inputs).map((q) => [q.state, q.asked])).toEqual([['implementing', 1]]);
    expect(rankFindings(rows).filter((f) => f.category === 'frequent_question')).toEqual([]);
  });

  it('keys a gate on state.transition across workflow versions (FR-2)', () => {
    const m = processMetrics(rows, 'state');
    const keys = m.groups.map((g) => g.key);
    expect(keys).toContain('implementing.personal_pr_ready_for_review');
    expect(keys.some((k) => k.includes('→'))).toBe(false);
    const gate = m.groups.find((g) => g.key === 'implementing.personal_pr_ready_for_review')!;
    expect(gate).toMatchObject({ stays: 6, handoffs: 3, reentries: 4 });
    const loops = rankFindings(rows).filter((f) => f.category === 'rework_loop');
    expect(loops.map((f) => f.id)).toEqual(['rework_loop:implementing']);
  });

  it('attributes checks to the gate, by name, with the setup apart (FR-3)', () => {
    const byCheck = processMetrics(rows, 'check');
    expect(byCheck.groups.map((g) => [g.key, g.check_runs, g.check_failures])).toEqual([
      ['setup: Repo setup', 3, 3],
      ['Backend builds', 3, 2],
    ]);
    const byState = processMetrics(rows, 'state');
    expect(byState.groups.map((g) => g.key)).not.toContain('unknown');
    const failing = rankFindings(rows).filter((f) => f.category === 'failing_check');
    expect(failing.map((f) => [f.id, f.title])).toEqual([
      ['failing_check:Backend builds', 'Check fails often: Backend builds'],
      ['failing_check:setup:Repo setup', 'Repo setup fails often'],
    ]);
    expect(failing[0]!.evidence).toContain(
      'in implementing.personal_pr_ready_for_review (repo check)',
    );
    expect(failing[1]!.evidence).toContain('(repo setup)');
  });

  it('never calls a by-design wait slow; marks it with its ceiling (FR-4)', () => {
    expect(rankFindings(rows).filter((f) => f.category === 'slow_state')).toEqual([]);
    const m = processMetrics(rows, 'state');
    expect(m.groups.find((g) => g.key === 'implementing.ready_for_testing')).toMatchObject({
      waits_on_others: true,
      ceiling_minutes: 4320,
    });
    expect(m.groups.find((g) => g.key === 'waiting_external')).toMatchObject({
      waits_on_others: true,
      ceiling_minutes: null,
    });
    // Without the definition's word for it, the same stays are slow.
    const plain: AdvisorRows = { ...rows };
    delete plain.waits;
    expect(
      rankFindings(plain)
        .filter((f) => f.category === 'slow_state')
        .map((f) => f.id)
        .sort(),
    ).toEqual(['slow_state:implementing.ready_for_testing', 'slow_state:waiting_external']);
  });
});

describe('presetUses (ADR-0037 P5)', () => {
  const RESYNC = { slug: 'resync_main', text: 'Merge main, then finish.' };
  const FIX = { slug: 'fix', text: 'Fix it.' };
  const row = (ticket: string, text: string, presets = [RESYNC, FIX]) => ({
    session_id: `s-${ticket}`,
    ticket_id: ticket,
    workflow_id: 'conductor',
    source: 'transition' as const,
    transition: 'request_changes',
    text,
    presets,
  });

  it('counts texts equal to a saved reply (trimmed) per reply, and the rest as typed', () => {
    expect(
      presetUses([
        row('t1', '  Merge main, then finish.\n'),
        row('t2', 'Merge main, then finish.'),
        row('t3', 'Please merge main first'),
        row('t4', 'Fix it.'),
        row('t5', 'anything', []),
      ]),
    ).toEqual({
      presets: {
        uses: [
          { workflow_id: 'conductor', slug: 'resync_main', used: 2, examples: ['t1', 't2'] },
          { workflow_id: 'conductor', slug: 'fix', used: 1, examples: ['t4'] },
        ],
        typed: 1,
      },
    });
  });

  it('nothing when no saved reply was offered', () => {
    expect(presetUses([])).toEqual({});
    expect(presetUses([row('t1', 'x', [])])).toEqual({});
  });
});
