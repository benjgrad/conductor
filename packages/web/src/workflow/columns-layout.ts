import type { WorkflowDefinition } from '@conductor/shared';
import {
  buildLaneGraph,
  entryLines,
  entryShort,
  type Lane,
  type LaneEdge,
  type LaneGraph,
} from './columns.js';
import { textWidth } from './layout.js';

// Layout for the columns diagram (ADR-0010): one lane per column, left to right, all the same
// height. Arrows between neighbouring lanes run straight across the gap between them (the gap
// grows to fit the label). Every other arrow is an orthogonal arc: forward ones above the lanes,
// backward ones (and dashed unmet / else loops) below, each on its own level so arcs whose spans
// overlap never share a horizontal run. Arc ends spread out along the lane edge they attach to.

export interface LaidLane {
  lane: Lane;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Text lines, top to bottom (y is the baseline). */
  lines: { text: string; y: number; cls: string }[];
}

export interface LaidLaneEdge {
  edge: LaneEdge;
  side: 'across' | 'above' | 'below';
  d: string;
  arrow: string;
  label: { x: number; y: number; w: number; h: number; text: string; badge?: string };
}

export interface LanesLayout {
  width: number;
  height: number;
  lanes: LaidLane[];
  edges: LaidLaneEdge[];
}

const LANE_W = 196;
const COMPACT_LANE_W = 150;
const PAD = 10;
const MIN_GAP = 40;
const LEVEL_H = 26;
const MARGIN = 10;
const LABEL_PX = 11;
const LABEL_H = 16;
const SLOT = 14;
const ARROW = 7;

/** Greedy word wrap to `max` characters per line. */
export function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= max) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
    while (line.length > max) {
      out.push(line.slice(0, max));
      line = line.slice(max);
    }
  }
  if (line !== '') out.push(line);
  return out.length > 0 ? out : [''];
}

function laneLines(lane: Lane, def: WorkflowDefinition, w: number, compact: boolean) {
  const chars = Math.floor((w - 2 * PAD) / (11 * 0.58));
  const lines: { text: string; cls: string; h: number }[] = [];
  lines.push({ text: lane.title, cls: 'wf-lane-title', h: 18 });
  for (const l of wrap(lane.work, chars).slice(0, compact ? 2 : 3)) {
    lines.push({ text: l, cls: 'wf-lane-work', h: 15 });
  }
  if (lane.entry) {
    if (compact) {
      for (const l of wrap(`Requires: ${entryShort(lane.entry)}`, chars)) {
        lines.push({ text: l, cls: 'wf-lane-req', h: 15 });
      }
    } else {
      lines.push({ text: 'Requirements to enter', cls: 'wf-lane-req-head', h: 20 });
      for (const item of entryLines(def, lane.entry)) {
        const unmet = item.startsWith('Not met');
        for (const l of wrap(item, chars)) {
          lines.push({ text: l, cls: unmet ? 'wf-lane-unmet' : 'wf-lane-req', h: 15 });
        }
      }
    }
  }
  return lines;
}

function labelWidth(e: LaneEdge) {
  const badge = e.gate !== undefined ? `✓ ${e.gate}` : '';
  return Math.ceil(textWidth(e.label + (badge ? `  ${badge}` : ''), LABEL_PX) + 10);
}

export function layoutLanes(
  def: WorkflowDefinition,
  opts: { compact?: boolean } = {},
): LanesLayout {
  const compact = opts.compact ?? false;
  const graph: LaneGraph = buildLaneGraph(def);
  const w = compact ? COMPACT_LANE_W : LANE_W;
  const index = new Map(graph.lanes.map((l, i) => [l.id, i]));
  const idx = (id: string) => index.get(id) ?? -1;

  // Which edges go straight across a gap: solid, between neighbours, left to right.
  const across = (e: LaneEdge) => !e.dashed && idx(e.to) === idx(e.from) + 1;
  const gaps = graph.lanes.map(() => MIN_GAP);
  for (const e of graph.edges) {
    if (across(e)) gaps[idx(e.from)] = Math.max(gaps[idx(e.from)]!, labelWidth(e) + 2 * ARROW);
  }

  // Arc levels per side: shortest spans first, each on the lowest level free across its span.
  const arcs = graph.edges.filter((e) => !across(e) && idx(e.from) !== idx(e.to));
  const sideOf = (e: LaneEdge): 'above' | 'below' =>
    !e.dashed && idx(e.to) > idx(e.from) ? 'above' : 'below';
  const level = new Map<string, number>();
  const placed: { side: string; lo: number; hi: number; level: number }[] = [];
  const span = (e: LaneEdge) => Math.abs(idx(e.to) - idx(e.from));
  for (const e of [...arcs].sort((a, b) => span(a) - span(b))) {
    const side = sideOf(e);
    const lo = Math.min(idx(e.from), idx(e.to));
    const hi = Math.max(idx(e.from), idx(e.to));
    let l = 1;
    while (placed.some((p) => p.side === side && p.level === l && p.lo <= hi && lo <= p.hi)) l++;
    placed.push({ side, lo, hi, level: l });
    level.set(e.id, l);
  }
  const levels = (side: string) =>
    Math.max(0, ...placed.filter((p) => p.side === side).map((p) => p.level));

  // Lanes.
  const texts = graph.lanes.map((l) => laneLines(l, def, w, compact));
  // Compact (session) lanes keep a footer line free for "checking requirements".
  const laneH =
    Math.max(...texts.map((t) => t.reduce((s, l) => s + l.h, 0))) + 2 * PAD + (compact ? 16 : 0);
  const top = MARGIN + levels('above') * LEVEL_H + (levels('above') > 0 ? 6 : 0);
  let x = MARGIN;
  const lanes: LaidLane[] = graph.lanes.map((lane, i) => {
    let y = top + PAD;
    const lines = texts[i]!.map((l) => {
      y += l.h;
      return { text: l.text, cls: l.cls, y: y - 4 };
    });
    const laid = { lane, x, y: top, w, h: laneH, lines };
    x += w + gaps[i]!;
    return laid;
  });
  const width = x - gaps[gaps.length - 1]! + MARGIN;
  const bottom = top + laneH;
  const height = bottom + levels('below') * LEVEL_H + (levels('below') > 0 ? 6 : 0) + MARGIN;

  // Arc ends: spread along each lane's top / bottom edge, ordered by where the arc goes.
  const ends = new Map<string, { edge: string; end: 'from' | 'to'; other: number }[]>();
  for (const e of arcs) {
    const side = sideOf(e);
    for (const end of ['from', 'to'] as const) {
      const at = end === 'from' ? e.from : e.to;
      const key = `${at}/${side}`;
      const list = ends.get(key) ?? [];
      list.push({ edge: e.id, end, other: idx(end === 'from' ? e.to : e.from) });
      ends.set(key, list);
    }
  }
  const endX = (laneId: string, side: string, edge: string, end: 'from' | 'to') => {
    const lane = lanes[idx(laneId)]!;
    const list = [...(ends.get(`${laneId}/${side}`) ?? [])].sort(
      (a, b) => a.other - b.other || (a.end === b.end ? 0 : a.end === 'from' ? -1 : 1),
    );
    const n = list.findIndex((p) => p.edge === edge && p.end === end);
    const cx = lane.x + lane.w / 2;
    return cx + (n - (list.length - 1) / 2) * SLOT;
  };

  const edges: LaidLaneEdge[] = [];
  for (const e of graph.edges) {
    const a = lanes[idx(e.from)];
    const b = lanes[idx(e.to)];
    if (!a || !b || a === b) continue;
    const lw = labelWidth(e);
    const badge = e.gate !== undefined ? `✓ ${e.gate}` : undefined;
    if (across(e)) {
      const y = top + 26;
      const x1 = a.x + a.w;
      const x2 = b.x;
      edges.push({
        edge: e,
        side: 'across',
        d: `M ${x1} ${y} L ${x2 - ARROW} ${y}`,
        arrow: `${x2},${y} ${x2 - ARROW},${y - 4} ${x2 - ARROW},${y + 4}`,
        label: {
          x: (x1 + x2) / 2 - lw / 2,
          y: y - LABEL_H - 2,
          w: lw,
          h: LABEL_H,
          text: e.label,
          ...(badge ? { badge } : {}),
        },
      });
      continue;
    }
    const side = sideOf(e);
    const l = level.get(e.id) ?? 1;
    const sx = endX(e.from, side, e.id, 'from');
    const tx = endX(e.to, side, e.id, 'to');
    const edgeY = side === 'above' ? top : bottom;
    const runY = side === 'above' ? top - l * LEVEL_H : bottom + l * LEVEL_H;
    const dir = side === 'above' ? 1 : -1; // arrow points down into the lane top, or up
    const tipY = edgeY;
    edges.push({
      edge: e,
      side,
      d: `M ${sx} ${edgeY} L ${sx} ${runY} L ${tx} ${runY} L ${tx} ${tipY - dir * ARROW}`,
      arrow: `${tx},${tipY} ${tx - 4},${tipY - dir * ARROW} ${tx + 4},${tipY - dir * ARROW}`,
      label: {
        x: (sx + tx) / 2 - lw / 2,
        y: runY - LABEL_H / 2,
        w: lw,
        h: LABEL_H,
        text: e.label,
        ...(badge ? { badge } : {}),
      },
    });
  }
  return { width, height, lanes, edges };
}
