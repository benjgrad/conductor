import { readFileSync } from 'node:fs';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { M1_BASIC } from '../api/mock-data.js';
import { layoutGraph, type Box, type DiagramLayout } from './layout.js';
import { buildGraph, INITIAL_ID } from './model.js';

const doc = (file: string): WorkflowDefinition =>
  WorkflowDefinitionSchema.parse(
    JSON.parse(
      readFileSync(new URL(`../../../../docs/design/workflows/${file}`, import.meta.url), 'utf8'),
    ),
  );

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const inside = (p: { x: number; y: number }, b: Box) =>
  p.x > b.x + 1 && p.x < b.x + b.w - 1 && p.y > b.y + 1 && p.y < b.y + b.h - 1;

function expectNoOverlaps(layout: DiagramLayout) {
  const { nodes } = layout;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      expect(overlap(nodes[i]!, nodes[j]!), `${nodes[i]!.node.id} × ${nodes[j]!.node.id}`).toBe(
        false,
      );
    }
  }
}

/** Every outcome, object-transition else and gate on_unmet becomes an edge. */
function expectEveryTransition(def: WorkflowDefinition, layout: DiagramLayout) {
  const ids = new Set(layout.edges.map((e) => e.edge.id));
  expect(ids.has('initial')).toBe(true);
  for (const [from, state] of Object.entries(def.states)) {
    if (state.type === 'terminal') continue;
    for (const [outcome, t] of Object.entries(state.on ?? {})) {
      expect(ids.has(`${from}/${outcome}/outcome`), `${from} ${outcome}`).toBe(true);
      if (typeof t === 'string') continue;
      if (t.else !== undefined) expect(ids.has(`${from}/${outcome}/else`)).toBe(true);
      if (t.requirements) expect(ids.has(`${from}/${outcome}/unmet`)).toBe(true);
    }
  }
}

describe('layoutGraph', () => {
  const cases = [
    ['m1_basic (docs)', doc('m1_basic.v1.json')],
    ['m1_basic v2 (gated)', M1_BASIC],
    ['pr_flow (docs)', doc('pr_flow.v1.json')],
  ] as const;

  for (const [name, def] of cases) {
    describe(name, () => {
      const layout = layoutGraph(buildGraph(def));

      it('places every state, with no two nodes overlapping', () => {
        expect(layout.nodes.map((n) => n.node.id).sort()).toEqual(
          [INITIAL_ID, ...Object.keys(def.states)].sort(),
        );
        expectNoOverlaps(layout);
      });

      it('draws an edge for every transition', () => expectEveryTransition(def, layout));

      it('keeps everything inside the canvas', () => {
        for (const n of layout.nodes) {
          expect(n.x).toBeGreaterThanOrEqual(0);
          expect(n.y).toBeGreaterThanOrEqual(0);
          expect(n.x + n.w).toBeLessThanOrEqual(layout.width);
          expect(n.y + n.h).toBeLessThanOrEqual(layout.height);
        }
        for (const e of layout.edges) {
          for (const p of e.points) {
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(layout.width);
          }
        }
      });

      it('routes back edges around nodes, never through them', () => {
        const back = layout.edges.filter((e) => e.routing === 'back');
        expect(back.length).toBeGreaterThan(0);
        for (const e of back) {
          // Orthogonal route: check points along every segment.
          for (let i = 1; i < e.points.length; i++) {
            const a = e.points[i - 1]!;
            const b = e.points[i]!;
            for (let k = 0; k <= 20; k++) {
              const p = { x: a.x + ((b.x - a.x) * k) / 20, y: a.y + ((b.y - a.y) * k) / 20 };
              for (const n of layout.nodes) {
                expect(inside(p, n), `${e.edge.id} crosses ${n.node.id}`).toBe(false);
              }
            }
          }
        }
      });

      it('ranks the start state below the initial pseudostate', () => {
        const rank = (id: string) => layout.nodes.find((n) => n.node.id === id)!.rank;
        expect(rank(def.start)).toBeGreaterThan(rank(INITIAL_ID));
        for (const n of layout.nodes) {
          if (n.node.kind === 'terminal') {
            expect(n.rank).toBe(Math.max(...layout.nodes.map((m) => m.rank)));
          }
        }
      });

      it('labels outcome edges and keeps labels off the nodes', () => {
        for (const e of layout.edges) {
          if (e.edge.kind === 'initial') continue;
          expect(e.label?.lines[0], e.edge.id).toBeTruthy();
          for (const n of layout.nodes) {
            expect(overlap(e.label!, n), `${e.edge.id} label on ${n.node.id}`).toBe(false);
          }
        }
      });
    });
  }

  it('marks the gated transition with a badge and draws its on_unmet loop', () => {
    const layout = layoutGraph(buildGraph(M1_BASIC));
    const gated = layout.edges.find((e) => e.edge.id === 'implement/done/outcome')!;
    expect(gated.edge.gate).toBe(2);
    expect(gated.label?.badge).toBe('✓ 2 requirements');
    const unmet = layout.edges.find((e) => e.edge.id === 'implement/done/unmet')!;
    expect(unmet).toMatchObject({ routing: 'self', edge: { dashed: true, to: 'implement' } });
    expect(unmet.label?.lines).toEqual(['unmet ×2']);
    // No other edge has a badge.
    expect(layout.edges.filter((e) => e.label?.badge)).toHaveLength(1);
  });

  it('labels failure policies and draws the else edge dashed', () => {
    const layout = layoutGraph(buildGraph(doc('m1_basic.v1.json')));
    const fail = layout.edges.find((e) => e.edge.id === 'build/fail/outcome')!;
    expect(fail.label?.lines).toEqual(['fail', '⟲ implement ×3, else needs_input']);
    expect(fail.routing).toBe('back');
    const els = layout.edges.find((e) => e.edge.id === 'build/fail/else')!;
    expect(els.edge).toMatchObject({ dashed: true, to: 'needs_input' });
  });

  it('skips edges to states that do not exist (a broken draft still renders)', () => {
    const def = structuredClone(M1_BASIC);
    const build = def.states.build!;
    if (build.type !== 'command') throw new Error('fixture');
    build.on = { ...build.on, exit_0: 'nowhere' };
    const layout = layoutGraph(buildGraph(def));
    expect(layout.edges.some((e) => e.edge.id === 'build/exit_0/outcome')).toBe(false);
    expectNoOverlaps(layout);
  });
});
