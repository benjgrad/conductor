// ADR-0037 P6 (T4): the workflow's notification policy (`notify`): on or off, the default for
// transitions that inherit, what engine moves do, and the coalesce window. Off is legacy mode:
// every question pushes, and a transition set to "Every time" pushes too.
import type { NotifyMode, NotifyPolicy, WorkflowDefinition } from '@conductor/shared';
import { useId, useState } from 'react';
import type { ColumnIssue } from './columns.js';
import { DEFAULT_NOTIFY_POLICY, NOTIFY_MODE_TEXT, setNotifyPolicy } from './notify-policy.js';

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
        Notifications ({policy === undefined ? 'every question' : 'per transition'})
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
        </div>
      )}
    </section>
  );
}
