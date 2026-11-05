import type { WorkflowDefinition } from '@conductor/shared';
import {
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  columnStates,
  columnTitle,
  LANE_KIND_LABELS,
  QUEUED_LANE,
  type LaneEdge,
} from './columns.js';
import {
  laneAt,
  layoutLanes,
  type LaidLane,
  type LaidLaneEdge,
  type Point,
} from './columns-layout.js';
import './workflow.css';

// The one workflow drawn as its board columns (ADR-0010): an implicit Queued lane, then one lane
// per state in `columns` order, with labelled transition arrows between them and dashed "not met"
// loops back. Lanes are buttons when `onSelectColumn` is given, and arrows when `onSelectEdge` is
// (the Workflow view's editors, ADR-0011). UXR-45: it fits the width by default; the zoom
// buttons enlarge it inside its scroll box. UXR-67: with `onAddColumn`, a "+" between two lanes
// adds a column there; with `onDrawTransition`, a handle on a lane's right edge draws a transition:
// drag it onto another lane (or the same one), or press it for a "Goes to…" menu.

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
  /** UXR-73: columns a compared version or a proposal changes (highlighted). */
  changedStates?: ReadonlySet<string>;
  /** UXR-73: arrows (`arrowId`) it changes; ids not drawn are ignored. */
  changedEdges?: ReadonlySet<string>;
  /** The session's lane (a state name or QUEUED_LANE). */
  current?: string | null;
  /** The session's entry step (ADR-0010): it is checking the requirements to enter `to`. */
  checking?: { to: string; phase: string | null } | null;
  compact?: boolean;
  /** Accessible name of the diagram. */
  label?: string;
  /** UXR-67: add a column after this lane (a state, or QUEUED_LANE). */
  onAddColumn?: (after: string) => void;
  /** UXR-67: a transition drawn from one column to another (or itself). */
  onDrawTransition?: (from: string, to: string) => void;
}

/** How far the pointer must move before a press on the handle is a drag. */
const DRAG_MIN = 4;
/** Room after the last lane for its "+". */
const ADD_ROOM = 34;

interface Drag {
  from: string;
  /** Client coordinates of the press. */
  start: { x: number; y: number };
  moved: boolean;
  /** Where the line is drawn to, in diagram coordinates (null: no screen transform, e.g. tests). */
  at: Point | null;
}

export function ColumnsDiagram({
  definition,
  selected,
  errors,
  onSelectColumn,
  onSelectEdge,
  selectedEdge,
  errorEdges,
  changedStates,
  changedEdges,
  current,
  checking,
  compact = false,
  label,
  onAddColumn,
  onDrawTransition,
}: ColumnsDiagramProps) {
  const layout = useMemo(() => layoutLanes(definition, { compact }), [definition, compact]);
  // null = fit to the container width.
  const [zoom, setZoom] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  /** The lane whose "Goes to…" menu is open. */
  const [menuFrom, setMenuFrom] = useState<string | null>(null);
  /** A drag just ended on the handle: its click must not open the menu. */
  const dragged = useRef(false);
  const width = layout.width + (onAddColumn ? ADD_ROOM : 0);

  useEffect(() => {
    if (drag === null) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setDrag(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag]);

  /** A pointer event's position in diagram coordinates, when the browser can say. */
  const toDiagram = (ev: { clientX: number; clientY: number }): Point | null => {
    const ctm = svgRef.current?.getScreenCTM?.();
    if (!ctm) return null;
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };
  const startDrag = (from: string, ev: ReactPointerEvent<Element>) => {
    if (ev.button !== 0) return;
    // Touch pointers are captured by the element pressed; release it so the drop lands on a lane.
    // (jsdom has no pointer capture.)
    const el = ev.currentTarget;
    if (typeof el.hasPointerCapture === 'function' && el.hasPointerCapture(ev.pointerId)) {
      el.releasePointerCapture(ev.pointerId);
    }
    ev.preventDefault();
    setMenuFrom(null);
    setDrag({ from, start: { x: ev.clientX, y: ev.clientY }, moved: false, at: toDiagram(ev) });
  };
  const moveDrag = (ev: ReactPointerEvent<SVGSVGElement>) => {
    if (drag === null) return;
    const moved =
      drag.moved || Math.hypot(ev.clientX - drag.start.x, ev.clientY - drag.start.y) >= DRAG_MIN;
    setDrag({ ...drag, moved, at: toDiagram(ev) });
  };
  const endDrag = (ev: ReactPointerEvent<SVGSVGElement>) => {
    if (drag === null) return;
    setDrag(null);
    if (!drag.moved) return;
    dragged.current = true;
    const target = (ev.target as Element | null)?.closest?.('[data-lane]');
    const p = toDiagram(ev);
    const to = target?.getAttribute('data-lane') ?? (p ? laneAt(layout, p) : null);
    if (to && to !== QUEUED_LANE && definition.states[to]) onDrawTransition?.(drag.from, to);
  };
  const dragLane = drag ? layout.lanes.find((l) => l.lane.id === drag.from) : undefined;
  const isChecking = (e: LaidLaneEdge) =>
    !!checking && e.edge.kind === 'outcome' && e.edge.to === checking.to && e.edge.from === current;
  // ADR-0011: an arrow (and a dashed loop that belongs to one transition) opens its transitions.
  const isSelectable = (e: LaidLaneEdge) =>
    !!onSelectEdge && (e.edge.kind === 'outcome' || e.edge.owner !== undefined);
  return (
    <div className={`wf-diagram${compact ? ' compact' : ''}`}>
      {!compact && (
        <div className="wf-zoom wf-zoom-inline" role="toolbar" aria-label="Zoom">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => setZoom((z) => Math.max(0.5, (z ?? 1) / 1.25))}
          >
            −
          </button>
          <button type="button" onClick={() => setZoom(null)} aria-pressed={zoom === null}>
            Fit
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => setZoom((z) => Math.min(3, (z ?? 1) * 1.25))}
          >
            +
          </button>
        </div>
      )}
      <div className={compact ? undefined : 'wf-scroll'}>
        <svg
          ref={svgRef}
          className={`wf-svg wf-lanes${drag?.moved ? ' drawing' : ''}`}
          role="group"
          aria-label={label ?? `${definition.id} v${definition.version} columns`}
          viewBox={`0 0 ${width} ${layout.height}`}
          {...(zoom === null
            ? { width: '100%', style: { maxWidth: width } }
            : { width: width * zoom, height: layout.height * zoom })}
          preserveAspectRatio="xMinYMin meet"
          {...(onDrawTransition
            ? { onPointerMove: moveDrag, onPointerUp: endDrag, onPointerLeave: () => setDrag(null) }
            : {})}
        >
          <g className="wf-lanes-lanes">
            {layout.lanes.map((l) => (
              <LaneBox
                key={l.lane.id}
                laid={l}
                selected={l.lane.id === selected}
                error={!!errors?.has(l.lane.id)}
                changed={!!changedStates?.has(l.lane.id)}
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
              const changed = !!changedEdges?.has(e.edge.id);
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
                    changed ? 'changed' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-edge={e.edge.id}
                  aria-current={isChecking(e) ? 'step' : undefined}
                  {...(selectable
                    ? {
                        tabIndex: 0,
                        role: 'button',
                        'aria-label': `Arrow ${e.edge.title}${changed ? ' (changed)' : ''}`,
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
                <text className="wf-outcome" x={e.label.x + 5} y={e.label.y + 14}>
                  {e.label.lines.map((line, i) => (
                    <tspan key={i} x={e.label.x + 5} {...(i > 0 ? { dy: 14 } : {})}>
                      {line}
                    </tspan>
                  ))}
                  {e.label.badge && (
                    <tspan className="wf-gate" dx={6}>
                      {e.label.badge}
                    </tspan>
                  )}
                </text>
              </g>
            ))}
          </g>
          {onAddColumn && (
            <g className="wf-add-columns">
              {layout.lanes.map((l, i) => {
                const next = layout.lanes[i + 1];
                const cx = next ? (l.x + l.w + next.x) / 2 : l.x + l.w + ADD_ROOM / 2 + 2;
                const cy = l.y + l.h - 14;
                return (
                  <SvgButton
                    key={l.lane.id}
                    className="wf-add-column"
                    label={`Add a column after ${l.lane.title}`}
                    onActivate={() => onAddColumn(l.lane.id)}
                  >
                    <title>{`Add a column after ${l.lane.title}`}</title>
                    <circle cx={cx} cy={cy} r={9} />
                    <text x={cx} y={cy + 4} textAnchor="middle" aria-hidden="true">
                      +
                    </text>
                  </SvgButton>
                );
              })}
            </g>
          )}
          {onDrawTransition && (
            <g className="wf-draw-handles">
              {layout.lanes
                .filter((l) => l.lane.state !== null && l.lane.state.type !== 'terminal')
                .map((l) => {
                  const cx = l.x + l.w;
                  const cy = l.y + l.h / 2;
                  return (
                    <SvgButton
                      key={l.lane.id}
                      className="wf-draw-handle"
                      label={`Draw a transition from ${l.lane.title}`}
                      expanded={menuFrom === l.lane.id}
                      onActivate={() => {
                        if (dragged.current) {
                          dragged.current = false;
                          return;
                        }
                        setMenuFrom((m) => (m === l.lane.id ? null : l.lane.id));
                      }}
                      onPointerDown={(ev) => startDrag(l.lane.id, ev)}
                    >
                      <title>{`Drag onto a column to add a transition from ${l.lane.title}`}</title>
                      <circle cx={cx} cy={cy} r={7} />
                      <path
                        d={`M ${cx - 3} ${cy} L ${cx + 3} ${cy} M ${cx + 1} ${cy - 2} L ${cx + 3} ${cy} L ${cx + 1} ${cy + 2}`}
                      />
                    </SvgButton>
                  );
                })}
            </g>
          )}
          {drag?.moved && dragLane && drag.at && (
            <line
              className="wf-draw-line"
              x1={dragLane.x + dragLane.w}
              y1={dragLane.y + dragLane.h / 2}
              x2={drag.at.x}
              y2={drag.at.y}
              aria-hidden="true"
            />
          )}
        </svg>
      </div>
      {menuFrom !== null && onDrawTransition && (
        <GoesToMenu
          definition={definition}
          from={menuFrom}
          onPick={(to) => {
            setMenuFrom(null);
            onDrawTransition(menuFrom, to);
          }}
          onClose={() => setMenuFrom(null)}
        />
      )}
    </div>
  );
}

/** A focusable SVG button (Enter or Space activates it, like a lane). */
function SvgButton({
  className,
  label,
  expanded,
  onActivate,
  onPointerDown,
  children,
}: {
  className: string;
  label: string;
  expanded?: boolean;
  onActivate: () => void;
  onPointerDown?: (ev: ReactPointerEvent<Element>) => void;
  children: ReactNode;
}) {
  return (
    <g
      className={className}
      role="button"
      tabIndex={0}
      aria-label={label}
      {...(expanded !== undefined ? { 'aria-haspopup': 'menu', 'aria-expanded': expanded } : {})}
      onClick={onActivate}
      onKeyDown={(ev: KeyboardEvent) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onActivate();
        }
      }}
      {...(onPointerDown ? { onPointerDown } : {})}
    >
      {children}
    </g>
  );
}

/** UXR-67: the keyboard way to draw a transition: pick where it goes. */
function GoesToMenu({
  definition,
  from,
  onPick,
  onClose,
}: {
  definition: WorkflowDefinition;
  from: string;
  onPick: (to: string) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [from]);
  return (
    <div
      ref={box}
      className="wf-goes-to"
      role="menu"
      aria-label={`New transition from ${columnTitle(definition, from)} goes to…`}
      onKeyDown={(ev) => {
        if (ev.key === 'Escape') {
          ev.stopPropagation();
          onClose();
        }
      }}
    >
      <span className="muted">New transition from {columnTitle(definition, from)} goes to…</span>
      {columnStates(definition).map((n) => (
        <button key={n} type="button" role="menuitem" onClick={() => onPick(n)}>
          {columnTitle(definition, n)}
          {n === from ? ' (itself)' : ''}
        </button>
      ))}
      <button type="button" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}

function LaneBox({
  laid,
  selected,
  error,
  changed,
  current,
  checking,
  checkingPhase,
  onSelect,
}: {
  laid: LaidLane;
  selected: boolean;
  error: boolean;
  changed: boolean;
  current: boolean;
  checking: boolean;
  checkingPhase: string | null;
  onSelect?: (state: string) => void;
}) {
  const { lane, x, y, w, h, lines } = laid;
  const type = lane.state?.type ?? 'queued';
  const kindLabel = LANE_KIND_LABELS[lane.kind];
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
    `wf-lane-kind-${lane.kind}`,
    current ? 'current' : '',
    checking ? 'checking' : '',
    selected ? 'selected' : '',
    error ? 'error' : '',
    changed ? 'changed' : '',
    onSelect ? 'selectable' : '',
  ]
    .filter(Boolean)
    .join(' ');
  // UXR-45's kind (restored: a merge on main dropped it) and UXR-73's change mark.
  const name =
    `Column ${lane.title}: ${lane.work}` +
    `${lane.entry ? ', has requirements to enter' : ''} (${kindLabel} column)` +
    `${changed ? ' (changed)' : ''}`;
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
      <rect className="wf-lane-box" x={x} y={y} width={w} height={h} rx={8} ry={8} />
      {/* UXR-58: keyboard focus, drawn apart from selection (workflow.css). */}
      {onSelect && (
        <rect
          className="wf-focus-ring"
          x={x - 4}
          y={y - 4}
          width={w + 8}
          height={h + 8}
          rx={11}
          ry={11}
          aria-hidden="true"
        />
      )}
      {lines.map((l, i) => (
        <text key={i} className={l.cls} x={x + 10} y={l.y}>
          {l.icon && (
            <tspan className="wf-lane-icon" aria-hidden="true">
              {`${l.icon} `}
            </tspan>
          )}
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
