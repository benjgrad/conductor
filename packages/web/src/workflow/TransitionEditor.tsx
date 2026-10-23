import type { RequirementsGate, WorkflowDefinition } from '@conductor/shared';
import {
  defaultGate,
  failurePolicy,
  gateAllowed,
  gateTarget,
  getTransition,
  humanStates,
  setGate,
  type GateIssue,
} from './model.js';

// The side panel for one transition (ADR-0009): its route and failure policy (read-only) and its
// requirements gate (editable). Every change goes straight into the caller's draft definition.

const MAX_ITEMS = 30;

export interface TransitionEditorProps {
  definition: WorkflowDefinition;
  from: string;
  outcome: string;
  /** Client and server problems on this transition. */
  issues: GateIssue[];
  onChange: (next: WorkflowDefinition) => void;
  onClose: () => void;
}

export function TransitionEditor({
  definition,
  from,
  outcome,
  issues,
  onChange,
  onClose,
}: TransitionEditorProps) {
  const t = getTransition(definition, from, outcome);
  if (t === undefined) return null;
  const to = gateTarget(t);
  const gate = typeof t === 'string' ? undefined : t.requirements;
  const policy = typeof t === 'string' ? null : failurePolicy(definition, t);
  const fromType = definition.states[from]?.type;
  const allowed = gateAllowed(definition, from);
  const stateNames = Object.entries(definition.states)
    .filter(([, s]) => s.type !== 'terminal')
    .map(([n]) => n);
  const humans = humanStates(definition);

  const update = (next: RequirementsGate | null) =>
    onChange(setGate(definition, from, outcome, next));
  const patch = (p: Partial<RequirementsGate>) => gate && update({ ...gate, ...p });
  const patchUnmet = (p: Partial<RequirementsGate['on_unmet']>) =>
    gate && update({ ...gate, on_unmet: { ...gate.on_unmet, ...p } });
  const setItems = (items: string[]) => patch({ items });
  const issueAt = (suffix: string) =>
    issues.filter((i) => i.path.endsWith(`.requirements${suffix}`)).map((i) => i.message);

  return (
    <aside className="wf-editor" aria-label="Transition">
      <div className="wf-editor-head">
        <h3>
          {from} → {to}
        </h3>
        <button type="button" onClick={onClose} aria-label="Close transition">
          ×
        </button>
      </div>
      <dl className="kv">
        <dt>Outcome</dt>
        <dd>
          <code>{outcome}</code>
        </dd>
        <dt>From</dt>
        <dd>
          {from} <span className="muted">({fromType})</span>
        </dd>
        <dt>On failure</dt>
        <dd>{policy ?? <span className="muted">no retry policy</span>}</dd>
      </dl>

      <h4>Requirements</h4>
      {!allowed && (
        <p className="muted wf-note">
          Requirements can only gate transitions out of agent and command states. {from} is{' '}
          {fromType === 'event' || fromType === 'agent' ? 'an' : 'a'} {fromType} state: there is no
          new work for a reviewer to check when it moves on.
        </p>
      )}
      {allowed && !gate && (
        <>
          <p className="muted wf-note">
            None. The session moves to {to} as soon as {from} reports <code>{outcome}</code>.
          </p>
          <button type="button" onClick={() => update(defaultGate(definition, from))}>
            Add requirements
          </button>
        </>
      )}
      {gate && (
        <>
          <p className="muted wf-note">
            Before entering {to}, an independent reviewer checks each item against the work.
          </p>
          <ol className="wf-items">
            {gate.items.map((item, i) => (
              <li key={i} className="wf-item">
                <textarea
                  aria-label={`Requirement ${i + 1}`}
                  rows={2}
                  value={item}
                  placeholder="e.g. New code paths have unit tests"
                  onChange={(e) =>
                    setItems(gate.items.map((x, j) => (j === i ? e.target.value : x)))
                  }
                />
                <div className="wf-item-actions">
                  <button
                    type="button"
                    aria-label={`Move requirement ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => setItems(swap(gate.items, i, i - 1))}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move requirement ${i + 1} down`}
                    disabled={i === gate.items.length - 1}
                    onClick={() => setItems(swap(gate.items, i, i + 1))}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove requirement ${i + 1}`}
                    className="danger"
                    onClick={() => setItems(gate.items.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
                {issueAt(`.items.${i}`).map((m) => (
                  <p key={m} className="wf-field-error" role="alert">
                    {m}
                  </p>
                ))}
              </li>
            ))}
          </ol>
          {issueAt('.items').map((m) => (
            <p key={m} className="wf-field-error" role="alert">
              {m}
            </p>
          ))}
          <div>
            <button
              type="button"
              disabled={gate.items.length >= MAX_ITEMS}
              onClick={() => setItems([...gate.items, ''])}
            >
              Add requirement
            </button>
          </div>

          <h4>When not met</h4>
          <div className="wf-unmet">
            <label htmlFor="wf-unmet-goto">Go back to</label>
            <select
              id="wf-unmet-goto"
              value={gate.on_unmet.goto}
              onChange={(e) => patchUnmet({ goto: e.target.value })}
            >
              {withCurrent(stateNames, gate.on_unmet.goto).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <label htmlFor="wf-unmet-instruction">With instruction</label>
            <textarea
              id="wf-unmet-instruction"
              rows={3}
              value={gate.on_unmet.instruction ?? ''}
              placeholder="What the agent should do about it (optional)"
              onChange={(e) => {
                const rest = { ...gate.on_unmet };
                delete rest.instruction;
                const v = e.target.value;
                update({
                  ...gate,
                  on_unmet: v.trim() === '' ? rest : { ...rest, instruction: v },
                });
              }}
            />
            <label htmlFor="wf-unmet-retries">Up to (times)</label>
            <input
              id="wf-unmet-retries"
              type="number"
              min={0}
              max={10}
              step={1}
              value={Number.isNaN(gate.on_unmet.retries) ? '' : gate.on_unmet.retries}
              onChange={(e) =>
                patchUnmet({ retries: e.target.value === '' ? NaN : Number(e.target.value) })
              }
            />
            <label htmlFor="wf-unmet-else">Then</label>
            <select
              id="wf-unmet-else"
              value={gate.on_unmet.else}
              onChange={(e) => patchUnmet({ else: e.target.value })}
            >
              {withCurrent(humans, gate.on_unmet.else).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <label htmlFor="wf-gate-model">Reviewer model</label>
            <input
              id="wf-gate-model"
              value={gate.model ?? ''}
              placeholder="account default"
              onChange={(e) => {
                const rest = { ...gate };
                delete rest.model;
                update(e.target.value.trim() === '' ? rest : { ...rest, model: e.target.value });
              }}
            />
          </div>
          {['.on_unmet.goto', '.on_unmet.else', '.on_unmet.retries', '.on_unmet.instruction', '']
            .flatMap(issueAt)
            .map((m) => (
              <p key={m} className="wf-field-error" role="alert">
                {m}
              </p>
            ))}
          <div>
            <button type="button" className="danger" onClick={() => update(null)}>
              Remove requirements
            </button>
          </div>
        </>
      )}
      {issues
        .filter((i) => !shownInline(i.path, gate?.items.length ?? 0))
        .map((i) => (
          <p key={`${i.path}:${i.message}`} className="wf-field-error" role="alert">
            {i.message}
          </p>
        ))}
    </aside>
  );
}

const INLINE_SUFFIXES = [
  '',
  '.items',
  '.on_unmet.goto',
  '.on_unmet.else',
  '.on_unmet.retries',
  '.on_unmet.instruction',
];

/** Whether the editor already shows an issue at `path` next to its field. */
function shownInline(path: string, items: number): boolean {
  if (items === 0) return false;
  if (INLINE_SUFFIXES.some((s) => path.endsWith(`.requirements${s}`))) return true;
  const m = /\.requirements\.items\.(\d+)$/.exec(path);
  return m !== null && Number(m[1]) < items;
}

function swap<T>(list: T[], i: number, j: number): T[] {
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** Options plus the current value, so a select never silently shows a different state. */
const withCurrent = (names: string[], current: string) =>
  names.includes(current) ? names : [...names, current];
