import {
  AVAILABLE_CONDITION_TYPES,
  AVAILABLE_TRANSITION_ACTIONS,
  CONDITION_TYPES,
  FALLBACK_TRANSITION_NAMES,
  RETURN_TO,
  TICKET_KINDS,
  TransitionActionSchema,
  transitionActor,
  transitionTitle,
  type Condition,
  type ConditionType,
  type EntryCheck,
  type TicketKind,
  type TransitionActor,
  type TransitionObject,
  type TransitionRequires,
  type WorkflowDefinition,
} from '@conductor/shared';
import { useId, useState, type ReactNode } from 'react';
import { columnStates, columnTitle, humanStates, type ColumnIssue } from './columns.js';
import {
  ACTION_TEXT,
  arrowTransitions,
  CONDITION_TEXT,
  conditionOfType,
  getTransitionObject,
  patchTransition,
  removeTransition,
  renameTransition,
  setRequires,
  transitionNameProblem,
} from './transitions.js';

// The arrow's panel (ADR-0011 §Editor and board): every transition between two columns, and the
// selected one's fields: name and title; when, actor, kinds and question; requires (checks with
// setup, review items, conductor's actions, external conditions with their timeout); and what
// happens when they are not met. Every change goes straight into the caller's draft.

const MAX_CHECKS = 20;
const MAX_ITEMS = 30;
const MAX_CONDITIONS = 10;

export interface TransitionEditorProps {
  definition: WorkflowDefinition;
  from: string;
  /** The selected transition (a key of `states.<from>.on`). */
  name: string;
  /** Client and server problems on transitions out of `from`. */
  issues: ColumnIssue[];
  onChange: (next: WorkflowDefinition) => void;
  /** Select another transition out of `from` (also after a rename). */
  onSelect: (name: string) => void;
  /** The transition was removed. */
  onRemoved: () => void;
  onClose: () => void;
}

const KIND_TEXT: Record<TicketKind, string> = { work: 'Work', personal: 'Personal' };

export function TransitionEditor(props: TransitionEditorProps) {
  const { definition, from, name, onSelect, onClose } = props;
  const t = getTransitionObject(definition, from, name);
  if (t === null) return null;
  const group = arrowTransitions(definition, from, t.goto);
  const to = t.goto === RETURN_TO ? 'the column that asked' : columnTitle(definition, t.goto);
  const problemsOf = (n: string) =>
    props.issues.filter((i) => i.transition?.from === from && i.transition.name === n).length;
  return (
    <aside className="wf-editor" aria-label="Transition">
      <div className="wf-editor-head">
        <h3>
          {columnTitle(definition, from)} → {to}
        </h3>
        <button type="button" onClick={onClose} aria-label="Close transition">
          ×
        </button>
      </div>
      {group.length > 1 && (
        <ul className="wf-transition-tabs" aria-label="Transitions on this arrow">
          {group.map((n) => (
            <li key={n}>
              <button
                type="button"
                aria-pressed={n === name}
                className={problemsOf(n) > 0 ? 'error' : undefined}
                onClick={() => onSelect(n)}
              >
                {n}
              </button>
            </li>
          ))}
        </ul>
      )}
      <TransitionForm
        // A rename keeps the key's place in `on`, so the form (and its name field) stays mounted.
        key={`${from}\u0000${Object.keys(onOf(definition, from)).indexOf(name)}`}
        {...props}
        transition={t}
      />
    </aside>
  );
}

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
  transition: t,
}: TransitionEditorProps & { transition: TransitionObject }) {
  const uid = useId();
  const [nameText, setNameText] = useState(name);
  /** The user picked "Custom command" (its text may still be empty, which reads as none). */
  const [customSetup, setCustomSetup] = useState(false);
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
  const setChecks = (next: EntryCheck[]) => setR({ checks: next });
  const items = r.review?.items ?? [];
  const setItems = (next: string[]) =>
    setR({ review: r.review ? { ...r.review, items: next } : { items: next } });
  const conditions = r.conditions ?? [];
  const setConditions = (next: Condition[]) => setR({ conditions: next });
  const actions = r.actions ?? [];

  const nameProblem = transitionNameProblem(definition, from, name, nameText);
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
  const setupMode: 'auto' | 'none' | 'custom' =
    r.setup === undefined ? 'auto' : r.setup === '' && !customSetup ? 'none' : 'custom';
  const legacyEntry =
    t.goto !== RETURN_TO && !FALLBACK_TRANSITION_NAMES.includes(name)
      ? definition.states[t.goto]?.entry
      : undefined;
  const u = t.on_unmet;

  const body = (
    <>
      <div className="wf-unmet">
        <label htmlFor={`${uid}-name`}>Name</label>
        <input
          id={`${uid}-name`}
          className="mono"
          value={nameText}
          onChange={(e) => {
            const next = e.target.value;
            setNameText(next);
            if (transitionNameProblem(definition, from, name, next) === null && next !== name) {
              onChange(renameTransition(definition, from, name, next));
              onSelect(next);
            }
          }}
        />
        <label htmlFor={`${uid}-title`}>Title</label>
        <input
          id={`${uid}-title`}
          value={t.title ?? ''}
          placeholder={transitionTitle(name, undefined)}
          onChange={(e) => patch({ title: e.target.value === '' ? undefined : e.target.value })}
        />
        <label htmlFor={`${uid}-goto`}>Goes to</label>
        <select id={`${uid}-goto`} value={t.goto} onChange={(e) => patch({ goto: e.target.value })}>
          {withCurrent(gotoOptions, t.goto).map((n) => (
            <option key={n} value={n}>
              {gotoText(n)}
            </option>
          ))}
        </select>
      </div>
      {nameText !== name && nameProblem !== null && (
        <p className="wf-field-error" role="alert">
          {nameProblem}
        </p>
      )}
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

      <h5>Checks</h5>
      <ol className="wf-items" aria-label="Checks">
        {checks.map((c, i) => (
          <li key={i} className="wf-item">
            <div className="wf-check">
              <input
                aria-label={`Check ${i + 1} name`}
                value={c.name}
                placeholder="e.g. Tests pass"
                onChange={(e) =>
                  setChecks(checks.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                }
              />
              <input
                aria-label={`Check ${i + 1} command`}
                className="mono"
                value={c.cmd}
                placeholder="e.g. npm test"
                onChange={(e) =>
                  setChecks(checks.map((x, j) => (j === i ? { ...x, cmd: e.target.value } : x)))
                }
              />
              <input
                aria-label={`Check ${i + 1} timeout`}
                className="mono"
                value={c.timeout ?? ''}
                placeholder="timeout (default)"
                onChange={(e) =>
                  setChecks(
                    checks.map((x, j) => {
                      if (j !== i) return x;
                      const next = { ...x };
                      delete next.timeout;
                      return e.target.value === '' ? next : { ...next, timeout: e.target.value };
                    }),
                  )
                }
              />
              {at(`.requires.checks.${i}.name`)}
              {at(`.requires.checks.${i}.cmd`)}
              {at(`.requires.checks.${i}.timeout`)}
            </div>
            <ItemActions
              what="check"
              i={i}
              n={checks.length}
              onMove={(j) => setChecks(swap(checks, i, j))}
              onRemove={() => setChecks(checks.filter((_, j) => j !== i))}
            />
          </li>
        ))}
      </ol>
      {at('.requires.checks')}
      <div>
        <button
          type="button"
          disabled={checks.length >= MAX_CHECKS}
          onClick={() => setChecks([...checks, { name: '', cmd: '' }])}
        >
          Add check
        </button>
      </div>
      {checks.length > 0 && (
        <div className="wf-setup">
          <label htmlFor={`${uid}-setup`}>
            Before the checks (in a fresh checkout of the commit)
          </label>
          <select
            id={`${uid}-setup`}
            value={setupMode}
            onChange={(e) => {
              const mode = e.target.value;
              setCustomSetup(mode === 'custom');
              if (mode === 'auto') setR({ setup: undefined });
              else if (mode === 'none') setR({ setup: '' });
              else setR({ setup: r.setup ?? '' });
            }}
          >
            <option value="auto">Auto-detect (npm ci / npm install)</option>
            <option value="none">None</option>
            <option value="custom">Custom command</option>
          </select>
          {setupMode === 'custom' && (
            <input
              aria-label="Setup command"
              className="mono"
              value={r.setup ?? ''}
              placeholder="e.g. pnpm install --frozen-lockfile"
              onChange={(e) => setR({ setup: e.target.value })}
            />
          )}
          {at('.requires.setup')}
        </div>
      )}

      <h5>Review</h5>
      <ol className="wf-items" aria-label="Review items">
        {items.map((item, i) => (
          <li key={i} className="wf-item">
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
              onMove={(j) => setItems(swap(items, i, j))}
              onRemove={() => setItems(items.filter((_, j) => j !== i))}
            />
          </li>
        ))}
      </ol>
      {at('.requires.review.items')}
      <div>
        <button
          type="button"
          disabled={items.length >= MAX_ITEMS}
          onClick={() => setItems([...items, ''])}
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
                review: e.target.value.trim() === '' ? { items } : { items, model: e.target.value },
              })
            }
          />
        </label>
      )}

      <h5>Actions</h5>
      {TransitionActionSchema.options
        .filter((a) => AVAILABLE_TRANSITION_ACTIONS.includes(a) || actions.includes(a))
        .map((a) => (
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
            {ACTION_TEXT[a] ?? a}
            {!AVAILABLE_TRANSITION_ACTIONS.includes(a) ? ' (not available yet)' : ''}
          </label>
        ))}
      {actions.map((_, i) => at(`.requires.actions.${i}`))}

      <h5>Conditions</h5>
      <p className="muted wf-note">
        External facts, checked on your machine and re-checked until they all hold.
      </p>
      <ol className="wf-items" aria-label="Conditions">
        {conditions.map((c, i) => {
          const set = (next: Condition) =>
            setConditions(conditions.map((x, j) => (j === i ? next : x)));
          const available = AVAILABLE_CONDITION_TYPES.includes(c.type);
          return (
            <li key={i} className="wf-item">
              <div className="wf-check">
                <select
                  aria-label={`Condition ${i + 1} type`}
                  value={c.type}
                  onChange={(e) => set(conditionOfType(e.target.value as ConditionType, c))}
                >
                  {CONDITION_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {CONDITION_TEXT[type]}
                      {AVAILABLE_CONDITION_TYPES.includes(type) ? '' : ' (not available yet)'}
                    </option>
                  ))}
                </select>
                {c.type === 'pr_approvals' && (
                  <input
                    aria-label={`Condition ${i + 1} approvals`}
                    type="number"
                    min={1}
                    max={20}
                    step={1}
                    value={Number.isNaN(c.min) ? '' : c.min}
                    onChange={(e) =>
                      set({ ...c, min: e.target.value === '' ? NaN : Number(e.target.value) })
                    }
                  />
                )}
                {c.type === 'azure_pipeline_succeeded' && (
                  <input
                    aria-label={`Condition ${i + 1} pipeline`}
                    value={c.pipeline}
                    placeholder="pipeline name"
                    onChange={(e) => set({ ...c, pipeline: e.target.value })}
                  />
                )}
                {c.type === 'jira_fields_set' && (
                  <ListInput
                    label={`Condition ${i + 1} fields`}
                    value={c.fields}
                    placeholder="resolution, status"
                    onChange={(fields) => set({ ...c, fields })}
                  />
                )}
                <input
                  aria-label={`Condition ${i + 1} label`}
                  value={c.label ?? ''}
                  placeholder="checklist label (default)"
                  onChange={(e) => {
                    const next = { ...c };
                    delete next.label;
                    set(e.target.value === '' ? next : { ...next, label: e.target.value });
                  }}
                />
                <label className="wf-toggle">
                  <input
                    type="checkbox"
                    checked={c.enabled !== false}
                    onChange={(e) => {
                      const next = { ...c };
                      delete next.enabled;
                      set(e.target.checked ? next : { ...next, enabled: false });
                    }}
                  />
                  Enabled{available ? '' : ' (declare it disabled until it is available)'}
                </label>
                {at(`.requires.conditions.${i}`)}
                {at(`.requires.conditions.${i}.min`)}
                {at(`.requires.conditions.${i}.pipeline`)}
                {at(`.requires.conditions.${i}.fields`)}
                {at(`.requires.conditions.${i}.label`)}
              </div>
              <ItemActions
                what="condition"
                i={i}
                n={conditions.length}
                onMove={(j) => setConditions(swap(conditions, i, j))}
                onRemove={() => setConditions(conditions.filter((_, j) => j !== i))}
              />
            </li>
          );
        })}
      </ol>
      {at('.requires.conditions')}
      <div>
        <button
          type="button"
          disabled={conditions.length >= MAX_CONDITIONS}
          onClick={() => setConditions([...conditions, { type: 'pr_checks_green' }])}
        >
          Add condition
        </button>
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

      {u !== undefined && (
        <>
          <h5>When not met</h5>
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
            <textarea
              id={`${uid}-instruction`}
              rows={3}
              value={u.instruction ?? ''}
              placeholder="What the agent should do about it (optional)"
              onChange={(e) => {
                const rest = { ...u };
                delete rest.instruction;
                const v = e.target.value;
                patch({ on_unmet: v.trim() === '' ? rest : { ...rest, instruction: v } });
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
        </>
      )}
      {at('.on_unmet')}
      {at('.on_unmet.goto')}
      {at('.on_unmet.instruction')}
      {at('.on_unmet.retries')}
      {at('.on_unmet.else')}

      <div>
        <button
          type="button"
          className="danger"
          onClick={() => {
            onChange(removeTransition(definition, from, name));
            onRemoved();
          }}
        >
          Remove transition
        </button>
      </div>
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

/** A comma-separated list, kept as typed while editing. */
function ListInput({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string[];
  placeholder: string;
  onChange: (next: string[]) => void;
}) {
  const [text, setText] = useState(value.join(', '));
  return (
    <input
      aria-label={label}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onChange(
          e.target.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }}
    />
  );
}

function ItemActions({
  what,
  i,
  n,
  onMove,
  onRemove,
}: {
  what: string;
  i: number;
  n: number;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="wf-item-actions">
      <button
        type="button"
        aria-label={`Move ${what} ${i + 1} up`}
        disabled={i === 0}
        onClick={() => onMove(i - 1)}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label={`Move ${what} ${i + 1} down`}
        disabled={i === n - 1}
        onClick={() => onMove(i + 1)}
      >
        ↓
      </button>
      <button
        type="button"
        aria-label={`Remove ${what} ${i + 1}`}
        className="danger"
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}

function swap<T>(list: T[], i: number, j: number): T[] {
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** Options plus the current value, so a select never silently shows a different state. */
const withCurrent = (names: string[], current: string) =>
  names.includes(current) ? names : [...names, current];
