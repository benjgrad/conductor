import type { WorkflowDefinition } from '@conductor/shared';
import { useMemo, type KeyboardEvent } from 'react';
import { columnTitle, QUEUED_LANE, type LaneEdge } from './columns.js';
import { layoutLanes, type LaidLane, type LaidLaneEdge } from './columns-layout.js';
import './workflow.css';

// The one workflow drawn as its board columns (ADR-0010): an implicit Queued lane, then one lane
// per state in `columns` order, with labelled transition arrows between them and dashed "not met"
// loops back. Lanes are buttons when `onSelectColumn` is given, and arrows when `onSelectEdge` is
// (the Workflow view's editors, ADR-0011).

export interface ColumnsDiagramProps {
  definition: WorkflowDefinition;
  /** The selected column (state name). */
  selected?: string | null;
  /** Columns with validation problems. */
  errors?: ReadonlySet<string>;
  onSelectColumn?: (state: string) => void;
  /** ADR-0011: arrows are buttons when given (the Workflow view's transition panel). */
  onSelectEdge?: (edge: LaneEdge) => void;
  /** The selected arrow's edge id (`arrowId(from, to)`). */
  selectedEdge?: string | null;
  /** Edge ids with validation problems. */
  errorEdges?: ReadonlySet<string>;
  /** The session's lane (a state name or QUEUED_LANE). */
  current?: string | null;
  /** The session's entry step (ADR-0010): it is checking the requirements to enter `to`. */
  checking?: { to: string; phase: string | null } | null;
  compact?: boolean;
  /** Accessible name of the diagram. */
  label?: string;
}

export function ColumnsDiagram({
  definition,
  selected,
  errors,
  onSelectColumn,
  onSelectEdge,
  selectedEdge,
  errorEdges,
  current,
  checking,
  compact = false,
  label,
}: ColumnsDiagramProps) {
  const layout = useMemo(() => layoutLanes(definition, { compact }), [definition, compact]);
  const isChecking = (e: LaidLaneEdge) =>
    !!checking && e.edge.kind === 'outcome' && e.edge.to === checking.to && e.edge.from === current;
  // ADR-0011: an arrow (and a dashed loop that belongs to one transition) opens its transitions.
  const isSelectable = (e: LaidLaneEdge) =>
    !!onSelectEdge && (e.edge.kind === 'outcome' || e.edge.owner !== undefined);
  return (
    <div className={`wf-diagram${compact ? ' compact' : ''}`}>
      <div className={compact ? undefined : 'wf-scroll'}>
        <svg
          className="wf-svg wf-lanes"
          role="group"
          aria-label={label ?? `${definition.id} v${definition.version} columns`}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={compact ? '100%' : layout.width}
          {...(compact ? { style: { maxWidth: layout.width } } : { height: layout.height })}
          preserveAspectRatio="xMinYMin meet"
        >
          <g className="wf-lanes-lanes">
            {layout.lanes.map((l) => (
              <LaneBox
                key={l.lane.id}
                laid={l}
                selected={l.lane.id === selected}
                error={!!errors?.has(l.lane.id)}
                current={l.lane.id === current}
                checking={checking?.to === l.lane.id}
                checkingPhase={checking?.phase ?? null}
                {...(onSelectColumn && l.lane.id !== QUEUED_LANE
                  ? { onSelect: onSelectColumn }
                  : {})}
              />
            ))}
          </g>
          <g className="wf-edges">
            {layout.edges.map((e) => {
              const selectable = isSelectable(e);
              const activate = () => onSelectEdge?.(e.edge);
              return (
                <g
                  key={e.edge.id}
                  className={[
                    'wf-edge',
                    `wf-edge-${e.edge.kind}`,
                    e.edge.dashed ? 'dashed' : '',
                    e.edge.gated ? 'gated' : '',
                    isChecking(e) ? 'reviewing' : '',
                    selectable ? 'selectable' : '',
                    e.edge.id === selectedEdge ? 'selected' : '',
                    errorEdges?.has(e.edge.id) ? 'error' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-edge={e.edge.id}
                  aria-current={isChecking(e) ? 'step' : undefined}
                  {...(selectable
                    ? {
                        tabIndex: 0,
                        role: 'button',
                        'aria-label': `Arrow ${e.edge.title}`,
                        'aria-pressed': e.edge.id === selectedEdge,
                        onClick: activate,
                        onKeyDown: (ev: KeyboardEvent) => {
                          if (ev.key === 'Enter' || ev.key === ' ') {
                            ev.preventDefault();
                            activate();
                          }
                        },
                      }
                    : {})}
                >
                  <title>
                    {isChecking(e)
                      ? `${e.edge.title} (checking requirements to enter ${columnTitle(definition, e.edge.to)})`
                      : e.edge.title}
                  </title>
                  {selectable && <path className="wf-hit" d={e.d} />}
                  <path className="wf-line" d={e.d} />
                  <polygon className="wf-arrow" points={e.arrow} />
                </g>
              );
            })}
          </g>
          <g className="wf-labels" aria-hidden="true">
            {layout.edges.map((e) => (
              <g
                key={e.edge.id}
                className={[
                  'wf-label',
                  `wf-label-${e.edge.kind}`,
                  isSelectable(e) ? 'selectable' : '',
                  e.edge.id === selectedEdge ? 'selected' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                {...(isSelectable(e) ? { onClick: () => onSelectEdge?.(e.edge) } : {})}
              >
                <rect
                  className="wf-halo"
                  x={e.label.x}
                  y={e.label.y}
                  width={e.label.w}
                  height={e.label.h}
                  rx={4}
                />
                <text className="wf-outcome" x={e.label.x + 5} y={e.label.y + e.label.h - 4}>
                  {e.label.text}
                  {e.label.badge && (
                    <tspan className="wf-gate" dx={6}>
                      {e.label.badge}
                    </tspan>
                  )}
                </text>
              </g>
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}

function LaneBox({
  laid,
  selected,
  error,
  current,
  checking,
  checkingPhase,
  onSelect,
}: {
  laid: LaidLane;
  selected: boolean;
  error: boolean;
  current: boolean;
  checking: boolean;
  checkingPhase: string | null;
  onSelect?: (state: string) => void;
}) {
  const { lane, x, y, w, h, lines } = laid;
  const type = lane.state?.type ?? 'queued';
  const activate = () => onSelect?.(lane.id);
  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      activate();
    }
  };
  const cls = [
    'wf-lane',
    `wf-lane-${type}`,
    current ? 'current' : '',
    checking ? 'checking' : '',
    selected ? 'selected' : '',
    error ? 'error' : '',
    onSelect ? 'selectable' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const name = `Column ${lane.title}: ${lane.work}${lane.entry ? ', has requirements to enter' : ''}`;
  const tip = checking
    ? `${name}; checking requirements to enter${checkingPhase ? ` (${checkingPhase})` : ''}`
    : name;
  return (
    <g
      className={cls}
      data-lane={lane.id}
      aria-current={current ? 'step' : undefined}
      {...(onSelect
        ? {
            tabIndex: 0,
            role: 'button',
            'aria-label': name,
            'aria-pressed': selected,
            onClick: activate,
            onKeyDown,
          }
        : {})}
    >
      <title>{tip}</title>
      <rect x={x} y={y} width={w} height={h} rx={8} ry={8} />
      {lines.map((l, i) => (
        <text key={i} className={l.cls} x={x + 10} y={l.y}>
          {l.text}
        </text>
      ))}
      {checking && (
        <text className="wf-lane-checking" x={x + 10} y={y + h - 8}>
          checking requirements
        </text>
      )}
    </g>
  );
}
