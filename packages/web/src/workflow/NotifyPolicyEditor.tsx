// ADR-0037 P6 (T4): the workflow's notification policy (`notify`): on or off, the default for
// transitions that inherit, what engine moves do, and the coalesce window. Off is legacy mode:
// every question pushes, and a transition set to "Every time" pushes too.
// Below it, every transition's own setting in one table (Never / Once per ticket / Every time),
// the same value as the Notify select in each transition's editor.
import type { NotifyMode, NotifyPolicy, WorkflowDefinition } from '@conductor/shared';
import { Fragment, useId, useState } from 'react';
import type { ColumnIssue } from './columns.js';
import {
  DEFAULT_NOTIFY_POLICY,
  effectiveMode,
  NOTIFY_MODE_TEXT,
  notifyOptions,
  notifyRows,
  setNotifyPolicy,
  setTransitionNotify,
  type NotifyChoice,
  type NotifyRow,
} from './notify-policy.js';

interface NotifyPolicyEditorProps {
  definition: WorkflowDefinition;
  issues: readonly ColumnIssue[];
  readOnly?: boolean;
  onChange: (next: WorkflowDefinition) => void;
}

export function NotifyPolicyEditor({
  definition,
  issues,
  readOnly,
  onChange,
}: NotifyPolicyEditorProps) {
  const policy = definition.notify;
  const own = issues.filter((i) => i.path === 'notify' || i.path.startsWith('notify.'));
  const [open, setOpen] = useState(false);
  const uid = useId();
  const rows = notifyRows(definition);
  const rowIssues = (r: NotifyRow) =>
    issues.filter(
      (i) =>
        i.transition?.from === r.from && i.transition.name === r.name && i.path.endsWith('.notify'),
    );
  const silenced = rows.filter((r) => effectiveMode(definition, r.choice) === 'never').length;
  const shown = open || own.length > 0;
  const set = (p: Partial<NotifyPolicy>) => {
    if (policy !== undefined) onChange(setNotifyPolicy(definition, { ...policy, ...p }));
  };
  const setCoalesce = (text: string) => {
    if (policy === undefined) return;
    const { coalesce: _old, ...rest } = policy;
    void _old;
    onChange(setNotifyPolicy(definition, text === '' ? rest : { ...rest, coalesce: text }));
  };
  return (
    <section className="wf-instructions" aria-label="Notifications">
      <button
        type="button"
        aria-expanded={shown}
        aria-controls={`${uid}-body`}
        onClick={() => setOpen(!shown)}
      >
        <span className="wf-chevron" aria-hidden="true">
          {shown ? '▾' : '▸'}
        </span>
        Notifications ({policy === undefined ? 'every question' : 'per transition'}
        {silenced > 0 ? ` · ${silenced} silenced` : ''})
      </button>
      {shown && (
        <div id={`${uid}-body`}>
          <label className="wf-toggle">
            <input
              type="checkbox"
              checked={policy !== undefined}
              disabled={readOnly}
              onChange={(e) =>
                onChange(
                  setNotifyPolicy(definition, e.target.checked ? DEFAULT_NOTIFY_POLICY : null),
                )
              }
            />
            Decide per transition which moves notify
          </label>
          {policy === undefined ? (
            <p className="muted wf-note">
              Off: every question and hand-off notifies, and so does a transition set to “Every
              time”.
            </p>
          ) : (
            <>
              <div className="wf-unmet">
                <label htmlFor={`${uid}-default`}>Transitions that inherit</label>
                <select
                  id={`${uid}-default`}
                  value={policy.default}
                  disabled={readOnly}
                  onChange={(e) => set({ default: e.target.value as NotifyMode })}
                >
                  {(['once', 'every', 'never'] as const).map((m) => (
                    <option key={m} value={m}>
                      {NOTIFY_MODE_TEXT[m]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="wf-unmet">
                <label htmlFor={`${uid}-engine`}>Moves conductor makes itself</label>
                <select
                  id={`${uid}-engine`}
                  value={policy.engine_moves}
                  disabled={readOnly}
                  onChange={(e) => set({ engine_moves: e.target.value as 'never' | 'inherit' })}
                >
                  <option value="never">Never notify</option>
                  <option value="inherit">Like the transition they were taken for</option>
                </select>
              </div>
              <div className="wf-unmet">
                <label htmlFor={`${uid}-coalesce`}>
                  One notification per ticket and column within
                </label>
                <input
                  id={`${uid}-coalesce`}
                  type="text"
                  placeholder="e.g. 15m (empty: no window)"
                  value={policy.coalesce ?? ''}
                  disabled={readOnly}
                  onChange={(e) => setCoalesce(e.target.value.trim())}
                />
              </div>
              {own.map((i) => (
                <p key={`${i.path}\u0000${i.message}`} className="error" role="alert">
                  {i.message}
                </p>
              ))}
            </>
          )}
          <NotifyTable
            definition={definition}
            rows={rows}
            rowIssues={rowIssues}
            readOnly={readOnly}
            onChange={onChange}
          />
        </div>
      )}
    </section>
  );
}

interface NotifyTableProps {
  definition: WorkflowDefinition;
  rows: readonly NotifyRow[];
  rowIssues: (r: NotifyRow) => ColumnIssue[];
  readOnly?: boolean | undefined;
  onChange: (next: WorkflowDefinition) => void;
}

/** Every transition's notify setting, grouped by the column it leaves. */
function NotifyTable({ definition, rows, rowIssues, readOnly, onChange }: NotifyTableProps) {
  if (rows.length === 0) return null;
  const options = notifyOptions(definition);
  const groups: NotifyRow[][] = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last[0]!.from === r.from) last.push(r);
    else groups.push([r]);
  }
  return (
    <>
      <h4 className="wf-notify-heading">Per transition</h4>
      {definition.notify === undefined && (
        <p className="muted wf-note">
          Turn on “Decide per transition which moves notify” for Once per ticket.
        </p>
      )}
      <table className="wf-notify-table">
        <thead>
          <tr>
            <th scope="col">Transition</th>
            <th scope="col">Goes to</th>
            <th scope="col">Notify</th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g[0]!.from}>
            <tr>
              <th scope="rowgroup" colSpan={3}>
                From {g[0]!.fromTitle}
              </th>
            </tr>
            {g.map((r) => {
              const label = `Notify: ${r.fromTitle} → ${r.title}`;
              const problems = rowIssues(r);
              return (
                <Fragment key={r.name}>
                  <tr>
                    <td>
                      {r.title}
                      {r.actor === 'human' && <span className="muted"> (you)</span>}
                    </td>
                    <td>{r.toTitle}</td>
                    <td>
                      <select
                        aria-label={label}
                        value={r.choice}
                        disabled={readOnly}
                        onChange={(e) =>
                          onChange(
                            setTransitionNotify(
                              definition,
                              r.from,
                              r.name,
                              e.target.value as NotifyChoice,
                            ),
                          )
                        }
                      >
                        {options.map(({ value, text }) => (
                          <option key={value} value={value}>
                            {text}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                  {problems.map((i) => (
                    <tr key={`${i.path}\u0000${i.message}`}>
                      <td colSpan={3} className="error" role="alert">
                        {i.message}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        ))}
      </table>
    </>
  );
}
