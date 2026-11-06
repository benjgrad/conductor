// ADR-0039 (B3, FR-3): the workflow's bases (`bases`) and the base each kind of ticket starts
// from (`base_default`): add, rename (the defaults follow), choose a ref or a command (with its
// timeout and PR target), and delete, refused while a default or a queued ticket names it.
import {
  DEFAULT_BRANCH_REF,
  TICKET_KINDS,
  type BaseSpec,
  type TicketKind,
  type WorkflowDefinition,
  type WorkflowFeature,
} from '@conductor/shared';
import { useId, useState } from 'react';
import { TICKET_KIND_LABELS } from '../components/format.js';
import {
  addBase,
  baseModeOf,
  baseNameProblem,
  basesIssues,
  basesOf,
  removeBase,
  renameBase,
  setBaseDefault,
  setBaseField,
  setBaseMode,
  type BaseField,
  type BaseIssue,
} from './bases.js';
import type { ColumnIssue } from './columns.js';
import { basesAvailable, webWorkflowFeatures } from './features.js';

interface BasesEditorProps {
  definition: WorkflowDefinition;
  issues: readonly ColumnIssue[];
  /** Tickets in Queued naming each base (a delete is refused while any do). */
  queuedUses?: Readonly<Record<string, number>>;
  readOnly?: boolean;
  features?: readonly WorkflowFeature[];
  onChange: (next: WorkflowDefinition) => void;
}

const NONE = '';

export function BasesEditor({
  definition,
  issues,
  queuedUses = {},
  readOnly,
  features = webWorkflowFeatures(),
  onChange,
}: BasesEditorProps) {
  const entries = basesOf(definition);
  const own: BaseIssue[] = [
    ...issues.filter((i) => i.path === 'bases' || i.path.startsWith('bases.')),
    ...basesIssues(definition, features).filter((i) => i.warning === true),
  ];
  const defaultIssues = issues.filter((i) => i.path.startsWith('base_default'));
  const [open, setOpen] = useState(false);
  const uid = useId();
  const shown = open || own.some((i) => i.warning !== true) || defaultIssues.length > 0;
  const available = basesAvailable(features);
  return (
    <section className="wf-instructions wf-bases" aria-label="Bases">
      <button
        type="button"
        aria-expanded={shown}
        aria-controls={`${uid}-list`}
        onClick={() => setOpen(!shown)}
      >
        <span className="wf-chevron" aria-hidden="true">
          {shown ? '▾' : '▸'}
        </span>
        Bases ({entries.length})
      </button>
      {shown && (
        <div id={`${uid}-list`}>
          <p className="muted wf-note">
            Where a ticket’s branch starts, and where its pull request goes. A ticket picks one by
            name, or starts from its kind’s default.
          </p>
          {!available && (
            <p className="muted wf-note" role="note">
              Not available yet: tickets start from the repo’s default branch, and a workflow with
              bases can’t be saved until conductor resolves them.
            </p>
          )}
          {own
            .filter((i) => i.path === 'bases')
            .map((i) => (
              <p key={i.message} className="error" role="alert">
                {i.message}
              </p>
            ))}
          <ol className="wf-instruction-list">
            {entries.map(([name, spec]) => (
              <BaseRow
                // The index keeps a row (and its name field) mounted across a rename.
                key={entries.findIndex(([k]) => k === name)}
                definition={definition}
                name={name}
                spec={spec}
                issues={own.filter(
                  (i) => i.path === `bases.${name}` || i.path.startsWith(`bases.${name}.`),
                )}
                queuedUses={queuedUses[name] ?? 0}
                readOnly={readOnly === true}
                onChange={onChange}
              />
            ))}
          </ol>
          <fieldset className="wf-base-defaults">
            <legend>Default base</legend>
            {TICKET_KINDS.map((kind) => (
              <DefaultSelect
                key={kind}
                definition={definition}
                kind={kind}
                readOnly={readOnly === true}
                onChange={onChange}
              />
            ))}
            {defaultIssues.map((i) => (
              <p key={i.path + i.message} className="error" role="alert">
                {i.message}
              </p>
            ))}
          </fieldset>
          {!readOnly && (
            <button type="button" onClick={() => onChange(addBase(definition).definition)}>
              Add base
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function DefaultSelect({
  definition,
  kind,
  readOnly,
  onChange,
}: {
  definition: WorkflowDefinition;
  kind: TicketKind;
  readOnly: boolean;
  onChange: (next: WorkflowDefinition) => void;
}) {
  const names = Object.keys(definition.bases ?? {});
  const current = definition.base_default?.[kind];
  return (
    <label>
      {TICKET_KIND_LABELS[kind]}
      <select
        value={current ?? NONE}
        disabled={readOnly}
        onChange={(e) =>
          onChange(
            setBaseDefault(definition, kind, e.target.value === NONE ? null : e.target.value),
          )
        }
      >
        <option value={NONE}>Repo default branch</option>
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
        {current !== undefined && !names.includes(current) && (
          <option value={current}>{current} (missing)</option>
        )}
      </select>
    </label>
  );
}

function BaseRow({
  definition,
  name,
  spec,
  issues,
  queuedUses,
  readOnly,
  onChange,
}: {
  definition: WorkflowDefinition;
  name: string;
  spec: BaseSpec;
  issues: readonly BaseIssue[];
  queuedUses: number;
  readOnly: boolean;
  onChange: (next: WorkflowDefinition) => void;
}) {
  const uid = useId();
  const [nameText, setNameText] = useState(name);
  const [refused, setRefused] = useState<string[] | null>(null);
  const problem = baseNameProblem(definition, name, nameText);
  const mode = baseModeOf(spec);
  const commit = () => {
    if (nameText !== name && problem === null) onChange(renameBase(definition, name, nameText));
  };
  const set = (field: BaseField, value: string) =>
    onChange(setBaseField(definition, name, field, value));
  const value = (field: BaseField) => (spec as Partial<Record<BaseField, string>>)[field] ?? '';
  return (
    <li className="wf-instruction-row wf-base-row">
      <label htmlFor={`${uid}-name`}>Name</label>
      <input
        id={`${uid}-name`}
        value={nameText}
        readOnly={readOnly}
        aria-invalid={problem !== null}
        onChange={(e) => setNameText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <span>Starts from</span>
      <span className="wf-base-mode" role="radiogroup" aria-label={`How ${name} is found`}>
        {(['ref', 'cmd'] as const).map((m) => (
          <label key={m}>
            <input
              type="radio"
              name={`${uid}-mode`}
              checked={mode === m}
              disabled={readOnly}
              onChange={() => onChange(setBaseMode(definition, name, m))}
            />
            {m === 'ref' ? 'A branch' : 'A command'}
          </label>
        ))}
      </span>
      {mode === 'ref' ? (
        <>
          <label htmlFor={`${uid}-ref`}>Branch</label>
          <span className="wf-instruction">
            <input
              id={`${uid}-ref`}
              className="mono"
              value={value('ref')}
              readOnly={readOnly}
              placeholder="e.g. master"
              onChange={(e) => set('ref', e.target.value)}
            />
            <span className="muted wf-instruction-note">
              <code>{DEFAULT_BRANCH_REF}</code> is the repo’s default branch.
            </span>
          </span>
        </>
      ) : (
        <>
          <label htmlFor={`${uid}-cmd`}>Command</label>
          <span className="wf-instruction">
            <textarea
              id={`${uid}-cmd`}
              className="mono"
              rows={2}
              value={value('cmd')}
              readOnly={readOnly}
              placeholder="prints one branch or commit sha"
              onChange={(e) => set('cmd', e.target.value)}
            />
            <span className="muted wf-instruction-note">
              Runs in the repo on the machine that takes the ticket; it prints one branch name or
              commit sha.
            </span>
          </span>
          <label htmlFor={`${uid}-timeout`}>Timeout</label>
          <input
            id={`${uid}-timeout`}
            className="mono"
            value={value('timeout')}
            readOnly={readOnly}
            placeholder="default"
            onChange={(e) => set('timeout', e.target.value)}
          />
          <label htmlFor={`${uid}-pr`}>PR into</label>
          <input
            id={`${uid}-pr`}
            className="mono"
            value={value('pr_into')}
            readOnly={readOnly}
            placeholder="the branch, when it prints a commit"
            onChange={(e) => set('pr_into', e.target.value)}
          />
        </>
      )}
      {issues.map((i) => (
        <p
          key={i.path + i.message}
          className={i.warning === true ? 'muted wf-base-warning' : 'error'}
          role={i.warning === true ? 'note' : 'alert'}
        >
          {i.warning === true ? `Warning: ${i.message}` : i.message}
        </p>
      ))}
      {!readOnly && (
        <button
          type="button"
          className="link danger"
          aria-label={`Delete base ${name}`}
          onClick={() => {
            const r = removeBase(definition, name, queuedUses);
            if (r.ok) onChange(r.definition);
            else setRefused(r.reasons);
          }}
        >
          Delete
        </button>
      )}
      {refused !== null && (
        <p className="error" role="alert">
          Can’t delete “{name}”: {refused.join(', and ')}.
        </p>
      )}
    </li>
  );
}
