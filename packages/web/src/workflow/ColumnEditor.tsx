import {
  FALLBACK_TRANSITION_NAMES,
  foldLegacyRequirements,
  transitionObject,
  FOLLOW_UPS_MAX,
  PAGES_RESULT_MAX,
  type WorkflowDefinition,
} from '@conductor/shared';
import { ArrowLeft } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import {
  columnTitle,
  entryLines,
  followUpsOf,
  PROMPT_TEMPLATES,
  setAgentWork,
  setFollowUps,
  pagesOf,
  setPages,
  setTicketEditable,
  setTitle,
  ticketEditableOf,
  type ColumnIssue,
} from './columns.js';
import { TransitionList } from './TransitionList.js';
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
  /**
   * UXR-67: the column's place and removal. `onMove` moves it one place (absent: no Move
   * buttons); `canMove` says which way it can go; `removalProblems` says why it can't be removed
   * (empty: Remove is enabled); `onRemove` removes it (absent: no Remove button).
   */
  onMove?: (by: -1 | 1) => void;
  canMove?: { left: boolean; right: boolean };
  removalProblems?: readonly string[];
  onRemove?: () => void;
  /** UXR-44: the phone's full-screen panel, with Back to the workflow instead of ×. */
  fullScreen?: boolean;
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
  onMove,
  canMove,
  removalProblems = [],
  onRemove,
  fullScreen = false,
}: ColumnEditorProps) {
  const uid = useId();
  const [confirmRemove, setConfirmRemove] = useState(false);
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
        {fullScreen && (
          <button
            type="button"
            className="wf-back back"
            onClick={onClose}
            aria-label="Back to workflow"
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
        )}
        <h3>{title}</h3>
        {!fullScreen && (
          <button type="button" onClick={onClose} aria-label="Close column">
            ×
          </button>
        )}
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
      <label className="wf-field wf-toggle">
        <input
          type="checkbox"
          checked={ticketEditableOf(definition, state)}
          onChange={(e) => onChange(setTicketEditable(definition, state, e.target.checked))}
        />
        People can edit the ticket in this column
      </label>
      {s.ticket_editable === undefined && (
        <p className="muted wf-note">
          Default for a {s.type} column ({s.type === 'human' ? 'editable' : 'read-only'}). An edit
          reaches the agent's next prompt, not a running one.
        </p>
      )}

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
      {s.type === 'agent' && (
        <FollowUpsFields
          uid={uid}
          definition={definition}
          state={state}
          onChange={onChange}
          errors={
            <>
              {at('.follow_ups')}
              {at('.follow_ups.max')}
              {at('.follow_ups.guidance')}
            </>
          }
        />
      )}
      {s.type === 'agent' && (
        <PagesFields
          uid={uid}
          definition={definition}
          state={state}
          onChange={onChange}
          errors={
            <>
              {at('.tools')}
              {at('.result')}
            </>
          }
        />
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
            <TransitionList
              definition={definition}
              from={state}
              names={names}
              issues={issues}
              onSelect={onSelectTransition}
              showGoto
              label="Transitions"
            />
          )}
          <div>
            <button type="button" onClick={onAddTransition}>
              Add transition
            </button>
          </div>
        </>
      )}

      {(onMove || onRemove) && (
        <section aria-label="Column place">
          <h4>Place</h4>
          {onMove && (
            <div className="wf-place-buttons">
              <button type="button" disabled={!canMove?.left} onClick={() => onMove(-1)}>
                ← Move left
              </button>
              <button type="button" disabled={!canMove?.right} onClick={() => onMove(1)}>
                Move right →
              </button>
            </div>
          )}
          {onRemove && (
            <>
              <div>
                <button
                  type="button"
                  className="danger"
                  disabled={removalProblems.length > 0}
                  aria-describedby={removalProblems.length > 0 ? `${uid}-why-not` : undefined}
                  onClick={() => setConfirmRemove(true)}
                >
                  Remove column
                </button>
              </div>
              {removalProblems.length > 0 && (
                <div id={`${uid}-why-not`} className="muted wf-note">
                  {title} can’t be removed:
                  <ul aria-label="Why it can’t be removed">
                    {removalProblems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}
              {confirmRemove && removalProblems.length === 0 && (
                <div
                  className="wf-confirm"
                  role="alertdialog"
                  aria-label="Remove column"
                  aria-describedby={`${uid}-remove-text`}
                >
                  <p id={`${uid}-remove-text`}>
                    Remove {title} and the transitions out of it? Saving checks again that no ticket
                    is in it.
                  </p>
                  <button type="button" onClick={() => setConfirmRemove(false)} autoFocus>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      setConfirmRemove(false);
                      onRemove();
                    }}
                  >
                    Remove
                  </button>
                </div>
              )}
            </>
          )}
        </section>
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
    <aside className={`wf-editor${fullScreen ? ' full-screen' : ''}`} aria-label="Column">
      {body}
      {rest.map((i) => (
        <p key={`${i.path}:${i.message}`} className="wf-field-error" role="alert">
          {i.message}
        </p>
      ))}
    </aside>
  );
}

/**
 * ADR-0034: may this agent column's agent propose follow-up tickets? Offered in its prompt,
 * never required; the user approves or dismisses each one in Needs input.
 */
/** ADR-0038: "Pages": the agent may publish and attach rendered pages, at most `max`. */
function PagesFields({
  uid,
  definition,
  state,
  onChange,
  errors,
}: {
  uid: string;
  definition: WorkflowDefinition;
  state: string;
  onChange: (next: WorkflowDefinition) => void;
  errors: ReactNode;
}) {
  const p = pagesOf(definition, state);
  return (
    <>
      <label className="wf-field wf-toggle">
        <input
          type="checkbox"
          checked={p !== null}
          onChange={(e) => onChange(setPages(definition, state, e.target.checked ? {} : null))}
        />
        Pages
      </label>
      {p === null ? (
        <p className="muted wf-note">
          Off. When on, the agent can publish a rendered HTML page (a mockup, a diagram) that you
          open from the card; it expires after 7 days and is never committed.
        </p>
      ) : (
        <div className="wf-unmet">
          <label htmlFor={`${uid}-pages-max`}>At most</label>
          <input
            id={`${uid}-pages-max`}
            type="number"
            min={1}
            max={PAGES_RESULT_MAX}
            value={p.max}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= PAGES_RESULT_MAX) {
                onChange(setPages(definition, state, { max: n }));
              }
            }}
          />
        </div>
      )}
      {errors}
    </>
  );
}

function FollowUpsFields({
  uid,
  definition,
  state,
  onChange,
  errors,
}: {
  uid: string;
  definition: WorkflowDefinition;
  state: string;
  onChange: (next: WorkflowDefinition) => void;
  errors: ReactNode;
}) {
  const f = followUpsOf(definition, state);
  return (
    <>
      <label className="wf-field wf-toggle">
        <input
          type="checkbox"
          checked={f !== null}
          onChange={(e) => onChange(setFollowUps(definition, state, e.target.checked ? {} : null))}
        />
        Agents may propose follow-up tickets
      </label>
      {f === null ? (
        <p className="muted wf-note">
          Off. When on, the agent may suggest separate work as new tickets; you approve or dismiss
          each one in Needs input.
        </p>
      ) : (
        <div className="wf-unmet">
          <label htmlFor={`${uid}-fu-max`}>At most</label>
          <input
            id={`${uid}-fu-max`}
            type="number"
            min={1}
            max={FOLLOW_UPS_MAX}
            value={f.max}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= FOLLOW_UPS_MAX) {
                onChange(setFollowUps(definition, state, { max: n }));
              }
            }}
          />
          <label htmlFor={`${uid}-fu-guidance`}>Guidance</label>
          <textarea
            id={`${uid}-fu-guidance`}
            rows={2}
            maxLength={1000}
            value={f.guidance ?? ''}
            placeholder="e.g. Only propose test or documentation debt"
            onChange={(e) =>
              onChange(setFollowUps(definition, state, { guidance: e.target.value }))
            }
          />
        </div>
      )}
      {errors}
    </>
  );
}
