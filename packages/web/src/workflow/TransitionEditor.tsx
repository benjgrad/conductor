import {
  AVAILABLE_CONDITION_TYPES,
  AVAILABLE_TRANSITION_ACTIONS,
  FALLBACK_TRANSITION_NAMES,
  RETURN_TO,
  TICKET_KINDS,
  TransitionActionSchema,
  transitionActor,
  transitionTitle,
  type Condition,
  type ConditionType,
  type TicketKind,
  type TransitionActor,
  type TransitionObject,
  type TransitionRequires,
  type WorkflowDefinition,
} from '@conductor/shared';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  ChecksFields,
  checksFieldSuffixes,
  leftItem,
  ItemActions,
  swap,
  useFocusNew,
} from './ChecksFields.js';
import { ConditionRow } from './ConditionFields.js';
import { columnStates, columnTitle, humanStates, type ColumnIssue } from './columns.js';
import { EditorHead, type Crumb } from './EditorHead.js';
import { InstructionField } from './InstructionField.js';
import { instructionsOf, setPresets } from './instructions.js';
import { RepoOverridesHint } from './RepoOverridesHint.js';
import {
  ACTION_SHORT,
  ACTION_TEXT,
  addCondition,
  CONDITION_TEXT,
  conditionOfType,
  DEFAULT_CONDITION_POLL,
  describeTransition,
  getTransitionObject,
  parentOf,
  patchTransition,
  removeTransition,
  renameTransition,
  requiresAnything,
  sectionOfPath,
  setRequires,
  transitionNameProblem,
  type TransitionSection,
} from './transitions.js';

// One transition's panel (ADR-0011 §Editor and board): a breadcrumb back to its column and arrow
// (UXR-66), a sentence saying what it does (UXR-60), then its fields in collapsible sections: who
// and when (title, target, when, actor, kinds, question, notify, and its name under Advanced, renamed
// on blur or Enter: agents report it, UXR-65); requires (checks with setup, review items,
// conductor's actions, external conditions with their timeout); and what happens when they are not
// met, right after them. Removing it asks first. Every change goes straight into the caller's draft.

const MAX_ITEMS = 30;
const MAX_CONDITIONS = 10;

export interface TransitionEditorProps {
  definition: WorkflowDefinition;
  from: string;
  /** The selected transition (a key of `states.<from>.on`). */
  name: string;
  /** Client and server problems on transitions out of `from` (not those of still-new items). */
  issues: ColumnIssue[];
  /**
   * UXR-71: an item was added at this path prefix; its problems wait until it loses focus
   * (`onReveal`) or Save. `onRevealUnder` shows every new item of a list whose indexes shifted.
   */
  onDefer?: (prefix: string) => void;
  onReveal?: (prefix: string) => void;
  onRevealUnder?: (listPrefix: string) => void;
  onChange: (next: WorkflowDefinition) => void;
  /** Select another transition out of `from` (also after a rename). */
  onSelect: (name: string) => void;
  /** The transition was removed. */
  onRemoved: () => void;
  /** Open a column's panel (the first crumb). */
  onSelectColumn: (state: string) => void;
  /** Open an arrow's list (the middle crumb, when the arrow stands for several). */
  onSelectArrow: (from: string, to: string) => void;
  /** Back to the parent: the arrow's list, or the column. */
  onBack: () => void;
  onClose: () => void;
  /** UXR-67: a just-created transition: its Title gets the focus. */
  focusTitle?: boolean;
  /**
   * ADR-0030: the repos with their own check override (`listRepoChecks`), named under the checks
   * (UXR-75). Absent or [] = none.
   */
  repoOverrides?: readonly string[];
  /** UXR-44: the phone's full-screen panel. */
  fullScreen?: boolean;
}

const KIND_TEXT: Record<TicketKind, string> = { work: 'Work', personal: 'Personal' };

export function TransitionEditor(props: TransitionEditorProps) {
  const { definition, from, name, onClose, onSelectColumn, onSelectArrow, onBack } = props;
  const fullScreen = props.fullScreen ?? false;
  const t = getTransitionObject(definition, from, name);
  if (t === null) return null;
  const parent = parentOf(definition, from, name);
  const fromTitle = columnTitle(definition, from);
  const arrow = `${fromTitle} → ${columnTitle(definition, t.goto)}`;
  const title = transitionTitle(name, t);
  const crumbs: Crumb[] = [
    { label: fromTitle, onClick: () => onSelectColumn(from) },
    ...(parent.kind === 'arrow'
      ? [{ label: arrow, onClick: () => onSelectArrow(from, t.goto) }]
      : []),
    { label: title },
  ];
  return (
    <aside className={`wf-editor${fullScreen ? ' full-screen' : ''}`} aria-label="Transition">
      <EditorHead
        crumbs={crumbs}
        title={title}
        back={{
          label: `Back to ${parent.kind === 'arrow' ? arrow : fromTitle}`,
          onClick: onBack,
        }}
        closeLabel="Close transition"
        onClose={onClose}
        fullScreen={fullScreen}
      />
      <p className="wf-summary" aria-label="Summary" aria-live="polite">
        {bold(describeTransition(definition, from, name))}
      </p>
      <TransitionForm
        // A rename keeps the key's place in `on`, so the form (and its name field) stays mounted.
        key={`${from}\u0000${Object.keys(onOf(definition, from)).indexOf(name)}`}
        {...props}
        transition={t}
      />
    </aside>
  );
}

/** `**x**` → <strong>x</strong> (describeTransition's bold). */
function bold(text: string): ReactNode {
  return text
    .split(/\*\*(.+?)\*\*/)
    .map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part));
}

const ACTOR_TEXT: Record<TransitionActor, string> = {
  agent: 'the agent',
  human: 'a person',
  system: 'the system',
};

function onOf(def: WorkflowDefinition, from: string) {
  const s = def.states[from];
  return s && s.type !== 'terminal' ? (s.on ?? {}) : {};
}

function TransitionForm({
  definition,
  from,
  name,
  issues,
  onChange,
  onSelect,
  onRemoved,
  repoOverrides = [],
  onDefer,
  onReveal,
  onRevealUnder,
  focusTitle,
  transition: t,
}: TransitionEditorProps & { transition: TransitionObject }) {
  const uid = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusTitle) titleRef.current?.focus();
    // Once, when a new transition opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { list: reviewList, focusNew: focusReview } = useFocusNew<HTMLOListElement>('textarea');
  const { list: conditionList, focusNew: focusCondition } = useFocusNew<HTMLOListElement>(
    'input, select, textarea, button',
  );
  const [nameText, setNameText] = useState(name);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // UXR-65: agents report the name, so a rename applies when the field is left (or on Enter),
  // never per keystroke.
  const commitName = () => {
    if (nameText !== name && transitionNameProblem(definition, from, name, nameText) === null) {
      onChange(renameTransition(definition, from, name, nameText));
      onSelect(nameText);
    }
  };
  const state = definition.states[from]!;
  const base = `states.${from}.on.${name}`;
  const shownPaths = new Set<string>();
  const at = (suffix: string): ReactNode => {
    const path = `${base}${suffix}`;
    shownPaths.add(path);
    return issues
      .filter((i) => i.path === path)
      .map((i) => (
        <p key={i.message} className="wf-field-error" role="alert">
          {i.message}
        </p>
      ));
  };
  const patch = (p: Partial<TransitionObject>) =>
    onChange(patchTransition(definition, from, name, p));
  const r: TransitionRequires = t.requires ?? {};
  const setR = (p: Partial<TransitionRequires>) =>
    onChange(setRequires(definition, from, name, { ...r, ...p }));
  const checks = r.checks ?? [];
  // The check list shows its own problems (relative to `requires`).
  const requiresBase = `${base}.requires.`;
  const checkSuffixes = checksFieldSuffixes(checks);
  for (const suffix of checkSuffixes) shownPaths.add(`${requiresBase}${suffix}`);
  const checkIssues = issues.flatMap((i) => {
    const suffix = i.path.startsWith(requiresBase) ? i.path.slice(requiresBase.length) : null;
    return suffix !== null && checkSuffixes.has(suffix) ? [{ suffix, message: i.message }] : [];
  });
  const items = r.review?.items ?? [];
  const setItems = (next: string[]) =>
    setR({ review: r.review ? { ...r.review, items: next } : { items: next } });
  const conditions = r.conditions ?? [];
  const setConditions = (next: Condition[]) => setR({ conditions: next });
  const actions = r.actions ?? [];

  const nameProblem = transitionNameProblem(definition, from, name, nameText);
  const nameInvalid = nameText !== name && nameProblem !== null;
  const advancedShown = advancedOpen || nameInvalid;
  const inferred = transitionActor(definition, from, name, { ...t, actor: undefined });
  const kinds = t.kinds ?? TICKET_KINDS;
  const toggleKind = (k: TicketKind, on: boolean) => {
    const next = TICKET_KINDS.filter((x) => (x === k ? on : kinds.includes(x)));
    patch({ kinds: next.length === TICKET_KINDS.length ? undefined : next });
  };
  const gotoOptions = [
    ...columnStates(definition),
    ...(state.type === 'human' || t.goto === RETURN_TO ? [RETURN_TO] : []),
  ];
  const gotoText = (n: string) =>
    n === RETURN_TO ? 'Back to the column that asked' : columnTitle(definition, n);
  const backTo = columnStates(definition).filter((n) => definition.states[n]?.type !== 'terminal');
  const humans = humanStates(definition);
  const legacyEntry =
    t.goto !== RETURN_TO && !FALLBACK_TRANSITION_NAMES.includes(name)
      ? definition.states[t.goto]?.entry
      : undefined;
  const u = t.on_unmet;

  // UXR-63: each section starts open when it has content or a problem. A click overrides that,
  // until a new problem appears in it (which opens it again).
  const errors: Record<TransitionSection, number> = {
    who: nameInvalid ? 1 : 0,
    checks: 0,
    review: 0,
    actions: 0,
    conditions: 0,
    unmet: 0,
  };
  for (const i of issues) {
    if (i.transition?.from !== from || i.transition.name !== name) continue;
    if (!i.path.startsWith(base)) continue;
    const section = sectionOfPath(i.path.slice(base.length));
    if (section !== null) errors[section] += 1;
  }
  const content: Record<TransitionSection, boolean> = {
    who: true,
    checks: checks.length > 0,
    review: items.length > 0,
    actions: actions.length > 0,
    conditions: conditions.length > 0,
    unmet: u !== undefined,
  };
  const [override, setOverride] = useState<Partial<Record<TransitionSection, boolean>>>({});
  const errorKey = SECTIONS.map((sec) => errors[sec]).join(',');
  // A count that rose since the last render drops the override (adjusting state while
  // rendering, so the section is open in the same commit as its new problem).
  const [prevErrorKey, setPrevErrorKey] = useState(errorKey);
  if (prevErrorKey !== errorKey) {
    const before = prevErrorKey.split(',').map(Number);
    const rose = SECTIONS.filter((sec, i) => errors[sec] > (before[i] ?? 0));
    setPrevErrorKey(errorKey);
    if (rose.some((sec) => override[sec] !== undefined)) {
      const next = { ...override };
      for (const sec of rose) delete next[sec];
      setOverride(next);
    }
  }
  const isOpen = (sec: TransitionSection) => override[sec] ?? (content[sec] || errors[sec] > 0);
  const section = (sec: TransitionSection) => ({
    id: `${uid}-${sec}`,
    open: isOpen(sec),
    error: errors[sec] > 0,
    onToggle: () => setOverride((o) => ({ ...o, [sec]: !isOpen(sec) })),
  });
  const narrowed = kinds.length < TICKET_KINDS.length;
  const whoStatus = `(${ACTOR_TEXT[t.actor ?? inferred]}${narrowed ? ` · ${kinds.join(', ')}` : ''})`;
  const actionStatus = `(${
    actions.length === 0 ? 'none' : actions.map((a) => ACTION_SHORT[a]).join(', ')
  })`;
  const conditionStatus =
    conditions.length === 0
      ? '(0)'
      : `(${conditions.length} · ${
          r.condition_timeout !== undefined ? `wait ${r.condition_timeout}, ` : ''
        }poll ${r.condition_poll ?? DEFAULT_CONDITION_POLL})`;
  const unmetStatus =
    u === undefined
      ? ''
      : `(${u.retries === 0 ? '' : `back to ${columnTitle(definition, u.goto)} · ${Number.isFinite(u.retries) ? u.retries : '?'}× · `}then ${columnTitle(definition, u.else)})`;

  const body = (
    <>
      <Section title="Who and when" status={whoStatus} {...section('who')}>
        <div className="wf-unmet">
          <label htmlFor={`${uid}-title`}>Title</label>
          <input
            ref={titleRef}
            id={`${uid}-title`}
            value={t.title ?? ''}
            placeholder={transitionTitle(name, undefined)}
            onChange={(e) => patch({ title: e.target.value === '' ? undefined : e.target.value })}
          />
          <label htmlFor={`${uid}-goto`}>Goes to</label>
          <select
            id={`${uid}-goto`}
            value={t.goto}
            onChange={(e) => patch({ goto: e.target.value })}
          >
            {withCurrent(gotoOptions, t.goto).map((n) => (
              <option key={n} value={n}>
                {gotoText(n)}
              </option>
            ))}
          </select>
        </div>
        {at('')}
        {at('.title')}
        {at('.goto')}

        <label className="wf-field">
          When to take it
          <textarea
            rows={3}
            value={t.when ?? ''}
            placeholder="e.g. The plan is complete and needs no decision from a human."
            onChange={(e) => patch({ when: e.target.value === '' ? undefined : e.target.value })}
          />
        </label>
        {at('.when')}

        <div className="wf-unmet">
          <label htmlFor={`${uid}-actor`}>Taken by</label>
          <select
            id={`${uid}-actor`}
            value={t.actor ?? ''}
            onChange={(e) =>
              patch({
                actor: e.target.value === '' ? undefined : (e.target.value as TransitionActor),
              })
            }
          >
            <option value="">Inferred ({inferred})</option>
            <option value="agent">The agent</option>
            <option value="human">A person</option>
            <option value="system">The system</option>
          </select>
        </div>
        {at('.actor')}
        <fieldset className="wf-kinds">
          <legend>For tickets</legend>
          {TICKET_KINDS.map((k) => (
            <label key={k} className="wf-toggle">
              <input
                type="checkbox"
                checked={kinds.includes(k)}
                onChange={(e) => toggleKind(k, e.target.checked)}
              />
              {KIND_TEXT[k]}
            </label>
          ))}
        </fieldset>
        {at('.kinds')}
        <label className="wf-toggle">
          <input
            type="checkbox"
            checked={t.question === true}
            onChange={(e) => patch({ question: e.target.checked ? true : undefined })}
          />
          Asks a question (the agent’s reason is the question)
        </label>
        {at('.question')}
        <label className="wf-toggle">
          <input
            type="checkbox"
            checked={t.notify === true}
            onChange={(e) => patch({ notify: e.target.checked ? true : undefined })}
          />
          Notify me when this is taken
        </label>
        {at('.notify')}
        {/* ADR-0037 P5: shown while set, so a refused one (rule 21) can be unticked. */}
        {(t.presets !== undefined ||
          ((t.actor ?? inferred) === 'human' &&
            t.text !== undefined &&
            instructionsOf(definition).length > 0)) && (
          <fieldset className="wf-kinds">
            <legend>Saved replies (fill the text box)</legend>
            {[
              ...new Set([...instructionsOf(definition).map(([k]) => k), ...(t.presets ?? [])]),
            ].map((slug) => (
              <label key={slug} className="wf-toggle">
                <input
                  type="checkbox"
                  checked={(t.presets ?? []).includes(slug)}
                  onChange={(e) => {
                    const now = t.presets ?? [];
                    onChange(
                      setPresets(
                        definition,
                        from,
                        name,
                        e.target.checked ? [...now, slug] : now.filter((x) => x !== slug),
                      ),
                    );
                  }}
                />
                {slug}
              </label>
            ))}
          </fieldset>
        )}
        {at('.presets')}

        <div className="wf-advanced">
          <button
            type="button"
            aria-expanded={advancedShown}
            aria-controls={`${uid}-advanced`}
            className={nameInvalid ? 'error' : undefined}
            onClick={() => setAdvancedOpen(!advancedShown)}
          >
            <span className="wf-chevron" aria-hidden="true">
              {advancedShown ? '▾' : '▸'}
            </span>
            Advanced
          </button>
          <div id={`${uid}-advanced`} hidden={!advancedShown}>
            <div className="wf-unmet">
              <label htmlFor={`${uid}-name`}>Name</label>
              <input
                id={`${uid}-name`}
                className="mono"
                value={nameText}
                aria-describedby={`${uid}-name-note`}
                onChange={(e) => setNameText(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitName();
                  } else if (e.key === 'Escape') setNameText(name);
                }}
              />
            </div>
            <p id={`${uid}-name-note`} className="muted wf-note">
              Agents report this name; prompts and history refer to it.
            </p>
            {nameInvalid && (
              <p className="wf-field-error" role="alert">
                {nameProblem}
              </p>
            )}
          </div>
        </div>
      </Section>

      <h4>Requires</h4>
      <p className="muted wf-note">
        Before the ticket moves: the checks run on a fresh checkout of the commit, a reviewer judges
        the review items, conductor performs the actions, then the conditions are polled until they
        hold. The card stays in {columnTitle(definition, from)} meanwhile.
      </p>
      {at('.requires')}
      {t.requirements !== undefined && (
        <p className="wf-note" role="note">
          Old requirements (ADR-0009): {t.requirements.items.length} review item
          {t.requirements.items.length === 1 ? '' : 's'}. Saving moves them into the review below.
        </p>
      )}
      {legacyEntry !== undefined && (
        <p className="wf-note" role="note">
          {columnTitle(definition, t.goto)} has requirements to enter (old version). Saved as
          transition requirements: saving moves them onto this transition.
        </p>
      )}

      <Section title="Checks" status={`(${checks.length})`} {...section('checks')}>
        <ChecksFields
          checks={checks}
          setup={r.setup}
          onChange={(next) => setR({ checks: next.checks, setup: next.setup })}
          issues={checkIssues}
          onAdded={(i) => onDefer?.(`${base}.requires.checks.${i}`)}
          onItemBlur={(i) => onReveal?.(`${base}.requires.checks.${i}`)}
          onReordered={() => onRevealUnder?.(`${base}.requires.checks`)}
        />
        {/* An override replaces only a list with at least one check (applyRepoChecks): a
            transition without checks runs none, whatever the repo. */}
        {checks.length > 0 && <RepoOverridesHint repos={repoOverrides} />}
      </Section>

      <Section title="Review" status={`(${items.length})`} {...section('review')}>
        <ol ref={reviewList} className="wf-items" aria-label="Review items">
          {items.map((item, i) => (
            <li
              key={i}
              className="wf-item"
              data-item={i}
              onBlur={(e) => {
                if (leftItem(e)) onReveal?.(`${base}.requires.review.items.${i}`);
              }}
            >
              <div>
                <textarea
                  aria-label={`Review item ${i + 1}`}
                  rows={2}
                  value={item}
                  placeholder="e.g. New code paths have unit tests"
                  onChange={(e) => setItems(items.map((x, j) => (j === i ? e.target.value : x)))}
                />
                {at(`.requires.review.items.${i}`)}
              </div>
              <ItemActions
                what="review item"
                i={i}
                n={items.length}
                onMove={(j) => {
                  onRevealUnder?.(`${base}.requires.review.items`);
                  setItems(swap(items, i, j));
                }}
                onRemove={() => {
                  onRevealUnder?.(`${base}.requires.review.items`);
                  setItems(items.filter((_, j) => j !== i));
                }}
              />
            </li>
          ))}
        </ol>
        {at('.requires.review.items')}
        <div>
          <button
            type="button"
            disabled={items.length >= MAX_ITEMS}
            onClick={() => {
              onDefer?.(`${base}.requires.review.items.${items.length}`);
              setItems([...items, '']);
              focusReview(items.length);
            }}
          >
            Add review item
          </button>
        </div>
        {items.length > 0 && (
          <label className="wf-field">
            Reviewer model
            <input
              value={r.review?.model ?? ''}
              placeholder="account default"
              onChange={(e) =>
                setR({
                  review:
                    e.target.value.trim() === '' ? { items } : { items, model: e.target.value },
                })
              }
            />
          </label>
        )}
      </Section>

      <Section title="Actions" status={actionStatus} {...section('actions')}>
        {/* UXR-78: an action conductor can't perform yet shows only when this version has it. */}
        {TransitionActionSchema.options
          .filter((a) => AVAILABLE_TRANSITION_ACTIONS.includes(a) || actions.includes(a))
          .map((a) =>
            AVAILABLE_TRANSITION_ACTIONS.includes(a) ? (
              <label key={a} className="wf-toggle">
                <input
                  type="checkbox"
                  checked={actions.includes(a)}
                  onChange={(e) =>
                    setR({
                      actions: e.target.checked ? [...actions, a] : actions.filter((x) => x !== a),
                    })
                  }
                />
                {ACTION_TEXT[a]}
              </label>
            ) : (
              <p key={a} className="wf-condition-note">
                {ACTION_TEXT[a]} <span className="muted">Not available yet: skipped</span>
                <button
                  type="button"
                  aria-label={`Remove ${ACTION_TEXT[a]}`}
                  onClick={() => setR({ actions: actions.filter((x) => x !== a) })}
                >
                  Remove
                </button>
              </p>
            ),
          )}
        {actions.map((_, i) => at(`.requires.actions.${i}`))}
      </Section>

      <Section title="Conditions" status={conditionStatus} {...section('conditions')}>
        <p className="muted wf-note">
          External facts, checked on your machine and re-checked until they all hold.
        </p>
        <ol ref={conditionList} className="wf-items" aria-label="Conditions">
          {conditions.map((c, i) => (
            <ConditionRow
              // A removal re-keys the rows after it, so their list inputs reset to the value.
              key={`${i}:${c.type}:${conditions.length}`}
              condition={c}
              i={i}
              n={conditions.length}
              onChange={(next) => setConditions(conditions.map((x, j) => (j === i ? next : x)))}
              onMove={(j) => {
                onRevealUnder?.(`${base}.requires.conditions`);
                setConditions(swap(conditions, i, j));
              }}
              onRemove={() => {
                onRevealUnder?.(`${base}.requires.conditions`);
                setConditions(conditions.filter((_, j) => j !== i));
              }}
              onBlur={(e) => {
                if (leftItem(e)) onReveal?.(`${base}.requires.conditions.${i}`);
              }}
              issuesAt={(field) => at(`.requires.conditions.${i}${field}`)}
            />
          ))}
        </ol>
        {at('.requires.conditions')}
        <div>
          {/* UXR-78: only the types conductor can evaluate are offered. */}
          <select
            aria-label="Add condition"
            value=""
            disabled={conditions.length >= MAX_CONDITIONS}
            onChange={(e) => {
              const type = e.target.value;
              if (type !== '') {
                onDefer?.(`${base}.requires.conditions.${conditions.length}`);
                onChange(
                  setRequires(
                    definition,
                    from,
                    name,
                    addCondition(r, conditionOfType(type as ConditionType)),
                  ),
                );
                focusCondition(conditions.length);
              }
            }}
          >
            <option value="">Add condition…</option>
            {AVAILABLE_CONDITION_TYPES.map((type) => (
              <option key={type} value={type}>
                {CONDITION_TEXT[type]}
              </option>
            ))}
          </select>
        </div>
        {conditions.length > 0 && (
          <div className="wf-unmet">
            <label htmlFor={`${uid}-ctimeout`}>Wait at most</label>
            <input
              id={`${uid}-ctimeout`}
              className="mono"
              value={r.condition_timeout ?? ''}
              placeholder="e.g. 3d"
              onChange={(e) =>
                setR({ condition_timeout: e.target.value === '' ? undefined : e.target.value })
              }
            />
            <label htmlFor={`${uid}-cpoll`}>Check every</label>
            <input
              id={`${uid}-cpoll`}
              className="mono"
              value={r.condition_poll ?? ''}
              placeholder="2m (default)"
              onChange={(e) =>
                setR({ condition_poll: e.target.value === '' ? undefined : e.target.value })
              }
            />
          </div>
        )}
        {at('.requires.condition_timeout')}
        {at('.requires.condition_poll')}
      </Section>

      {u === undefined && !requiresAnything(r) && (
        <p className="muted wf-note">
          Nothing is required: the move happens as soon as it’s taken.
        </p>
      )}
      {u !== undefined && (
        <Section title="If the requirements aren’t met" status={unmetStatus} {...section('unmet')}>
          <div className="wf-unmet">
            <label htmlFor={`${uid}-ugoto`}>Back to</label>
            <select
              id={`${uid}-ugoto`}
              value={u.goto}
              onChange={(e) => patch({ on_unmet: { ...u, goto: e.target.value } })}
            >
              {withCurrent(backTo, u.goto).map((n) => (
                <option key={n} value={n}>
                  {columnTitle(definition, n)}
                </option>
              ))}
            </select>
            <label htmlFor={`${uid}-instruction`}>With instruction</label>
            <InstructionField
              definition={definition}
              id={`${uid}-instruction`}
              value={u.instruction}
              placeholder="What the agent should do about it (optional)"
              onChange={(v) => {
                const rest = { ...u };
                delete rest.instruction;
                patch({ on_unmet: v === undefined ? rest : { ...rest, instruction: v } });
              }}
            />
            <label htmlFor={`${uid}-retries`}>Up to (times)</label>
            <input
              id={`${uid}-retries`}
              type="number"
              min={0}
              max={10}
              step={1}
              value={Number.isNaN(u.retries) ? '' : u.retries}
              onChange={(e) =>
                patch({
                  on_unmet: { ...u, retries: e.target.value === '' ? NaN : Number(e.target.value) },
                })
              }
            />
            <label htmlFor={`${uid}-else`}>Then</label>
            <select
              id={`${uid}-else`}
              value={u.else}
              onChange={(e) => patch({ on_unmet: { ...u, else: e.target.value } })}
            >
              {withCurrent(humans, u.else).map((n) => (
                <option key={n} value={n}>
                  {columnTitle(definition, n)}
                </option>
              ))}
            </select>
          </div>
          {at('.on_unmet')}
          {at('.on_unmet.goto')}
          {at('.on_unmet.instruction')}
          {at('.on_unmet.retries')}
          {at('.on_unmet.else')}
        </Section>
      )}

      {confirmRemove ? (
        <div className="wf-confirm" role="alertdialog" aria-label="Remove transition">
          <span>
            Remove {transitionTitle(name, t)}? Agents can no longer take <code>{name}</code>. You
            can still discard the draft.
          </span>
          <button
            type="button"
            className="danger"
            onClick={() => {
              setConfirmRemove(false);
              onChange(removeTransition(definition, from, name));
              onRemoved();
            }}
          >
            Remove
          </button>
          <button type="button" onClick={() => setConfirmRemove(false)} autoFocus>
            Cancel
          </button>
        </div>
      ) : (
        <div>
          <button type="button" className="danger" onClick={() => setConfirmRemove(true)}>
            Remove transition
          </button>
        </div>
      )}
    </>
  );
  // Anything on this transition not shown next to a field (e.g. a server rule) goes at the end.
  const rest = issues.filter(
    (i) => i.transition?.from === from && i.transition.name === name && !shownPaths.has(i.path),
  );
  return (
    <>
      {body}
      {rest.map((i) => (
        <p key={`${i.path}:${i.message}`} className="wf-field-error" role="alert">
          {i.message}
        </p>
      ))}
    </>
  );
}

const SECTIONS: readonly TransitionSection[] = [
  'who',
  'checks',
  'review',
  'actions',
  'conditions',
  'unmet',
];

/** A collapsible part of the form (UXR-63): its header says what is in it. */
function Section({
  id,
  title,
  status,
  open,
  error,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  status: string;
  open: boolean;
  error: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="wf-section" aria-labelledby={`${id}-head`}>
      <h4 className="wf-section-head">
        <button
          id={`${id}-head`}
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          className={error ? 'error' : undefined}
          onClick={onToggle}
        >
          <span className="wf-chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          {title}
          {status !== '' && (
            <>
              {' '}
              <span className="wf-section-status">{status}</span>
            </>
          )}
        </button>
      </h4>
      <div id={`${id}-body`} className="wf-section-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

/** Options plus the current value, so a select never silently shows a different state. */
const withCurrent = (names: string[], current: string) =>
  names.includes(current) ? names : [...names, current];
