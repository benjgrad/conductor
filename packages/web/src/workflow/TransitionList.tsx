import {
  RETURN_TO,
  transitionActor,
  transitionTitle,
  type WorkflowDefinition,
} from '@conductor/shared';
import { columnTitle, type ColumnIssue } from './columns.js';
import {
  ACTOR_LABEL,
  getTransitionObject,
  kindsText,
  ruleCount,
  rulesText,
} from './transitions.js';

// Transitions as rows (UXR-64, UXR-65): the arrow panel's list and the column panel's. Each row
// says what tells the transitions apart: the title, who takes it, the ticket kinds and how many
// rules it requires. The name (what agents report) is only in the transition's Advanced section.

export function TransitionList({
  definition,
  from,
  names,
  issues,
  onSelect,
  showGoto = false,
  label,
}: {
  definition: WorkflowDefinition;
  from: string;
  names: string[];
  issues: ColumnIssue[];
  onSelect: (name: string) => void;
  /** Show where each one goes (the column list spans arrows). */
  showGoto?: boolean;
  label: string;
}) {
  return (
    <ul className="wf-transition-list" aria-label={label}>
      {names.map((n) => {
        const t = getTransitionObject(definition, from, n);
        if (t === null) return null;
        const problems = issues.filter(
          (i) => i.transition?.from === from && i.transition.name === n,
        ).length;
        const goto =
          t.goto === RETURN_TO ? 'the column that asked' : columnTitle(definition, t.goto);
        const meta = [
          ACTOR_LABEL[transitionActor(definition, from, n, t)],
          kindsText(t),
          rulesText(ruleCount(t)),
          ...(problems > 0 ? [`${problems} problem${problems === 1 ? '' : 's'}`] : []),
        ].join(' · ');
        return (
          <li key={n}>
            <button
              type="button"
              className={problems > 0 ? 'wf-transition-row error' : 'wf-transition-row'}
              onClick={() => onSelect(n)}
            >
              <span className="wf-transition-title">
                <strong>{transitionTitle(n, t)}</strong>
                {showGoto ? ` → ${goto}` : ''}
              </span>
              <span className="wf-transition-meta">{meta}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
