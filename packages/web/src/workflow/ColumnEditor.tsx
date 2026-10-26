import type { EntryCheck, WorkflowDefinition } from '@conductor/shared';
import { useId, useState, type ReactNode } from 'react';
import {
  columnStates,
  columnTitle,
  entryDraft,
  humanStates,
  normalizeEntry,
  PROMPT_TEMPLATES,
  setAgentWork,
  setEntry,
  setTitle,
  type ColumnIssue,
  type EntryDraft,
} from './columns.js';

// The side panel for one column (ADR-0010): its title, its work and its requirements to enter
// (checks, review items, conductor actions, and what happens when they are not met). Every change
// goes straight into the caller's draft definition.

const MAX_CHECKS = 20;
const MAX_ITEMS = 30;

export interface ColumnEditorProps {
  definition: WorkflowDefinition;
  state: string;
  /** Client and server problems in this column. */
  issues: ColumnIssue[];
  onChange: (next: WorkflowDefinition) => void;
  onClose: () => void;
}

export const START_NOTE =
  'The first column has no requirements to enter: a machine claiming the ticket moves it here, not an outcome.';

export const HUMAN_NOTE =
  'A human column has no requirements to enter: failure paths must reach a person unconditionally.';

const TYPE_TEXT: Record<string, string> = {
  human: 'A person answers or approves (human state).',
  terminal: 'Final: the ticket is done (terminal state).',
  command: 'Runs a command (command state).',
  connector: 'Calls a connector (connector state).',
};

export function ColumnEditor({ definition, state, issues, onChange, onClose }: ColumnEditorProps) {
  const uid = useId();
  /** The user picked "Custom command" (its text may still be empty, which reads as none). */
  const [customSetup, setCustomSetup] = useState(false);
  const s = definition.states[state];
  if (!s) return null;
  const title = columnTitle(definition, state);
  const draft = entryDraft(definition, state);
  const hasEntry = s.entry !== undefined;
  const isStart = state === definition.start;
  // Rule 9: no entry on the start column (a claim enters it) or a human one (failure paths must
  // reach a human unconditionally).
  const noEntryNote = isStart ? START_NOTE : s.type === 'human' ? HUMAN_NOTE : null;
  const apply = (d: EntryDraft) => onChange(setEntry(definition, state, normalizeEntry(d)));
  const patch = (p: Partial<EntryDraft>) => apply({ ...draft, ...p });
  const setChecks = (checks: EntryCheck[]) => patch({ checks });
  const setItems = (reviewItems: string[]) => patch({ reviewItems });
  /** undefined = auto-detect (omit `setup`), '' = none, else the command. */
  const setSetup = (setup: string | undefined) => {
    const next = { ...draft };
    delete next.setup;
    if (setup !== undefined) next.setup = setup;
    apply(next);
  };
  const setupMode: 'auto' | 'none' | 'custom' =
    draft.setup === undefined ? 'auto' : draft.setup === '' && !customSetup ? 'none' : 'custom';
  const base = `states.${state}`;
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
  // "Back to": never this column, nor one with its own entry (rule 9), nor a terminal one.
  const backTo = columnStates(definition).filter((n) => {
    const t = definition.states[n];
    return n !== state && t?.type !== 'terminal' && t?.entry === undefined;
  });
  const humans = humanStates(definition);
  const outcomes = s.type === 'terminal' ? [] : Object.entries(s.on ?? {});

  const body = (
    <>
      <div className="wf-editor-head">
        <h3>{title}</h3>
        <button type="button" onClick={onClose} aria-label="Close column">
          ×
        </button>
      </div>
      <p className="muted wf-note">
        State <code>{state}</code>. Changes go into a draft; Save creates a new version.
      </p>

      <label className="wf-field">
        Title
        <input
          value={s.title ?? ''}
          placeholder={state}
          onChange={(e) => onChange(setTitle(definition, state, e.target.value))}
        />
      </label>
      {at('.title')}

      <h4>Work</h4>
      {s.type === 'agent' && (
        <div className="wf-unmet">
          {s.prompt !== undefined ? (
            <>
              <label htmlFor={`${uid}-prompt`}>Prompt template</label>
              <input
                id={`${uid}-prompt`}
                list={`${uid}-templates`}
                value={s.prompt}
                onChange={(e) =>
                  onChange(setAgentWork(definition, state, { prompt: e.target.value }))
                }
              />
              <datalist id={`${uid}-templates`}>
                {PROMPT_TEMPLATES.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </>
          ) : (
            <>
              <span className="muted">Skill</span>
              <code>{s.skill}</code>
            </>
          )}
          <label htmlFor={`${uid}-model`}>Model</label>
          <input
            id={`${uid}-model`}
            value={s.model ?? ''}
            placeholder="account default"
            onChange={(e) => onChange(setAgentWork(definition, state, { model: e.target.value }))}
          />
          {s.tools && (
            <>
              <span className="muted">Tools</span>
              <span>{s.tools.join(', ')}</span>
            </>
          )}
        </div>
      )}
      {s.type === 'event' && (
        <p className="wf-note">
          Waits for {s.wait_for.map((w) => `“${w}”`).join(' or ')} (event state).
        </p>
      )}
      {s.type !== 'agent' && s.type !== 'event' && <p className="wf-note">{TYPE_TEXT[s.type]}</p>}
      {at('.prompt')}
      {outcomes.length > 0 && (
        <ul className="wf-outcomes muted" aria-label="Moves on">
          {outcomes.map(([o, t]) => {
            const to = typeof t === 'string' ? t : t.goto;
            return (
              <li key={o}>
                on <code>{o}</code> → {columnTitle(definition, to)}
                {typeof t !== 'string' && t.requirements && (
                  <span className="wf-gate-note">
                    {' '}
                    (✓ {t.requirements.items.length} transition requirement
                    {t.requirements.items.length === 1 ? '' : 's'}, read-only)
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <h4>Requirements to enter</h4>
      {noEntryNote !== null ? (
        <>
          <p className="muted wf-note">{noEntryNote}</p>
          {at('.entry')}
          {hasEntry && (
            <div>
              <button
                type="button"
                className="danger"
                onClick={() => onChange(setEntry(definition, state, null))}
              >
                Remove requirements
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="muted wf-note">
            {hasEntry
              ? `Before a ticket enters ${title}: the checks run in its worktree, then a reviewer judges the review items, then conductor performs the actions.`
              : `None. A ticket enters ${title} as soon as an outcome moves it here.`}
          </p>
          {at('.entry')}

          <h5>Checks</h5>
          <ol className="wf-items" aria-label="Checks">
            {draft.checks.map((c, i) => (
              <li key={i} className="wf-item">
                <div className="wf-check">
                  <input
                    aria-label={`Check ${i + 1} name`}
                    value={c.name}
                    placeholder="e.g. Build passes"
                    onChange={(e) =>
                      setChecks(
                        draft.checks.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                      )
                    }
                  />
                  <input
                    aria-label={`Check ${i + 1} command`}
                    className="mono"
                    value={c.cmd}
                    placeholder="e.g. npm run build"
                    onChange={(e) =>
                      setChecks(
                        draft.checks.map((x, j) => (j === i ? { ...x, cmd: e.target.value } : x)),
                      )
                    }
                  />
                  {at(`.entry.checks.${i}.name`)}
                  {at(`.entry.checks.${i}.cmd`)}
                </div>
                <ItemActions
                  what="check"
                  i={i}
                  n={draft.checks.length}
                  onMove={(j) => setChecks(swap(draft.checks, i, j))}
                  onRemove={() => setChecks(draft.checks.filter((_, j) => j !== i))}
                />
              </li>
            ))}
          </ol>
          <div>
            <button
              type="button"
              disabled={draft.checks.length >= MAX_CHECKS}
              onClick={() => setChecks([...draft.checks, { name: '', cmd: '' }])}
            >
              Add check
            </button>
          </div>
          {draft.checks.length > 0 && (
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
                  if (mode === 'auto') setSetup(undefined);
                  else if (mode === 'none') setSetup('');
                  else setSetup(draft.setup ?? '');
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
                  value={draft.setup ?? ''}
                  placeholder="e.g. pnpm install --frozen-lockfile"
                  onChange={(e) => setSetup(e.target.value)}
                />
              )}
              {at('.entry.setup')}
            </div>
          )}

          <h5>Review</h5>
          <ol className="wf-items" aria-label="Review items">
            {draft.reviewItems.map((item, i) => (
              <li key={i} className="wf-item">
                <div>
                  <textarea
                    aria-label={`Review item ${i + 1}`}
                    rows={2}
                    value={item}
                    placeholder="e.g. New code paths have unit tests"
                    onChange={(e) =>
                      setItems(draft.reviewItems.map((x, j) => (j === i ? e.target.value : x)))
                    }
                  />
                  {at(`.entry.review.items.${i}`)}
                </div>
                <ItemActions
                  what="review item"
                  i={i}
                  n={draft.reviewItems.length}
                  onMove={(j) => setItems(swap(draft.reviewItems, i, j))}
                  onRemove={() => setItems(draft.reviewItems.filter((_, j) => j !== i))}
                />
              </li>
            ))}
          </ol>
          {at('.entry.review.items')}
          <div>
            <button
              type="button"
              disabled={draft.reviewItems.length >= MAX_ITEMS}
              onClick={() => setItems([...draft.reviewItems, ''])}
            >
              Add review item
            </button>
          </div>
          {draft.reviewItems.length > 0 && (
            <label className="wf-field">
              Reviewer model
              <input
                value={draft.reviewModel ?? ''}
                placeholder="account default"
                onChange={(e) => patch({ reviewModel: e.target.value })}
              />
            </label>
          )}

          <h5>Actions</h5>
          <label className="wf-toggle">
            <input
              type="checkbox"
              checked={draft.openPr}
              onChange={(e) => patch({ openPr: e.target.checked })}
            />
            Open a pull request (by conductor)
          </label>

          {hasEntry && (
            <>
              <h5>When not met</h5>
              <div className="wf-unmet">
                <label htmlFor={`${uid}-goto`}>Back to</label>
                <select
                  id={`${uid}-goto`}
                  value={draft.on_unmet.goto}
                  onChange={(e) => patch({ on_unmet: { ...draft.on_unmet, goto: e.target.value } })}
                >
                  {withCurrent(backTo, draft.on_unmet.goto).map((n) => (
                    <option key={n} value={n}>
                      {columnTitle(definition, n)}
                    </option>
                  ))}
                </select>
                <label htmlFor={`${uid}-instruction`}>With instruction</label>
                <textarea
                  id={`${uid}-instruction`}
                  rows={3}
                  value={draft.on_unmet.instruction ?? ''}
                  placeholder="What the agent should do about it (optional)"
                  onChange={(e) => {
                    const rest = { ...draft.on_unmet };
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
                  value={Number.isNaN(draft.on_unmet.retries) ? '' : draft.on_unmet.retries}
                  onChange={(e) =>
                    patch({
                      on_unmet: {
                        ...draft.on_unmet,
                        retries: e.target.value === '' ? NaN : Number(e.target.value),
                      },
                    })
                  }
                />
                <label htmlFor={`${uid}-else`}>Then</label>
                <select
                  id={`${uid}-else`}
                  value={draft.on_unmet.else}
                  onChange={(e) => patch({ on_unmet: { ...draft.on_unmet, else: e.target.value } })}
                >
                  {withCurrent(humans, draft.on_unmet.else).map((n) => (
                    <option key={n} value={n}>
                      {columnTitle(definition, n)}
                    </option>
                  ))}
                </select>
              </div>
              {at('.entry.on_unmet.goto')}
              {at('.entry.on_unmet.instruction')}
              {at('.entry.on_unmet.retries')}
              {at('.entry.on_unmet.else')}
              <div>
                <button
                  type="button"
                  className="danger"
                  onClick={() => apply({ ...draft, checks: [], reviewItems: [], openPr: false })}
                >
                  Remove requirements
                </button>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
  // Anything not shown next to a field (e.g. a server rule on this column) goes at the end.
  const rest = issues.filter((i) => !shownPaths.has(i.path));
  return (
    <aside className="wf-editor" aria-label="Column">
      {body}
      {rest.map((i) => (
        <p key={`${i.path}:${i.message}`} className="wf-field-error" role="alert">
          {i.message}
        </p>
      ))}
    </aside>
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
