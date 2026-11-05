import type { WorkflowDefinition } from '@conductor/shared';
import {
  buildLaneGraph,
  entryLines,
  LANE_KIND_ICONS,
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
// UXR-45: the whole diagram is narrow enough to fit a 1440 px window (lanes are 160 wide, a gap
// at most 96 with its label wrapped onto two lines), and each label slides along its arc's run to
// a spot no other line crosses (`placeLabel`).

export interface LaidLane {
  lane: Lane;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Text lines, top to bottom (y is the baseline). The title line carries the kind's icon. */
  lines: { text: string; y: number; cls: string; icon?: string }[];
}

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EdgeLabel extends Box {
  /** The label, one line per entry (only straight-across labels wrap). */
  lines: string[];
  /** All of `lines`, joined with a space. */
  text: string;
  badge?: string;
}

export interface LaidLaneEdge {
  edge: LaneEdge;
  side: 'across' | 'above' | 'below';
  /** The orthogonal polyline `d` draws (without the arrow head). */
  points: Point[];
  d: string;
  arrow: string;
  label: EdgeLabel;
}

export interface LanesLayout {
  width: number;
  height: number;
  lanes: LaidLane[];
  edges: LaidLaneEdge[];
}

const LANE_W = 160;
const COMPACT_LANE_W = 150;
const PAD = 10;
const MIN_GAP = 40;
const MAX_GAP = 96;
const LEVEL_H = 30;
const MARGIN = 10;
const LABEL_PX = 11;
const LINE_H = 14;
const LABEL_PAD_Y = 3;
const SLOT = 14;
const ARROW = 7;
const STEP = 8;

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

/** Does the axis-aligned segment a–b touch the box? */
export function segIntersectsBox(a: Point, b: Point, box: Box): boolean {
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  return x1 <= box.x + box.w && box.x <= x2 && y1 <= box.y + box.h && box.y <= y2;
}

export const boxesOverlap = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function laneLines(lane: Lane, def: WorkflowDefinition, w: number, compact: boolean) {
  const chars = Math.floor((w - 2 * PAD) / (11 * 0.58));
  const lines: { text: string; cls: string; h: number; icon?: string }[] = [];
  lines.push({ text: lane.title, cls: 'wf-lane-title', h: 18, icon: LANE_KIND_ICONS[lane.kind] });
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

const lineWidth = (text: string) => textWidth(text, LABEL_PX);
const BADGE_W = (badge: string | undefined) => (badge ? lineWidth(`  ${badge}`) : 0);

/** The label's lines and box size; `maxW` wraps it (straight-across labels only). */
function labelSize(e: LaneEdge, maxW: number | null) {
  const full = Math.ceil(lineWidth(e.label) + BADGE_W(e.badge) + 10);
  let lines = [e.label];
  if (maxW !== null && full > maxW) {
    const chars = Math.max(6, Math.floor((maxW - 10 - BADGE_W(e.badge)) / (LABEL_PX * 0.58)));
    lines = wrap(e.label, chars);
  }
  const w = Math.ceil(
    Math.max(
      ...lines.map((l, i) => lineWidth(l) + (i === lines.length - 1 ? BADGE_W(e.badge) : 0)),
    ) + 10,
  );
  return { lines, w, h: lines.length * LINE_H + 2 * LABEL_PAD_Y };
}

const pathD = (pts: Point[]) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

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
  const acrossSize = new Map<string, ReturnType<typeof labelSize>>();
  for (const e of graph.edges) {
    if (!across(e)) continue;
    const size = labelSize(e, MAX_GAP - 2 * ARROW);
    acrossSize.set(e.id, size);
    gaps[idx(e.from)] = Math.max(gaps[idx(e.from)]!, Math.min(MAX_GAP, size.w + 2 * ARROW));
  }
  const acrossH = Math.max(0, ...[...acrossSize.values()].map((s) => s.h));

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
  const laneH = Math.max(
    acrossH + 24,
    Math.max(...texts.map((t) => t.reduce((s, l) => s + l.h, 0))) + 2 * PAD + (compact ? 16 : 0),
  );
  const top = MARGIN + levels('above') * LEVEL_H + (levels('above') > 0 ? 10 : 0);
  let x = MARGIN;
  const lanes: LaidLane[] = graph.lanes.map((lane, i) => {
    let y = top + PAD;
    const lines = texts[i]!.map((l) => {
      y += l.h;
      return { text: l.text, cls: l.cls, y: y - 4, ...(l.icon ? { icon: l.icon } : {}) };
    });
    const laid = { lane, x, y: top, w, h: laneH, lines };
    x += w + gaps[i]!;
    return laid;
  });
  const width = x - gaps[gaps.length - 1]! + MARGIN;
  const bottom = top + laneH;
  const height = bottom + levels('below') * LEVEL_H + (levels('below') > 0 ? 10 : 0) + MARGIN;

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

  // Geometry first; labels once every line is known.
  const acrossY = top + 10 + acrossH;
  type Draft = Omit<LaidLaneEdge, 'label'> & { run: { lo: number; hi: number; y: number } | null };
  const drafts: Draft[] = [];
  for (const e of graph.edges) {
    const a = lanes[idx(e.from)];
    const b = lanes[idx(e.to)];
    if (!a || !b || a === b) continue;
    if (across(e)) {
      const x1 = a.x + a.w;
      const x2 = b.x;
      const points = [
        { x: x1, y: acrossY },
        { x: x2 - ARROW, y: acrossY },
      ];
      drafts.push({
        edge: e,
        side: 'across',
        points,
        d: pathD(points),
        arrow: `${x2},${acrossY} ${x2 - ARROW},${acrossY - 4} ${x2 - ARROW},${acrossY + 4}`,
        run: null,
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
    const points = [
      { x: sx, y: edgeY },
      { x: sx, y: runY },
      { x: tx, y: runY },
      { x: tx, y: edgeY - dir * ARROW },
    ];
    drafts.push({
      edge: e,
      side,
      points,
      d: pathD(points),
      arrow: `${tx},${edgeY} ${tx - 4},${edgeY - dir * ARROW} ${tx + 4},${edgeY - dir * ARROW}`,
      run: { lo: Math.min(sx, tx), hi: Math.max(sx, tx), y: runY },
    });
  }

  const taken: Box[] = [];
  const clear = (box: Box, self: Draft) => {
    const padded = { x: box.x - 2, y: box.y - 2, w: box.w + 4, h: box.h + 4 };
    if (box.x < 0 || box.x + box.w > width) return false;
    if (taken.some((t) => boxesOverlap(t, padded))) return false;
    if (lanes.some((l) => boxesOverlap(l, padded))) return false;
    return !drafts.some(
      (o) =>
        o !== self &&
        o.points.some((p, i) => i > 0 && segIntersectsBox(o.points[i - 1]!, p, padded)),
    );
  };
  const labels = new Map<Draft, EdgeLabel>();
  const order = [
    ...drafts.filter((d) => d.side === 'across'),
    ...drafts
      .filter((d) => d.side !== 'across')
      .sort((a, b) => (level.get(a.edge.id) ?? 0) - (level.get(b.edge.id) ?? 0)),
  ];
  for (const d of order) {
    const e = d.edge;
    const badge = e.badge;
    let box: Box;
    let lines: string[];
    if (d.side === 'across') {
      const size = acrossSize.get(e.id)!;
      lines = size.lines;
      const x1 = d.points[0]!.x;
      const x2 = d.points[1]!.x + ARROW;
      box = { x: (x1 + x2) / 2 - size.w / 2, y: acrossY - size.h - 2, w: size.w, h: size.h };
    } else {
      const size = labelSize(e, null);
      lines = size.lines;
      const run = d.run!;
      const centre = (run.lo + run.hi) / 2;
      const at = (cx: number) => ({
        x: Math.round(cx - size.w / 2),
        y: run.y - size.h / 2,
        w: size.w,
        h: size.h,
      });
      // Slide along the run, centre first, to a spot no other line crosses.
      const reach = Math.max(run.hi - run.lo, size.w) / 2 + size.w / 2;
      box = at(centre);
      for (let off = 0; off <= reach; off += STEP) {
        const hit = [at(centre - off), at(centre + off)].find((b) => clear(b, d));
        if (hit) {
          box = hit;
          break;
        }
      }
    }
    taken.push(box);
    labels.set(d, {
      ...box,
      lines,
      text: lines.join(' '),
      ...(badge ? { badge } : {}),
    });
  }

  const edges: LaidLaneEdge[] = drafts.map((d) => ({
    edge: d.edge,
    side: d.side,
    points: d.points,
    d: d.d,
    arrow: d.arrow,
    label: labels.get(d)!,
  }));
  return { width, height, lanes, edges };
}
