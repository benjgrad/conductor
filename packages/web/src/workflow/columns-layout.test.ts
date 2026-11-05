import {
  CONDUCTOR_V2_DRAFT_DEF,
  CONDUCTOR_V3_DEF,
  CONDUCTOR_V4_DEF,
  type WorkflowDefinition,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { CONDUCTOR, CONDUCTOR_V1 } from '../api/mock-data.js';
import { boxesOverlap, layoutLanes, segIntersectsBox, type LanesLayout } from './columns-layout.js';

// UXR-45: the columns diagram's geometry. Pure layout, no DOM.

const cases: [string, WorkflowDefinition][] = [
  ['conductor v1', CONDUCTOR_V1],
  ['conductor v2 (mock, entry review)', CONDUCTOR],
  ['conductor v2 draft (transition rules)', CONDUCTOR_V2_DRAFT_DEF],
  ['conductor v3', CONDUCTOR_V3_DEF],
  ['conductor v4', CONDUCTOR_V4_DEF],
];

const segments = (layout: LanesLayout, except: string) =>
  layout.edges
    .filter((e) => e.edge.id !== except)
    .flatMap((e) => e.points.slice(1).map((p, i) => ({ id: e.edge.id, a: e.points[i]!, b: p })));

describe('layoutLanes', () => {
  for (const [name, def] of cases) {
    describe(name, () => {
      const layout = layoutLanes(def);

      it('fits a 1440 px window', () => {
        expect(layout.width).toBeLessThanOrEqual(1400);
      });

      it('keeps every lane, line and label inside the canvas', () => {
        for (const l of layout.lanes) {
          expect(l.x + l.w).toBeLessThanOrEqual(layout.width);
          expect(l.y + l.h).toBeLessThanOrEqual(layout.height);
        }
        for (const e of layout.edges) {
          for (const p of e.points) {
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(layout.width);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeLessThanOrEqual(layout.height);
          }
          expect(e.label.x, e.edge.id).toBeGreaterThanOrEqual(0);
          expect(e.label.x + e.label.w, e.edge.id).toBeLessThanOrEqual(layout.width);
        }
      });

      it('crosses no label with another edge’s line', () => {
        for (const e of layout.edges) {
          for (const s of segments(layout, e.edge.id)) {
            expect(segIntersectsBox(s.a, s.b, e.label), `${s.id} crosses ${e.edge.id}`).toBe(false);
          }
        }
      });

      it('overlaps no label with a lane or another label', () => {
        layout.edges.forEach((e, i) => {
          for (const l of layout.lanes) {
            expect(boxesOverlap(e.label, l), `${e.edge.id} on ${l.lane.id}`).toBe(false);
          }
          for (const o of layout.edges.slice(i + 1)) {
            expect(boxesOverlap(e.label, o.label), `${e.edge.id} × ${o.edge.id}`).toBe(false);
          }
        });
      });
    });
  }

  it('lays out left to right without overlapping lanes', () => {
    const layout = layoutLanes(CONDUCTOR);
    layout.lanes.slice(1).forEach((l, i) => {
      const prev = layout.lanes[i]!;
      expect(l.x).toBeGreaterThan(prev.x + prev.w);
    });
    // The unmet loop runs below the lanes, the planning → needs_input skip above.
    const side = (id: string) => layout.edges.find((e) => e.edge.id === id)?.side;
    expect(side('waiting_external/entry/unmet')).toBe('below');
    expect(side('planning/needs_input')).toBe('above');
    expect(side('planning/implementing')).toBe('across');
  });

  it('labels v4’s arrows with transition titles', () => {
    const layout = layoutLanes(CONDUCTOR_V4_DEF);
    expect(layout.edges.map((e) => [e.edge.id, e.side, e.label.text, e.label.badge ?? '']))
      .toMatchInlineSnapshot(`
      [
        [
          "start",
          "across",
          "Claimed",
          "",
        ],
        [
          "planning/implementing",
          "across",
          "Plan ready",
          "",
        ],
        [
          "planning/needs_input",
          "above",
          "6 ways",
          "",
        ],
        [
          "implementing/needs_input",
          "across",
          "5 ways",
          "✓",
        ],
        [
          "implementing/waiting_external",
          "above",
          "Ready for testing",
          "✓",
        ],
        [
          "needs_input/waiting_external",
          "across",
          "Waiting on someone else",
          "",
        ],
        [
          "needs_input/done",
          "above",
          "Done",
          "",
        ],
        [
          "waiting_external/done",
          "across",
          "Approved",
          "",
        ],
        [
          "waiting_external/implementing",
          "below",
          "Back to Implementing",
          "",
        ],
      ]
    `);
  });

  it('wraps a long label across a gap instead of widening it', () => {
    const def = structuredClone(CONDUCTOR_V4_DEF);
    const p = def.states.planning;
    if (p?.type !== 'agent' || typeof p.on?.plan_ready !== 'object') throw new Error('fixture');
    p.on.plan_ready.title = 'The plan is ready to be implemented now';
    const layout = layoutLanes(def);
    const e = layout.edges.find((x) => x.edge.id === 'planning/implementing')!;
    expect(e.label.lines.length).toBeGreaterThan(1);
    const [planning, implementing] = [layout.lanes[1]!, layout.lanes[2]!];
    expect(implementing.x - (planning.x + planning.w)).toBeLessThanOrEqual(96);
    expect(e.label.x).toBeGreaterThanOrEqual(planning.x + planning.w);
    expect(e.label.x + e.label.w).toBeLessThanOrEqual(implementing.x);
  });

  it('gives each lane its kind icon on the title line', () => {
    const layout = layoutLanes(CONDUCTOR_V4_DEF);
    expect(layout.lanes.map((l) => [l.lane.kind, l.lines[0]?.icon])).toEqual([
      ['queue', '≡'],
      ['agent', '✦'],
      ['agent', '✦'],
      ['person', '●'],
      ['waiting', '◷'],
      ['end', '■'],
    ]);
  });
});
