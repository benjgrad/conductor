import { INITIAL_ID, type GraphEdge, type GraphNode, type WorkflowGraph } from './model.js';

// In-house layered (Sugiyama-style) layout for the workflow state diagram. No dependency: the
// graphs are 5–15 states, so simple versions of each step are enough.
//
//  1. Ranks. DFS from the initial pseudostate marks back edges (to a state on the DFS stack); the
//     rest is a DAG, ranked by longest path. Terminal states sink to the last rank.
//  2. Forward edges spanning several ranks get a dummy node per intermediate rank.
//  3. Order within a rank: barycenter sweeps, keeping the order with the fewest crossings.
//  4. x: each rank is placed at its neighbours' mean x, packed left-to-right and right-to-left
//     with a minimum separation and averaged (both packings respect the order and spacing, so
//     their mean does too): nodes never overlap.
//  5. Edges. Forward edges are smooth curves through their dummies, top to bottom. Back edges,
//     same-rank edges and on_unmet loops run in a vertical lane outside every node of the ranks
//     they span (left or right, whichever is nearer), entering and leaving through a node's side
//     when nothing else is on that side, else through the empty channel between ranks. They never
//     cross a node. Self-loops are a small arc on the node's right, with room reserved for it.
//  6. Labels go beside their edge at the first candidate spot that hits no node and no label.

export interface Pt {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LaidNode extends Box {
  node: GraphNode;
  rank: number;
}

export interface LaidLabel extends Box {
  lines: string[];
  /** Badge text on a gated edge ("✓ 2 requirements"). */
  badge?: string;
  /** `end`: right-aligned, hugging an edge on the label's right. */
  align: 'start' | 'end';
}

export interface LaidEdge {
  edge: GraphEdge;
  routing: 'forward' | 'back' | 'self';
  /** SVG path data. */
  d: string;
  /** Arrowhead polygon (`points` attribute). */
  arrow: string;
  /** The path as a polyline (for hit tests and label placement). */
  points: Pt[];
  label: LaidLabel | null;
}

export interface DiagramLayout {
  width: number;
  height: number;
  nodes: LaidNode[];
  edges: LaidEdge[];
}

// ------------------------------------------------------------------ sizes

const NAME_PX = 13;
const SMALL_PX = 11;
const LABEL_PX = 11;
const LINE_H = 14;
const BADGE_H = 17;
const NODE_MIN_W = 120;
const NODE_MAX_W = 220;
const NODE_PAD = 12;
const TERMINAL_R = 11;
const INITIAL_R = 8;
const ARROW = 8;
const SELF_LOOP = 44;
const MARGIN = 16;

/** Rough text width: the diagram uses system-ui, average glyph ≈ 0.6em. */
export const textWidth = (text: string, px: number) => text.length * px * 0.58;

export const DETAIL_MAX_CHARS = Math.floor((NODE_MAX_W - 2 * NODE_PAD) / (SMALL_PX * 0.6));

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function nodeSize(n: GraphNode): { w: number; h: number } {
  if (n.kind === 'initial') return { w: INITIAL_R * 2, h: INITIAL_R * 2 };
  if (n.kind === 'terminal') {
    return { w: Math.max(TERMINAL_R * 2 + 8, textWidth(n.id, 12) + 8), h: TERMINAL_R * 2 + 18 };
  }
  const detail = n.detail ? truncate(n.detail, DETAIL_MAX_CHARS) : '';
  const w = Math.max(
    textWidth(n.id, NAME_PX) * 1.08,
    textWidth(n.stereotype ?? '', SMALL_PX),
    textWidth(detail, SMALL_PX),
  );
  return {
    w: Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, Math.ceil(w + 2 * NODE_PAD))),
    h: detail ? 58 : 44,
  };
}

function labelSize(e: GraphEdge): { w: number; h: number; badge?: string } {
  if (e.label.length === 0 && e.gate === undefined) return { w: 0, h: 0 };
  const badge = e.gate !== undefined ? `✓ ${e.gate} requirement${e.gate === 1 ? '' : 's'}` : '';
  const w = Math.max(...e.label.map((l) => textWidth(l, LABEL_PX)), textWidth(badge, 10.5) + 12);
  return {
    w: Math.ceil(w + 8),
    h: e.label.length * LINE_H + (badge ? BADGE_H + 2 : 0) + 4,
    ...(badge ? { badge } : {}),
  };
}

// ------------------------------------------------------------------ geometry helpers

const overlaps = (a: Box, b: Box, pad = 0) =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

const r1 = (n: number) => Math.round(n * 10) / 10;
const pt = (p: Pt) => `${r1(p.x)},${r1(p.y)}`;

function arrowAt(tip: Pt, from: Pt): { base: Pt; polygon: string } {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const base = { x: tip.x - ux * ARROW, y: tip.y - uy * ARROW };
  const half = ARROW * 0.45;
  const a = { x: base.x - uy * half, y: base.y + ux * half };
  const b = { x: base.x + uy * half, y: base.y - ux * half };
  return { base, polygon: `${pt(tip)} ${pt(a)} ${pt(b)}` };
}

function cubicPoint(p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
  };
}

/** Orthogonal polyline with rounded corners. */
function roundedPath(points: Pt[], radius = 10): string {
  const first = points[0];
  if (!first) return '';
  let d = `M${pt(first)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const next = points[i + 1]!;
    const lin = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const lout = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, lin / 2, lout / 2);
    if (r <= 0.5) {
      d += ` L${pt(cur)}`;
      continue;
    }
    const a = { x: cur.x - ((cur.x - prev.x) / lin) * r, y: cur.y - ((cur.y - prev.y) / lin) * r };
    const b = {
      x: cur.x + ((next.x - cur.x) / lout) * r,
      y: cur.y + ((next.y - cur.y) / lout) * r,
    };
    d += ` L${pt(a)} Q${pt(cur)} ${pt(b)}`;
  }
  d += ` L${pt(points[points.length - 1]!)}`;
  return d;
}

/** Points along a polyline at fraction `t` of its length. */
function along(points: Pt[], t: number): Pt {
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const l = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    segs.push(l);
    total += l;
  }
  let target = total * t;
  for (let i = 0; i < segs.length; i++) {
    const l = segs[i]!;
    if (target <= l || i === segs.length - 1) {
      const f = l === 0 ? 0 : Math.min(1, target / l);
      const a = points[i]!;
      const b = points[i + 1]!;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    target -= l;
  }
  return points[0] ?? { x: 0, y: 0 };
}

// ------------------------------------------------------------------ layout

interface LNode {
  id: string;
  rank: number;
  w: number;
  h: number;
  dummy: boolean;
  /** Center x. */
  cx: number;
  /** Top y. */
  y: number;
  selfLoop: boolean;
  graph?: GraphNode;
}

interface Segment {
  from: LNode;
  to: LNode;
}

export function layoutGraph(graph: WorkflowGraph): DiagramLayout {
  const byId = new Map<string, LNode>();
  for (const n of graph.nodes) {
    const { w, h } = nodeSize(n);
    byId.set(n.id, {
      id: n.id,
      rank: 0,
      w,
      h,
      dummy: false,
      cx: 0,
      y: 0,
      selfLoop: false,
      graph: n,
    });
  }
  // Edges whose ends both exist (a draft can point at a state that is not there yet).
  const edges = graph.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  for (const e of edges) if (e.from === e.to) byId.get(e.from)!.selfLoop = true;

  // 1. Ranks ---------------------------------------------------------------
  const kindOrder = { initial: 0, outcome: 1, else: 2, unmet: 3, 'unmet-else': 4 } as const;
  const out = new Map<string, GraphEdge[]>();
  for (const e of [...edges].sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind])) {
    const list = out.get(e.from) ?? [];
    list.push(e);
    out.set(e.from, list);
  }
  const back = new Set<GraphEdge>();
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const discovery: string[] = [];
  const dfs = (id: string) => {
    visited.add(id);
    onStack.add(id);
    discovery.push(id);
    for (const e of out.get(id) ?? []) {
      if (onStack.has(e.to)) back.add(e);
      else if (!visited.has(e.to)) dfs(e.to);
    }
    onStack.delete(id);
  };
  dfs(INITIAL_ID);
  for (const n of graph.nodes) if (!visited.has(n.id)) dfs(n.id);

  const dag = edges.filter((e) => !back.has(e) && e.from !== e.to);
  const indeg = new Map<string, number>([...byId.keys()].map((k) => [k, 0]));
  for (const e of dag) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue = [...byId.keys()].filter((k) => indeg.get(k) === 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const u = byId.get(id)!;
    for (const e of dag) {
      if (e.from !== id) continue;
      const v = byId.get(e.to)!;
      v.rank = Math.max(v.rank, u.rank + 1);
      const d = (indeg.get(e.to) ?? 0) - 1;
      indeg.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }
  let maxRank = Math.max(0, ...[...byId.values()].map((n) => n.rank));
  for (const n of byId.values()) if (n.graph?.kind === 'terminal') n.rank = maxRank;
  maxRank = Math.max(0, ...[...byId.values()].map((n) => n.rank));

  // 2. Dummies for long forward edges -------------------------------------
  const forward: { edge: GraphEdge; chain: LNode[] }[] = [];
  const sideRouted: GraphEdge[] = [];
  const selfEdges: GraphEdge[] = [];
  const segments: Segment[] = [];
  for (const e of edges) {
    const u = byId.get(e.from)!;
    const v = byId.get(e.to)!;
    if (u === v) selfEdges.push(e);
    else if (v.rank > u.rank) {
      const chain = [u];
      for (let r = u.rank + 1; r < v.rank; r++) {
        const dummy: LNode = {
          id: `${e.id}#${r}`,
          rank: r,
          w: 12,
          h: 0,
          dummy: true,
          cx: 0,
          y: 0,
          selfLoop: false,
        };
        byId.set(dummy.id, dummy);
        chain.push(dummy);
      }
      chain.push(v);
      for (let i = 1; i < chain.length; i++) segments.push({ from: chain[i - 1]!, to: chain[i]! });
      forward.push({ edge: e, chain });
    } else sideRouted.push(e);
  }

  // 3. Order within ranks --------------------------------------------------
  const order = new Map<string, number>(discovery.map((id, i) => [id, i]));
  const layers: LNode[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const n of byId.values()) layers[n.rank]!.push(n);
  const seed = (n: LNode) => {
    if (!n.dummy) return order.get(n.id) ?? 0;
    const src = n.id.split('/')[0]!;
    return (order.get(src) ?? 0) + 0.5;
  };
  for (const layer of layers) layer.sort((a, b) => seed(a) - seed(b));

  const pos = new Map<LNode, number>();
  const index = () => layers.forEach((l) => l.forEach((n, i) => pos.set(n, i)));
  index();
  const preds = new Map<LNode, LNode[]>();
  const succs = new Map<LNode, LNode[]>();
  for (const s of segments) {
    preds.set(s.to, [...(preds.get(s.to) ?? []), s.from]);
    succs.set(s.from, [...(succs.get(s.from) ?? []), s.to]);
  }
  const crossings = () => {
    let c = 0;
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const a = segments[i]!;
        const b = segments[j]!;
        if (a.from.rank !== b.from.rank) continue;
        const d1 = pos.get(a.from)! - pos.get(b.from)!;
        const d2 = pos.get(a.to)! - pos.get(b.to)!;
        if (d1 * d2 < 0) c++;
      }
    }
    return c;
  };
  let best = layers.map((l) => [...l]);
  let bestCross = crossings();
  for (let iter = 0; iter < 12 && bestCross > 0; iter++) {
    const down = iter % 2 === 0;
    const ranks = down
      ? Array.from({ length: maxRank }, (_, i) => i + 1)
      : Array.from({ length: maxRank }, (_, i) => maxRank - 1 - i);
    for (const r of ranks) {
      const layer = layers[r]!;
      const bary = new Map<LNode, number>();
      for (const n of layer) {
        const nb = (down ? preds.get(n) : succs.get(n)) ?? [];
        bary.set(n, nb.length ? nb.reduce((s, m) => s + pos.get(m)!, 0) / nb.length : pos.get(n)!);
      }
      layer.sort((a, b) => bary.get(a)! - bary.get(b)! || pos.get(a)! - pos.get(b)!);
      layer.forEach((n, i) => pos.set(n, i));
    }
    const c = crossings();
    if (c < bestCross) {
      bestCross = c;
      best = layers.map((l) => [...l]);
    }
  }
  best.forEach((l, r) => (layers[r] = l));
  index();

  // 4. x coordinates -------------------------------------------------------
  const sep = (a: LNode, b: LNode) => {
    const base = a.dummy && b.dummy ? 16 : a.dummy || b.dummy ? 28 : 44;
    return a.w / 2 + b.w / 2 + base + (a.selfLoop ? SELF_LOOP + 12 : 0);
  };
  const place = (layer: LNode[], desired: number[]) => {
    const n = layer.length;
    if (n === 0) return;
    const L = [...desired];
    for (let i = 1; i < n; i++) L[i] = Math.max(L[i]!, L[i - 1]! + sep(layer[i - 1]!, layer[i]!));
    const R = [...desired];
    for (let i = n - 2; i >= 0; i--) {
      R[i] = Math.min(R[i]!, R[i + 1]! - sep(layer[i]!, layer[i + 1]!));
    }
    layer.forEach((node, i) => (node.cx = (L[i]! + R[i]!) / 2));
  };
  for (const layer of layers) {
    // Packed, centred on 0.
    let x = 0;
    layer.forEach((n, i) => {
      if (i > 0) x += sep(layer[i - 1]!, n);
      n.cx = x;
    });
    const shift = x / 2;
    for (const n of layer) n.cx -= shift;
  }
  for (let iter = 0; iter < 24; iter++) {
    const down = iter % 2 === 0;
    const ranks = down
      ? Array.from({ length: maxRank + 1 }, (_, i) => i)
      : Array.from({ length: maxRank + 1 }, (_, i) => maxRank - i);
    for (const r of ranks) {
      const layer = layers[r]!;
      const desired = layer.map((n) => {
        const nb = [...(preds.get(n) ?? []), ...(succs.get(n) ?? [])];
        return nb.length ? nb.reduce((s, m) => s + m.cx, 0) / nb.length : n.cx;
      });
      place(layer, desired);
    }
  }

  // y coordinates: rank bands, with room in each gap for the labels of the edges leaving it.
  const bandH = layers.map((l) => Math.max(0, ...l.map((n) => n.h)));
  const gapLabel = Array.from({ length: maxRank + 1 }, () => 0);
  for (const f of forward) {
    const r = byId.get(f.edge.from)!.rank;
    gapLabel[r] = Math.max(gapLabel[r]!, labelSize(f.edge).h);
  }
  const bandY: number[] = [];
  let y = 0;
  for (let r = 0; r <= maxRank; r++) {
    bandY.push(y);
    y += bandH[r]! + Math.max(52, gapLabel[r]! + 34);
  }
  for (const n of byId.values()) n.y = bandY[n.rank]! + (bandH[n.rank]! - n.h) / 2;

  const real = [...byId.values()].filter((n) => !n.dummy);
  const nodeBox = (n: LNode): Box => ({ x: n.cx - n.w / 2, y: n.y, w: n.w, h: n.h });
  /** Where an edge touches a node: terminal and initial states at their circle. */
  const anchorTop = (n: LNode) => n.y;
  const anchorBottom = (n: LNode) =>
    n.graph?.kind === 'terminal' ? n.y + TERMINAL_R * 2 : n.y + n.h;

  // 5. Routes ---------------------------------------------------------------
  // Lanes for side-routed edges.
  interface Lane {
    edge: GraphEdge;
    u: LNode;
    v: LNode;
    side: 1 | -1;
    x: number;
    lo: number;
    hi: number;
    exitSide: boolean;
    enterSide: boolean;
  }
  const extreme = (lo: number, hi: number, side: 1 | -1) => {
    let ext = side === 1 ? -Infinity : Infinity;
    for (const n of byId.values()) {
      if (n.rank < lo || n.rank > hi) continue;
      const edge = n.cx + (side * n.w) / 2 + (side === 1 && n.selfLoop ? SELF_LOOP + 8 : 0);
      ext = side === 1 ? Math.max(ext, edge) : Math.min(ext, edge);
    }
    return ext;
  };
  const isOutermost = (n: LNode, side: 1 | -1) => {
    const layer = layers[n.rank]!.filter((m) => !m.dummy);
    return side === 1 ? layer[layer.length - 1] === n : layer[0] === n;
  };
  const lanes: Lane[] = [];
  const sorted = [...sideRouted].sort((a, b) => {
    const span = (e: GraphEdge) => Math.abs(byId.get(e.from)!.rank - byId.get(e.to)!.rank);
    return span(a) - span(b);
  });
  const laneCount = { 1: 0, [-1]: 0 } as Record<1 | -1, number>;
  for (const e of sorted) {
    const u = byId.get(e.from)!;
    const v = byId.get(e.to)!;
    const lo = Math.min(u.rank, v.rank);
    const hi = Math.max(u.rank, v.rank);
    const cost = (side: 1 | -1) => {
      const ext = extreme(lo, hi, side);
      // Self-loops sit on the right: keep lanes that touch a looping state off that side.
      const loop = side === 1 && (u.selfLoop || v.selfLoop) ? 400 : 0;
      return side * (ext - u.cx) + side * (ext - v.cx) + laneCount[side] * 30 + loop;
    };
    const side: 1 | -1 = cost(1) <= cost(-1) ? 1 : -1;
    const nested = lanes.filter((l) => l.side === side && l.lo <= hi && lo <= l.hi);
    const ext = Math.max(side * extreme(lo, hi, side), ...nested.map((l) => side * l.x));
    const x = side * (ext + (nested.length ? 18 : 30));
    laneCount[side]++;
    lanes.push({
      edge: e,
      u,
      v,
      side,
      x,
      lo,
      hi,
      exitSide: isOutermost(u, side),
      enterSide: isOutermost(v, side),
    });
  }

  // Ports. Top/bottom ports are spread along the node in the order of the far end's x.
  type PortReq = { key: string; otherX: number };
  const tops = new Map<LNode, PortReq[]>();
  const bottoms = new Map<LNode, PortReq[]>();
  const sides = new Map<string, PortReq[]>(); // `${id}:${side}`
  const push = <K>(m: Map<K, PortReq[]>, k: K, p: PortReq) => m.set(k, [...(m.get(k) ?? []), p]);
  for (const f of forward) {
    const [a, b] = [f.chain[0]!, f.chain[1]!];
    const [y0, y1] = [f.chain[f.chain.length - 2]!, f.chain[f.chain.length - 1]!];
    push(bottoms, a, { key: f.edge.id, otherX: b.cx });
    push(tops, y1, { key: f.edge.id, otherX: y0.cx });
  }
  for (const l of lanes) {
    if (l.exitSide) push(sides, `${l.u.id}:${l.side}`, { key: `${l.edge.id}>`, otherX: l.v.rank });
    else push(tops, l.u, { key: `${l.edge.id}>`, otherX: l.x });
    if (l.enterSide) {
      push(sides, `${l.v.id}:${l.side}`, { key: `${l.edge.id}<`, otherX: l.u.rank + 0.5 });
    } else push(bottoms, l.v, { key: `${l.edge.id}<`, otherX: l.x });
  }
  for (const e of selfEdges) {
    const n = byId.get(e.from)!;
    push(sides, `${n.id}:1`, { key: `${e.id}>`, otherX: 0 });
    push(sides, `${n.id}:1`, { key: `${e.id}<`, otherX: 1 });
  }
  const portY = new Map<string, number>();
  for (const list of [...tops.values(), ...bottoms.values()]) {
    list.sort((a, b) => a.otherX - b.otherX);
  }
  for (const [key, list] of sides) {
    const n = byId.get(key.slice(0, key.lastIndexOf(':')))!;
    list.sort((a, b) => a.otherX - b.otherX);
    const top = n.y + 6;
    const span = (n.graph?.kind === 'terminal' ? TERMINAL_R * 2 : n.h) - 12;
    list.forEach((p, i) => portY.set(p.key, top + (span * (i + 1)) / (list.length + 1)));
  }

  const laid: LaidEdge[] = [];
  for (const f of forward) {
    const pts: Pt[] = f.chain.map((n) => ({ x: n.cx, y: n.y }));
    const first = f.chain[0]!;
    const last = f.chain[f.chain.length - 1]!;
    pts[0] = { x: portXFor(bottoms, first, f.edge.id), y: anchorBottom(first) };
    pts[pts.length - 1] = { x: portXFor(tops, last, f.edge.id), y: anchorTop(last) };
    const tip = pts[pts.length - 1]!;
    const end = { x: tip.x, y: tip.y - ARROW };
    const route = [...pts.slice(0, -1), end];
    let d = `M${pt(route[0]!)}`;
    const samples: Pt[] = [route[0]!];
    for (let i = 1; i < route.length; i++) {
      const p0 = route[i - 1]!;
      const p1 = route[i]!;
      const dy = (p1.y - p0.y) * 0.5;
      const c1 = { x: p0.x, y: p0.y + dy };
      const c2 = { x: p1.x, y: p1.y - dy };
      d += ` C${pt(c1)} ${pt(c2)} ${pt(p1)}`;
      for (let k = 1; k <= 10; k++) samples.push(cubicPoint(p0, c1, c2, p1, k / 10));
    }
    samples.push(tip);
    laid.push({
      edge: f.edge,
      routing: 'forward',
      d,
      arrow: arrowAt(tip, end).polygon,
      points: samples,
      label: null,
    });
  }

  function portXFor(m: Map<LNode, PortReq[]>, n: LNode, key: string): number {
    const list = m.get(n);
    if (!list || n.graph?.kind !== 'state' || list.length === 1) return n.cx;
    const i = list.findIndex((p) => p.key === key);
    const usable = n.w * 0.8;
    return n.cx - usable / 2 + (usable * i) / (list.length - 1);
  }

  const channelUse = new Map<string, number>();
  const channel = (key: string) => {
    const k = channelUse.get(key) ?? 0;
    channelUse.set(key, k + 1);
    return k * 6;
  };
  for (const l of lanes) {
    const { u, v, side, x } = l;
    const pts: Pt[] = [];
    if (l.exitSide) {
      const py = portY.get(`${l.edge.id}>`) ?? u.y + u.h / 2;
      pts.push({ x: u.cx + (side * u.w) / 2, y: py }, { x, y: py });
    } else {
      const px = portXFor(tops, u, `${l.edge.id}>`);
      const cy = anchorTop(u) - 12 - channel(`above${u.rank}`);
      pts.push({ x: px, y: anchorTop(u) }, { x: px, y: cy }, { x, y: cy });
    }
    if (l.enterSide) {
      const py = portY.get(`${l.edge.id}<`) ?? v.y + v.h / 2;
      const vx = v.graph?.kind === 'terminal' ? v.cx + side * TERMINAL_R : v.cx + (side * v.w) / 2;
      pts.push({ x, y: py }, { x: vx, y: py });
    } else {
      const px = portXFor(bottoms, v, `${l.edge.id}<`);
      const cy = bandY[v.rank]! + bandH[v.rank]! + 12 + channel(`below${v.rank}`);
      pts.push({ x, y: cy }, { x: px, y: cy }, { x: px, y: anchorBottom(v) });
    }
    const tip = pts[pts.length - 1]!;
    const prev = pts[pts.length - 2]!;
    const { base, polygon } = arrowAt(tip, prev);
    const route = [...pts.slice(0, -1), base];
    laid.push({
      edge: l.edge,
      routing: 'back',
      d: roundedPath(route),
      arrow: polygon,
      points: pts,
      label: null,
    });
  }
  for (const e of selfEdges) {
    const n = byId.get(e.from)!;
    const x = n.cx + n.w / 2;
    const y1 = portY.get(`${e.id}>`) ?? n.y + n.h * 0.3;
    const y2 = portY.get(`${e.id}<`) ?? n.y + n.h * 0.7;
    const c1 = { x: x + SELF_LOOP, y: y1 - 16 };
    const c2 = { x: x + SELF_LOOP, y: y2 + 16 };
    const tip = { x, y: y2 };
    const { base, polygon } = arrowAt(tip, c2);
    const samples: Pt[] = [];
    for (let k = 0; k <= 10; k++) samples.push(cubicPoint({ x, y: y1 }, c1, c2, tip, k / 10));
    laid.push({
      edge: e,
      routing: 'self',
      d: `M${pt({ x, y: y1 })} C${pt(c1)} ${pt(c2)} ${pt(base)}`,
      arrow: polygon,
      points: samples,
      label: null,
    });
  }

  // 6. Labels ---------------------------------------------------------------
  const obstacles: Box[] = real.map((n) => {
    const b = nodeBox(n);
    return { x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 };
  });
  const placed: Box[] = [];
  // Every edge as dense points, so a label can avoid sitting on another edge's line.
  const dense = new Map<LaidEdge, Pt[]>(
    laid.map((le) => {
      const pts: Pt[] = [];
      for (let i = 1; i < le.points.length; i++) {
        const p = le.points[i - 1]!;
        const q = le.points[i]!;
        const steps = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 6));
        for (let k = 0; k < steps; k++) {
          pts.push({ x: p.x + ((q.x - p.x) * k) / steps, y: p.y + ((q.y - p.y) * k) / steps });
        }
      }
      return [le, pts];
    }),
  );
  const hitsNode = (b: Box) => obstacles.some((o) => overlaps(b, o));
  const hitsLabel = (b: Box) => placed.some((o) => overlaps(b, o, 2));
  const hitsEdge = (b: Box, self: LaidEdge) => {
    for (const [le, pts] of dense) {
      if (le === self) continue;
      if (pts.some((p) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h)) {
        return true;
      }
    }
    return false;
  };
  const laneOf = new Map(lanes.map((l) => [l.edge, l]));
  // Order: gated and long labels first, so they get the best spots.
  const labelOrder = [...laid].sort((a, b) => labelSize(b.edge).h - labelSize(a.edge).h);
  type Candidate = Box & { align: 'start' | 'end' };
  for (const le of labelOrder) {
    const size = labelSize(le.edge);
    if (size.w === 0) continue;
    const { w, h } = size;
    const candidates: Candidate[] = [];
    if (le.routing === 'forward') {
      for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
        const p = along(le.points, t);
        candidates.push(
          { x: p.x + 6, y: p.y - h / 2, w, h, align: 'start' },
          { x: p.x - 6 - w, y: p.y - h / 2, w, h, align: 'end' },
        );
      }
    } else if (le.routing === 'back') {
      const lane = laneOf.get(le.edge)!;
      const verticalStart = le.points.findIndex((p) => p.x === lane.x);
      const a = le.points[verticalStart] ?? le.points[0]!;
      const b = le.points[verticalStart + 1] ?? a;
      for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const yy = a.y + (b.y - a.y) * t;
        candidates.push(
          lane.side === 1
            ? { x: lane.x + 6, y: yy - h / 2, w, h, align: 'start' }
            : { x: lane.x - 6 - w, y: yy - h / 2, w, h, align: 'end' },
        );
      }
    } else {
      const n = byId.get(le.edge.from)!;
      const x = n.cx + n.w / 2 + SELF_LOOP * 0.75 + 4;
      candidates.push(
        { x, y: n.y + n.h / 2 - h / 2, w, h, align: 'start' },
        { x: x - SELF_LOOP / 2, y: n.y - h - 4, w, h, align: 'start' },
        { x: x - SELF_LOOP / 2, y: n.y + n.h + 4, w, h, align: 'start' },
      );
    }
    let box =
      candidates.find((c) => !hitsNode(c) && !hitsLabel(c) && !hitsEdge(c, le)) ??
      candidates.find((c) => !hitsNode(c) && !hitsLabel(c));
    if (!box) {
      // Nothing free: nudge the first candidate down until it clears the other labels.
      const nudged = { ...candidates[0]! };
      for (let k = 0; k < 20 && hitsLabel(nudged); k++) nudged.y += 8;
      box = nudged;
    }
    placed.push(box);
    le.label = { ...box, lines: le.edge.label, ...(size.badge ? { badge: size.badge } : {}) };
  }

  // Bounding box → shift everything to a positive origin with a margin.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (b: Box) => {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  };
  for (const n of real) grow(nodeBox(n));
  for (const le of laid) {
    for (const p of le.points) grow({ x: p.x, y: p.y, w: 0, h: 0 });
    if (le.label) grow(le.label);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  const dx = MARGIN - minX;
  const dy = MARGIN - minY;
  const shiftPts = (p: Pt) => ({ x: p.x + dx, y: p.y + dy });
  const shiftD = (d: string) =>
    d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, a: string, b: string) =>
      pt({ x: Number(a) + dx, y: Number(b) + dy }),
    );

  return {
    width: Math.ceil(maxX - minX + 2 * MARGIN),
    height: Math.ceil(maxY - minY + 2 * MARGIN),
    nodes: real.map((n) => ({
      ...nodeBox(n),
      x: n.cx - n.w / 2 + dx,
      y: n.y + dy,
      node: n.graph!,
      rank: n.rank,
    })),
    edges: laid.map((le) => ({
      ...le,
      d: shiftD(le.d),
      arrow: shiftD(le.arrow),
      points: le.points.map(shiftPts),
      label: le.label ? { ...le.label, x: le.label.x + dx, y: le.label.y + dy } : null,
    })),
  };
}

export const TERMINAL_RADIUS = TERMINAL_R;
export const INITIAL_RADIUS = INITIAL_R;
export const LABEL_LINE_HEIGHT = LINE_H;
export const LABEL_BADGE_HEIGHT = BADGE_H;
