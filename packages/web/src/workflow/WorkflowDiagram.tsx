import type { WorkflowDefinition } from '@conductor/shared';
import { useMemo, useState, type KeyboardEvent } from 'react';
import {
  DETAIL_MAX_CHARS,
  INITIAL_RADIUS,
  LABEL_BADGE_HEIGHT,
  LABEL_LINE_HEIGHT,
  layoutGraph,
  TERMINAL_RADIUS,
  textWidth,
  truncate,
  type LaidEdge,
  type LaidNode,
} from './layout.js';
import { buildGraph, transitionKey } from './model.js';
import { parseReviewState } from './review.js';
import './workflow.css';

// The workflow as a UML state diagram (ADR-0009), drawn as SVG from layout.ts. Read-only unless
// `onSelectTransition` is given: then every transition's edges are focusable buttons.

export interface WorkflowDiagramProps {
  definition: WorkflowDefinition;
  /**
   * Highlight this state (the session's current state). A review label
   * (`"implement → build (review)"`) highlights the gated edge being reviewed instead.
   */
  current?: string | null;
  /** transitionKey(from, outcome) of the selected transition. */
  selected?: string | null;
  /** transitionKeys with validation errors. */
  errors?: ReadonlySet<string>;
  onSelectTransition?: (from: string, outcome: string) => void;
  /** Smaller, no zoom controls (the session Details tab). */
  compact?: boolean;
  /** Accessible name of the diagram. */
  label?: string;
}

export function WorkflowDiagram({
  definition,
  current,
  selected,
  errors,
  onSelectTransition,
  compact = false,
  label,
}: WorkflowDiagramProps) {
  const layout = useMemo(() => layoutGraph(buildGraph(definition)), [definition]);
  // null = fit to the container width.
  const [zoom, setZoom] = useState<number | null>(null);
  const review = parseReviewState(current);
  // The edge under review: the gated outcome edge from → to (any outcome edge as a fallback).
  const reviewed = review
    ? (layout.edges.find(
        (e) =>
          e.edge.kind === 'outcome' &&
          e.edge.from === review.from &&
          e.edge.to === review.to &&
          e.edge.gate !== undefined,
      ) ??
      layout.edges.find(
        (e) => e.edge.kind === 'outcome' && e.edge.from === review.from && e.edge.to === review.to,
      ))
    : undefined;

  const svg = (
    <svg
      className="wf-svg"
      role="group"
      aria-label={label ?? `${definition.id} v${definition.version} state diagram`}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      {...(zoom === null
        ? { width: '100%', style: { maxWidth: compact ? layout.width : layout.width * 1.25 } }
        : { width: layout.width * zoom, height: layout.height * zoom })}
      preserveAspectRatio="xMidYMin meet"
    >
      <g className="wf-edges">
        {layout.edges.map((e) => (
          <Edge
            key={e.edge.id}
            laid={e}
            selected={!!selected && e.edge.outcome !== null && isKey(e, selected)}
            error={!!errors && e.edge.outcome !== null && errors.has(keyOf(e))}
            reviewing={e === reviewed}
            {...(onSelectTransition ? { onSelect: onSelectTransition } : {})}
          />
        ))}
      </g>
      <g className="wf-nodes">
        {layout.nodes.map((n) => (
          <Node key={n.node.id} laid={n} current={n.node.id === current} />
        ))}
      </g>
      <g className="wf-labels">
        {layout.edges.map((e) =>
          e.label ? (
            <EdgeLabel
              key={e.edge.id}
              laid={e}
              selected={!!selected && isKey(e, selected)}
              {...(onSelectTransition ? { onSelect: onSelectTransition } : {})}
            />
          ) : null,
        )}
      </g>
    </svg>
  );

  if (compact) return <div className="wf-diagram compact">{svg}</div>;
  return (
    <div className="wf-diagram">
      <div className="wf-zoom" role="toolbar" aria-label="Zoom">
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => setZoom((z) => Math.max(0.4, (z ?? 1) / 1.25))}
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
      <div className="wf-scroll">{svg}</div>
    </div>
  );
}

const keyOf = (e: LaidEdge) => transitionKey(e.edge.from, e.edge.outcome ?? '');
const isKey = (e: LaidEdge, key: string) => e.edge.outcome !== null && keyOf(e) === key;

function Node({ laid, current }: { laid: LaidNode; current: boolean }) {
  const { node, x, y, w, h } = laid;
  const cx = x + w / 2;
  const common = {
    'aria-current': current ? ('step' as const) : undefined,
    'data-state': node.kind === 'initial' ? undefined : node.id,
  };
  if (node.kind === 'initial') {
    return (
      <g className="wf-node wf-initial">
        <title>Initial state</title>
        <circle cx={cx} cy={y + h / 2} r={INITIAL_RADIUS} />
      </g>
    );
  }
  if (node.kind === 'terminal') {
    const cy = y + TERMINAL_RADIUS;
    return (
      <g className={`wf-node wf-terminal${current ? ' current' : ''}`} {...common}>
        <title>{`${node.id}: final state`}</title>
        <circle className="wf-ring" cx={cx} cy={cy} r={TERMINAL_RADIUS} />
        <circle className="wf-dot" cx={cx} cy={cy} r={TERMINAL_RADIUS - 4.5} />
        <text className="wf-name" x={cx} y={y + h - 3} textAnchor="middle">
          {node.id}
        </text>
      </g>
    );
  }
  const detail = node.detail ? truncate(node.detail, DETAIL_MAX_CHARS) : null;
  return (
    <g
      className={`wf-node wf-state wf-${node.type ?? 'state'}${current ? ' current' : ''}`}
      {...common}
    >
      <title>{`${node.id}: ${node.type} state${node.detail ? ` (${node.detail})` : ''}`}</title>
      <rect x={x} y={y} width={w} height={h} rx={10} ry={10} />
      <text className="wf-stereo" x={cx} y={y + 15} textAnchor="middle">
        {node.stereotype}
      </text>
      <text className="wf-name" x={cx} y={y + 32} textAnchor="middle">
        {node.id}
      </text>
      {detail && (
        <text className="wf-detail" x={cx} y={y + 48} textAnchor="middle">
          {detail}
        </text>
      )}
    </g>
  );
}

function edgeClass(
  e: LaidEdge,
  selected: boolean,
  error: boolean,
  selectable: boolean,
  reviewing: boolean,
) {
  return [
    reviewing ? 'reviewing' : '',
    'wf-edge',
    `wf-edge-${e.edge.kind}`,
    e.edge.dashed ? 'dashed' : '',
    e.edge.gate !== undefined ? 'gated' : '',
    selected ? 'selected' : '',
    error ? 'error' : '',
    selectable ? 'selectable' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function Edge({
  laid,
  selected,
  error,
  reviewing = false,
  onSelect,
}: {
  laid: LaidEdge;
  selected: boolean;
  error: boolean;
  /** The session is in this transition's requirements review. */
  reviewing?: boolean;
  onSelect?: (from: string, outcome: string) => void;
}) {
  const { edge } = laid;
  const outcome = edge.outcome;
  const selectable = !!onSelect && outcome !== null;
  const activate = () => {
    if (selectable) onSelect(edge.from, outcome);
  };
  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      activate();
    }
  };
  return (
    <g
      className={edgeClass(laid, selected, error, selectable, reviewing)}
      data-edge={edge.id}
      aria-current={reviewing ? 'step' : undefined}
      {...(selectable
        ? {
            tabIndex: 0,
            role: 'button',
            'aria-label': edge.title,
            'aria-pressed': selected,
            onClick: activate,
            onKeyDown,
          }
        : {})}
    >
      <title>{reviewing ? `${edge.title} (under review)` : edge.title}</title>
      {selectable && <path className="wf-hit" d={laid.d} />}
      <path className="wf-line" d={laid.d} />
      <polygon className="wf-arrow" points={laid.arrow} />
    </g>
  );
}

function EdgeLabel({
  laid,
  selected,
  onSelect,
}: {
  laid: LaidEdge;
  selected: boolean;
  onSelect?: (from: string, outcome: string) => void;
}) {
  const label = laid.label!;
  const { edge } = laid;
  const outcome = edge.outcome;
  const click = onSelect && outcome !== null ? () => onSelect(edge.from, outcome) : undefined;
  const badgeY = label.y + 2 + label.lines.length * LABEL_LINE_HEIGHT + 2;
  const end = label.align === 'end';
  const textX = end ? label.x + label.w - 4 : label.x + 4;
  const badgeW = label.badge ? textWidth(label.badge, 10.5) + 12 : 0;
  const badgeX = end ? label.x + label.w - 3 - badgeW : label.x + 3;
  return (
    <g
      className={`wf-label wf-label-${edge.kind}${selected ? ' selected' : ''}${click ? ' selectable' : ''}`}
      onClick={click}
      aria-hidden="true"
    >
      <rect className="wf-halo" x={label.x} y={label.y} width={label.w} height={label.h} rx={4} />
      {label.lines.map((line, i) => (
        <text
          key={i}
          className={i === 0 ? 'wf-outcome' : 'wf-policy'}
          x={textX}
          y={label.y + 2 + (i + 1) * LABEL_LINE_HEIGHT - 3}
          textAnchor={end ? 'end' : 'start'}
        >
          {line}
        </text>
      ))}
      {label.badge && (
        <g className="wf-badge" data-badge={edge.id}>
          <rect
            x={badgeX}
            y={badgeY}
            width={badgeW}
            height={LABEL_BADGE_HEIGHT}
            rx={LABEL_BADGE_HEIGHT / 2}
          />
          <text x={badgeX + 6} y={badgeY + LABEL_BADGE_HEIGHT - 5}>
            {label.badge}
          </text>
        </g>
      )}
    </g>
  );
}
