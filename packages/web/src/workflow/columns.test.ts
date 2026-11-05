import {
  CONDUCTOR_V2_DEF,
  CONDUCTOR_V2_DRAFT_DEF,
  WorkflowDefinitionSchema,
  validateWorkflow,
  type EntryRequirements,
  type WorkflowDefinition,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { CONDUCTOR, CONDUCTOR_V1, M1_BASIC } from '../api/mock-data.js';
import {
  addColumn,
  addColumnProblem,
  arrowLabel,
  buildLaneGraph,
  columnRemovalProblems,
  columnStates,
  moveColumn,
  moveColumnBy,
  removeColumn,
  slugFromTitle,
  stateNameProblem,
  laneKind,
  transitionTitle,
  currentLane,
  entryLines,
  entrySummary,
  followUpsOf,
  issueAt,
  laneIds,
  QUEUED_LANE,
  readSetup,
  readChecking,
  setFollowUps,
  setQueuedTicketEditable,
  setTicketEditable,
  setupLabel,
  ticketEditableOf,
  stateForPath,
  validateColumns,
  workSummary,
} from './columns.js';
import { layoutLanes } from './columns-layout.js';

const entryOf = (def: WorkflowDefinition, s: string) => def.states[s]!.entry!;

/** Set (or with null remove) a state's old requirements to enter (ADR-0010 fixtures). */
function setEntry(
  def: WorkflowDefinition,
  name: string,
  entry: EntryRequirements | null,
): WorkflowDefinition {
  const s = { ...def.states[name]! };
  delete s.entry;
  return { ...def, states: { ...def.states, [name]: entry === null ? s : { ...s, entry } } };
}

describe('lanes', () => {
  it('are Queued first, then the columns in order', () => {
    expect(laneIds(CONDUCTOR_V1)).toEqual([
      QUEUED_LANE,
      'planning',
      'implementing',
      'needs_input',
      'waiting_external',
      'done',
    ]);
    expect(buildLaneGraph(CONDUCTOR_V1).lanes.map((l) => l.title)).toEqual([
      'Queued',
      'Planning',
      'Implementing',
      'Needs input',
      'Waiting external',
      'Done',
    ]);
  });

  it('keep states that `columns` leaves out, at the end', () => {
    const def = { ...CONDUCTOR_V1, columns: ['implementing', 'planning'] };
    expect(laneIds(def).slice(0, 3)).toEqual([QUEUED_LANE, 'implementing', 'planning']);
    expect(laneIds(def)).toHaveLength(6);
  });

  it('say what does the work', () => {
    const s = CONDUCTOR_V1.states;
    expect(workSummary(null)).toBe('Waiting for a machine');
    expect(workSummary(s.planning!)).toBe('Agent · plan_template · default model');
    expect(workSummary(s.needs_input!)).toBe('A person answers or approves');
    // UXR-45: events in words, from the transition's title or the built-in label.
    expect(workSummary(s.waiting_external!)).toBe('Waits for: Approved');
    expect(workSummary(s.waiting_external!, CONDUCTOR_V1, 'waiting_external')).toBe(
      'Waits for: Approved',
    );
  });

  it('have a kind: agent, person, waiting, queue or end (UXR-68)', () => {
    expect(buildLaneGraph(CONDUCTOR_V1).lanes.map((l) => l.kind)).toEqual([
      'queue',
      'agent',
      'agent',
      'person',
      'waiting',
      'end',
    ]);
    const s = M1_BASIC.states;
    const command = Object.values(s).find((x) => x.type === 'command')!;
    expect(laneKind(command)).toBe('agent');
    expect(laneKind(null)).toBe('queue');
  });

  it('draw merged outcome arrows and the dashed unmet loop', () => {
    const edges = buildLaneGraph(CONDUCTOR_V1).edges;
    const byId = Object.fromEntries(edges.map((e) => [e.id, e]));
    expect(byId.start).toMatchObject({ from: QUEUED_LANE, to: 'planning', dashed: false });
    expect(byId['planning/needs_input']).toMatchObject({
      label: '2 ways',
      titles: ['Ask user', 'Timeout'],
    });
    expect(byId['implementing/waiting_external']?.label).toBe('Done');
    expect(byId['waiting_external/done']?.label).toBe('Approved');
    expect(byId.start?.label).toBe('Claimed');
    expect(byId['waiting_external/entry/unmet']).toMatchObject({
      kind: 'unmet',
      to: 'implementing',
      dashed: true,
      label: 'Not met ×3',
    });
  });

  it('lay out left to right without overlapping lanes', () => {
    const layout = layoutLanes(CONDUCTOR);
    const xs = layout.lanes.map((l) => l.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    layout.lanes.slice(1).forEach((l, i) => {
      const prev = layout.lanes[i]!;
      expect(l.x).toBeGreaterThan(prev.x + prev.w);
    });
    // The unmet loop runs below the lanes, the planning → needs_input skip above.
    const side = (id: string) => layout.edges.find((e) => e.edge.id === id)?.side;
    expect(side('waiting_external/entry/unmet')).toBe('below');
    expect(side('planning/needs_input')).toBe('above');
    expect(side('planning/implementing')).toBe('across');
  });
});

describe('requirements summary', () => {
  it('names checks, counts review items and lists actions', () => {
    expect(entrySummary(CONDUCTOR, entryOf(CONDUCTOR, 'waiting_external'))).toEqual({
      setup: 'auto setup',
      checks: ['Build passes', 'Tests pass'],
      reviewItems: 2,
      actions: ['Opens PR'],
      unmet: 'Not met: back to Implementing ×3, then Needs input',
    });
    expect(entryLines(CONDUCTOR_V1, entryOf(CONDUCTOR_V1, 'waiting_external'))).toEqual([
      '⚙ auto setup',
      '✓ Build passes',
      '✓ Tests pass',
      '↗ Opens PR',
      'Not met: back to Implementing ×3, then Needs input',
    ]);
  });

  it('shows the setup line (read defensively)', () => {
    const base = entryOf(CONDUCTOR_V1, 'waiting_external');
    const withSetup = (setup: string) => ({ ...base, setup }) as EntryRequirements;
    expect(readSetup(base)).toBeUndefined();
    expect(entryLines(CONDUCTOR_V1, base)[0]).toBe('⚙ auto setup');
    expect(entryLines(CONDUCTOR_V1, withSetup('npm ci'))[0]).toBe('⚙ setup: npm ci');
    expect(entryLines(CONDUCTOR_V1, withSetup(''))[0]).toBe('⚙ no setup');
    expect(setupLabel({ actions: ['open_pr'], on_unmet: base.on_unmet })).toBeNull();
  });
});

describe('arrows (ADR-0011)', () => {
  const graph = buildLaneGraph(CONDUCTOR_V2_DRAFT_DEF);
  const byId = Object.fromEntries(graph.edges.map((e) => [e.id, e]));

  it('merge the transitions between two columns into one arrow, "N ways"', () => {
    expect(byId['planning/needs_input']).toMatchObject({
      kind: 'outcome',
      transitions: [
        'scope_changed',
        'plan_needs_approval',
        'needs_product_context',
        'impossible',
        'ask_user',
        'timeout',
      ],
      label: '6 ways',
    });
    expect(byId['planning/needs_input']?.badge).toBeUndefined();
    expect(byId['planning/needs_input']?.title).toBe(
      'Planning → Needs input: 6 transitions (Scope changed, Plan needs approval, ' +
        'Needs product context, Impossible, Ask user, Timeout)',
    );
    expect(byId['planning/implementing']).toMatchObject({
      label: 'Plan ready',
      transitions: ['plan_ready'],
    });
    expect(byId['planning/implementing']?.badge).toBeUndefined();
  });

  it('mark arrows with requirements, and skip targets that are not columns', () => {
    expect(byId['implementing/waiting_external']).toMatchObject({
      label: 'Ready for testing',
      gated: true,
      badge: '✓',
    });
    expect(byId['implementing/needs_input']).toMatchObject({
      gated: true,
      badge: '✓',
      label: `${byId['implementing/needs_input']!.transitions!.length} ways`,
    });
    // `answer` goes to `$return_to`: no arrow (the column panel lists it).
    expect(graph.edges.some((e) => e.transitions?.includes('answer'))).toBe(false);
    // on_unmet back to Implementing from Implementing itself is not drawn either.
    expect(graph.edges.filter((e) => e.kind === 'unmet')).toEqual([]);
  });

  it('draw a transition’s own unmet loop, owned by the transition', () => {
    const def = structuredClone(CONDUCTOR_V2_DRAFT_DEF);
    const impl = def.states.implementing;
    if (impl?.type !== 'agent' || typeof impl.on?.ready_for_testing !== 'object') {
      throw new Error('fixture');
    }
    impl.on.ready_for_testing.on_unmet!.goto = 'planning';
    const e = buildLaneGraph(def).edges.find(
      (x) => x.id === 'implementing/ready_for_testing/unmet',
    );
    expect(e).toMatchObject({
      kind: 'unmet',
      to: 'planning',
      dashed: true,
      owner: { from: 'implementing', name: 'ready_for_testing' },
    });
  });

  it('label an arrow with its one title, or "N ways" (UXR-45)', () => {
    expect(arrowLabel(['Plan ready'])).toBe('Plan ready');
    expect(arrowLabel(['Ask user', 'Timeout'])).toBe('2 ways');
    // Twins with one title (work and personal) read as that title.
    expect(arrowLabel(['PR ready for review', 'PR ready for review'])).toBe('PR ready for review');
  });

  it('title transitions: their own title, a built-in event, else the name in words', () => {
    expect(transitionTitle(CONDUCTOR_V2_DRAFT_DEF, 'planning', 'plan_ready')).toBe('Plan ready');
    expect(transitionTitle(CONDUCTOR_V1, 'waiting_external', 'ui.approve')).toBe('Approved');
    expect(transitionTitle(CONDUCTOR_V1, 'planning', 'ask_user')).toBe('Ask user');
  });
});

describe('validateColumns', () => {
  it('passes the shipped conductor workflow', () => {
    expect(validateColumns(CONDUCTOR_V1)).toEqual([]);
    expect(validateColumns(CONDUCTOR)).toEqual([]);
  });

  it('flags bad targets, retries, empty commands and an empty entry', () => {
    const e = entryOf(CONDUCTOR, 'waiting_external');
    let def = setEntry(CONDUCTOR, 'waiting_external', {
      ...e,
      checks: [{ name: 'Build', cmd: ' ' }],
      review: { items: [''] },
      on_unmet: { goto: 'nowhere', retries: 11, else: 'implementing', instruction: ' ' },
    });
    def = setEntry(def, 'implementing', { on_unmet: { ...e.on_unmet, goto: 'planning' } });
    expect(validateColumns(def).map((i) => [i.state, i.path, i.message])).toEqual([
      [
        'implementing',
        'states.implementing.entry',
        'add at least one check, review item or action, or remove the requirements',
      ],
      ['waiting_external', 'states.waiting_external.entry.checks.0.cmd', 'check 1 needs a command'],
      [
        'waiting_external',
        'states.waiting_external.entry.review.items.0',
        'review item 1 is empty',
      ],
      [
        'waiting_external',
        'states.waiting_external.entry.on_unmet.goto',
        '"back to" column "nowhere" does not exist',
      ],
      [
        'waiting_external',
        'states.waiting_external.entry.on_unmet.else',
        '"then" column "Implementing" must be a human column',
      ],
      [
        'waiting_external',
        'states.waiting_external.entry.on_unmet.retries',
        'retries must be a whole number from 0 to 10',
      ],
      [
        'waiting_external',
        'states.waiting_external.entry.on_unmet.instruction',
        'the instruction is empty',
      ],
    ]);
  });

  it('rejects requirements to enter the start column', () => {
    const def = setEntry(CONDUCTOR, 'planning', entryOf(CONDUCTOR, 'waiting_external'));
    expect(validateColumns(def)).toEqual([
      {
        state: 'planning',
        path: 'states.planning.entry',
        message: 'the first column cannot have requirements to enter (a claim enters it)',
      },
    ]);
  });

  it('mirror the server rule 9: loops, human entry, duplicates, columns, reserved names', () => {
    const e = entryOf(CONDUCTOR, 'waiting_external');
    let def = setEntry(CONDUCTOR, 'waiting_external', {
      ...e,
      checks: [
        { name: 'Build', cmd: 'npm run build' },
        { name: 'Build', cmd: 'npm test' },
      ],
      actions: ['open_pr', 'open_pr'],
      on_unmet: { ...e.on_unmet, goto: 'waiting_external' },
    });
    def = setEntry(def, 'needs_input', { actions: ['open_pr'], on_unmet: e.on_unmet });
    def = {
      ...def,
      columns: ['planning', 'implementing', 'implementing', 'waiting_external', 'done'],
      states: { ...def.states, __entry: { type: 'terminal' } },
    };
    expect(validateColumns(def).map((i) => [i.path, i.message])).toEqual([
      ['columns.2', 'column "implementing" is listed twice'],
      ['columns', 'every state is a column: add "needs_input", "__entry"'],
      [
        'states.__entry',
        'Nothing leads to __entry yet: add a transition into it from another column',
      ],
      ['states.__entry', '"__entry" is a reserved name'],
      ['states.needs_input.entry', 'a human column cannot have requirements to enter'],
      ['states.waiting_external.entry.checks.1.name', 'check "Build" is listed twice'],
      ['states.waiting_external.entry.actions.1', 'action "open_pr" is listed twice'],
      [
        'states.waiting_external.entry.on_unmet.goto',
        '"back to" cannot be Waiting external itself',
      ],
    ]);
    // A loop back to a column with its own entry.
    const nested = setEntry(CONDUCTOR, 'implementing', {
      actions: ['open_pr'],
      on_unmet: e.on_unmet,
    });
    expect(validateColumns(nested).map((i) => i.message)).toContain(
      '"back to" column "Implementing" has requirements to enter of its own',
    );
  });

  it('includes old per-transition gate rules (ADR-0009)', () => {
    const bad = structuredClone(M1_BASIC);
    const impl = bad.states.implement;
    if (impl?.type !== 'agent' || typeof impl.on?.done !== 'object') throw new Error('fixture');
    impl.on.done.requirements!.on_unmet.else = 'build';
    expect(validateColumns(bad).map((i) => i.state)).toEqual(['implement']);
  });

  it('agrees with the shared schema on a valid definition', () => {
    expect(validateWorkflow(CONDUCTOR).ok).toBe(true);
  });
});

describe('paths and sessions', () => {
  it('maps server paths to columns', () => {
    expect(stateForPath(CONDUCTOR, 'states.waiting_external.entry.on_unmet.goto')).toBe(
      'waiting_external',
    );
    expect(stateForPath(CONDUCTOR, 'columns.1')).toBe('implementing');
    expect(stateForPath(CONDUCTOR, 'start')).toBeNull();
  });

  it('maps server paths to the transition they point into (ADR-0011)', () => {
    const def = CONDUCTOR_V2_DRAFT_DEF;
    expect(
      issueAt(def, 'states.implementing.on.ready_for_testing.requires.conditions.1', 'x'),
    ).toEqual({
      state: 'implementing',
      path: 'states.implementing.on.ready_for_testing.requires.conditions.1',
      message: 'x',
      transition: { from: 'implementing', name: 'ready_for_testing' },
    });
    // Names with dots: the longest match wins.
    expect(issueAt(def, 'states.waiting_external.on.ui.approve.goto', 'x').transition).toEqual({
      from: 'waiting_external',
      name: 'ui.approve',
    });
    expect(issueAt(def, 'states.planning.title', 'x').transition).toBeUndefined();
  });

  it('finds the current lane and reads `checking` defensively', () => {
    expect(currentLane(CONDUCTOR, null, 'queued')).toBe(QUEUED_LANE);
    expect(currentLane(CONDUCTOR, 'implementing', 'running')).toBe('implementing');
    expect(currentLane(CONDUCTOR, 'build', 'running')).toBeNull();
    expect(readChecking({ checking: { to: 'waiting_external', phase: 'checks' } })).toEqual({
      to: 'waiting_external',
      phase: 'checks',
    });
    expect(readChecking({ checking: { to: 'x' } })).toEqual({ to: 'x', phase: null });
    expect(readChecking({})).toBeNull();
    expect(readChecking({ checking: 'nope' })).toBeNull();
  });
});

describe('ticket editability per column', () => {
  it('reads the defaults and sets or clears the flags', () => {
    const def = CONDUCTOR_V2_DRAFT_DEF;
    expect(ticketEditableOf(def, QUEUED_LANE)).toBe(true);
    expect(ticketEditableOf(def, 'needs_input')).toBe(true);
    expect(ticketEditableOf(def, 'implementing')).toBe(false);
    const on = setTicketEditable(def, 'implementing', true);
    expect(on.states.implementing!.ticket_editable).toBe(true);
    expect(ticketEditableOf(on, 'implementing')).toBe(true);
    expect(
      'ticket_editable' in setTicketEditable(on, 'implementing', undefined).states.implementing!,
    ).toBe(false);
    const closed = setQueuedTicketEditable(def, false);
    expect(ticketEditableOf(closed, QUEUED_LANE)).toBe(false);
    expect('queued_ticket_editable' in setQueuedTicketEditable(closed, undefined)).toBe(false);
    // The strict schema accepts the flags.
    expect(WorkflowDefinitionSchema.safeParse(setQueuedTicketEditable(on, false)).success).toBe(
      true,
    );
  });
});

describe('follow-up proposals per agent column (ADR-0034)', () => {
  it('on by default for the built-in templates; tunes max and guidance; off is stored', () => {
    const def = CONDUCTOR_V2_DRAFT_DEF;
    expect(followUpsOf(def, 'implementing')).toEqual({ enabled: true, max: 3 });
    const tuned = setFollowUps(setFollowUps(def, 'implementing', { max: 5 }), 'implementing', {
      guidance: 'Only test debt',
    });
    expect(followUpsOf(tuned, 'implementing')).toEqual({
      enabled: true,
      max: 5,
      guidance: 'Only test debt',
    });
    // A blank guidance removes it; max is kept.
    expect(
      followUpsOf(setFollowUps(tuned, 'implementing', { guidance: ' ' }), 'implementing'),
    ).toEqual({ enabled: true, max: 5 });
    // Off on a built-in template is stored, since unset means on there.
    const off = setFollowUps(tuned, 'implementing', null);
    expect(off.states.implementing).toMatchObject({ follow_ups: { enabled: false } });
    expect(followUpsOf(off, 'implementing')).toBeNull();
    // Non-agent columns are left alone, and the strict schema accepts the field.
    expect(setFollowUps(def, 'needs_input', {})).toEqual(def);
    expect(WorkflowDefinitionSchema.safeParse(tuned).success).toBe(true);
  });

  it('off by default for a custom prompt, and off removes the key there', () => {
    const def = structuredClone(CONDUCTOR_V2_DRAFT_DEF);
    const impl = def.states.implementing!;
    if (impl.type !== 'agent') throw new Error('implementing');
    impl.prompt = 'Do the thing.';
    expect(followUpsOf(def, 'implementing')).toBeNull();
    const on = setFollowUps(def, 'implementing', {});
    expect(on.states.implementing).toMatchObject({ follow_ups: { enabled: true, max: 3 } });
    expect('follow_ups' in setFollowUps(on, 'implementing', null).states.implementing!).toBe(false);
  });
});

describe('structure (UXR-67)', () => {
  const C = CONDUCTOR_V2_DEF;
  /** Server problems the base definition doesn't already have (v2 predates rule 17), as "rule N path". */
  const rules = (def: WorkflowDefinition) => {
    const r = validateWorkflow(def);
    return r.ok ? [] : r.errors.map((e) => `rule ${e.rule} ${e.path.join('.')}`);
  };
  const serverRules = (def: WorkflowDefinition) => {
    const before = rules(C);
    return rules(def).filter((r) => !before.includes(r));
  };
  const messages = (def: WorkflowDefinition) => validateColumns(def).map((i) => i.message);

  it('names a new column from its title, and refuses bad or taken names', () => {
    expect(slugFromTitle(C, 'Needs design')).toBe('needs_design');
    expect(slugFromTitle(C, '  Ready -> QA! ')).toBe('ready_qa');
    expect(slugFromTitle(C, 'Implementing')).toBe('implementing_2');
    expect(slugFromTitle(C, '2nd review')).toBe('column_2nd_review');
    expect(slugFromTitle(C, '')).toBe('column');
    expect(stateNameProblem(C, 'needs_design')).toBeNull();
    expect(stateNameProblem(C, '')).toBe('the name is empty');
    expect(stateNameProblem(C, 'Needs design')).toMatch(/^use lowercase letters/);
    expect(stateNameProblem(C, '__entry')).toMatch(/^use lowercase letters/);
    expect(stateNameProblem(C, 'done')).toBe('there is already a column "done"');
  });

  it('adds each kind of column where asked; it is valid but for its way in', () => {
    for (const kind of ['agent', 'person', 'waiting', 'end'] as const) {
      const { definition, name } = addColumn(C, { title: 'Design', kind, after: 'planning' });
      expect(name).toBe('design');
      expect(columnStates(definition)).toEqual([
        'planning',
        'design',
        'implementing',
        'needs_input',
        'waiting_external',
        'done',
      ]);
      expect(definition.columns).toEqual(columnStates(definition));
      expect(definition.states.design!.title).toBe('Design');
      expect(definition.start).toBe('planning');
      // Only rule 2 (nothing leads to it) until a transition does, here and on the server.
      expect(messages(definition)).toEqual([
        'Nothing leads to Design yet: add a transition into it from another column',
      ]);
      expect(serverRules(definition)).toEqual(['rule 2 states.design']);
      const reached = {
        ...definition,
        states: {
          ...definition.states,
          planning: {
            ...definition.states.planning!,
            on: { ...(C.states.planning as { on: object }).on, design: 'design' },
          },
        },
      } as WorkflowDefinition;
      expect(messages(reached)).toEqual([]);
      expect(serverRules(reached)).toEqual([]);
    }
  });

  it('a new agent column asks needs_input and gets its work; a waiting one moves on', () => {
    const agent = addColumn(C, {
      title: 'Review',
      kind: 'agent',
      after: 'implementing',
      prompt: 'plan_template',
      model: ' haiku ',
    }).definition.states.review;
    expect(agent).toEqual({
      type: 'agent',
      title: 'Review',
      prompt: 'plan_template',
      model: 'haiku',
      on: { ask_user: 'needs_input' },
    });
    const waiting = addColumn(C, { title: 'QA', kind: 'waiting', after: 'implementing' });
    expect(waiting.definition.states.qa).toEqual({
      type: 'event',
      title: 'QA',
      wait_for: ['ui.approve'],
      on: { 'ui.approve': 'needs_input' },
    });
    // First column: after Queued.
    const first = addColumn(C, { title: 'Triage', kind: 'person', after: QUEUED_LANE });
    expect(columnStates(first.definition)[0]).toBe('triage');
    expect(first.definition.start).toBe('planning');
  });

  it('refuses an agent column when no person column can be asked', () => {
    const noHuman: WorkflowDefinition = {
      ...C,
      start: 'a',
      on_budget_exceeded: 'a',
      columns: ['a'],
      states: { a: { type: 'terminal' } },
    };
    expect(addColumnProblem(noHuman, 'agent')).toMatch(/needs a Person column/);
    expect(() => addColumn(noHuman, { title: 'B', kind: 'agent', after: 'a' })).toThrow();
    expect(addColumnProblem(noHuman, 'person')).toBeNull();
  });

  it('moves a column left and right, and stops at the ends', () => {
    expect(columnStates(moveColumnBy(C, 'implementing', -1)).slice(0, 2)).toEqual([
      'implementing',
      'planning',
    ]);
    expect(columnStates(moveColumnBy(C, 'needs_input', 1))).toEqual([
      'planning',
      'implementing',
      'waiting_external',
      'needs_input',
      'done',
    ]);
    expect(moveColumnBy(C, 'planning', -1)).toBe(C);
    expect(moveColumnBy(C, 'done', 1)).toBe(C);
    expect(columnStates(moveColumn(C, 'done', 0))[0]).toBe('done');
    expect(columnStates(moveColumn(C, 'planning', 99)).at(-1)).toBe('planning');
    // Order is not a rule: still valid.
    expect(messages(moveColumn(C, 'done', 0))).toEqual([]);
  });

  it('says why a column cannot be removed', () => {
    expect(columnRemovalProblems(C, 'planning')).toEqual([
      'It is the first column: claimed tickets start here',
    ]);
    expect(columnRemovalProblems(C, 'waiting_external')).toEqual([
      'Implementing → Ready for testing leads here',
      'Needs input → Waiting on someone else leads here',
    ]);
    expect(columnRemovalProblems(C, 'needs_input')).toContain('Tickets over budget go here');
    expect(columnRemovalProblems(C, 'needs_input')).toContain(
      'Agent columns need a Person column to ask',
    );
    // A transition from another column leads here (its own on_unmet loops back don't count).
    expect(columnRemovalProblems(C, 'implementing')).toContain('Planning → Plan ready leads here');
    const added = addColumn(C, { title: 'Design', kind: 'person', after: 'planning' }).definition;
    expect(columnRemovalProblems(added, 'design')).toEqual([]);
    expect(columnRemovalProblems(added, 'design', { design: 2 })).toEqual(['2 tickets are in it']);
    expect(columnRemovalProblems(added, 'design', { design: 1 })).toEqual(['1 ticket is in it']);
  });

  it('removes a column and the transitions out of it; refuses one something leads to', () => {
    const added = addColumn(C, {
      title: 'Review',
      kind: 'agent',
      after: 'implementing',
    }).definition;
    const removed = removeColumn(added, 'review');
    expect(removed.states.review).toBeUndefined();
    expect(removed.columns).toEqual(C.columns);
    expect(removed).toEqual(C);
    expect(() => removeColumn(C, 'waiting_external')).toThrow(/leads here/);
  });

  it('flags a missing first column and an empty column list', () => {
    expect(messages({ ...C, columns: [] })).toContain('the workflow needs at least one column');
    const noStart = { ...C, start: 'gone' };
    expect(validateColumns(noStart).map((i) => [i.path, i.message])).toContainEqual([
      'start',
      'the first column "gone" does not exist',
    ]);
  });
});
