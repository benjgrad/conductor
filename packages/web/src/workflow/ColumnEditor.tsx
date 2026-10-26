import {
  FALLBACK_TRANSITION_NAMES,
  foldLegacyRequirements,
  RETURN_TO,
  transitionActor,
  transitionObject,
  type WorkflowDefinition,
} from '@conductor/shared';
import { useId, type ReactNode } from 'react';
import {
  columnTitle,
  entryLines,
  PROMPT_TEMPLATES,
  setAgentWork,
  setTitle,
  type ColumnIssue,
} from './columns.js';
import { transitionNames } from './transitions.js';

// The side panel for one column (ADR-0010, ADR-0011): its title and its work. The rules for
// leaving the column live on its transitions (the arrows): the panel lists them, opens one in the
// transition panel, and adds new ones. An old version's "requirements to enter" are shown
// read-only; saving moves them onto the transitions into the column (`foldLegacyRequirements`).

export interface ColumnEditorProps {
  definition: WorkflowDefinition;
  state: string;
  /** Client and server problems in this column (its transitions' included). */
  issues: ColumnIssue[];
  onChange: (next: WorkflowDefinition) => void;
  onSelectTransition: (name: string) => void;
  onAddTransition: () => void;
  onClose: () => void;
}

export const FOLD_NOTICE = 'Saved as transition requirements';

const TYPE_TEXT: Record<string, string> = {
  human: 'A person answers or approves (human state).',
  terminal: 'Final: the ticket is done (terminal state).',
  command: 'Runs a command (command state).',
  connector: 'Calls a connector (connector state).',
};

export function ColumnEditor({
  definition,
  state,
  issues,
  onChange,
  onSelectTransition,
  onAddTransition,
  onClose,
}: ColumnEditorProps) {
  const uid = useId();
  const s = definition.states[state];
  if (!s) return null;
  const title = columnTitle(definition, state);
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
  const names = transitionNames(definition, state);
  const problemsOf = (name: string) =>
    issues.filter((i) => i.transition?.from === state && i.transition.name === name).length;
  // The transitions an old `entry` on this column folds onto (fold.ts: every non-fallback one in).
  const foldTargets =
    s.entry === undefined
      ? []
      : Object.entries(definition.states).flatMap(([from, st]) =>
          st.type === 'terminal'
            ? []
            : Object.entries(st.on ?? {})
                .filter(
                  ([n, t]) =>
                    !FALLBACK_TRANSITION_NAMES.includes(n) && transitionObject(t).goto === state,
                )
                .map(([n]) => `${columnTitle(definition, from)}: ${n}`),
        );

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

      {s.type !== 'terminal' && (
        <>
          <h4>Transitions</h4>
          <p className="muted wf-note">
            How a ticket leaves {title}: who takes each move, for which tickets, and what must hold
            first. Click one (or its arrow) to edit it.
          </p>
          {at('.on')}
          {names.length === 0 ? (
            <p className="muted wf-note">None yet.</p>
          ) : (
            <ul className="wf-transitions" aria-label="Transitions">
              {names.map((n) => {
                const raw = s.on![n]!;
                const t = transitionObject(raw);
                const goto =
                  t.goto === RETURN_TO ? 'the column that asked' : columnTitle(definition, t.goto);
                const problems = problemsOf(n);
                return (
                  <li key={n}>
                    <button
                      type="button"
                      className={problems > 0 ? 'wf-transition error' : 'wf-transition'}
                      onClick={() => onSelectTransition(n)}
                    >
                      <code>{n}</code> → {goto}
                    </button>
                    <span className="muted">
                      {' '}
                      {transitionActor(definition, state, n, raw)}
                      {t.kinds !== undefined && t.kinds.length > 0
                        ? ` · ${t.kinds.join(', ')}`
                        : ''}
                      {t.requires !== undefined || t.requirements !== undefined ? ' · ✓' : ''}
                      {problems > 0 ? ` · ${problems} problem${problems === 1 ? '' : 's'}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <div>
            <button type="button" onClick={onAddTransition}>
              Add transition
            </button>
          </div>
        </>
      )}

      {s.entry !== undefined && (
        <section className="wf-legacy" aria-label="Old requirements to enter">
          <h4>Requirements to enter (old version)</h4>
          <ul className="wf-outcomes muted">
            {entryLines(definition, s.entry).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p className="wf-note" role="note">
            <strong>{FOLD_NOTICE}</strong>: rules now live on the moves into {title}
            {foldTargets.length > 0 ? ` (${foldTargets.join('; ')})` : ''}. Saving moves these
            requirements there.
          </p>
          <div>
            <button type="button" onClick={() => onChange(foldLegacyRequirements(definition))}>
              Move them to the transitions now
            </button>
          </div>
          {at('.entry')}
        </section>
      )}
    </>
  );
  // Anything not shown next to a field and not on a transition goes at the end.
  const rest = issues.filter(
    (i) => !shownPaths.has(i.path) && (i.transition === undefined || i.transition.from !== state),
  );
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
