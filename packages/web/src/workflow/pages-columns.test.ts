import { CONDUCTOR_V4_DEF, validateWorkflow, type AgentState } from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { PAGES_DEFAULT_MAX, pagesOf, setPages } from './columns.js';
import { diffVersions } from './version-diff.js';

// ADR-0038: the builder's "Pages" toggle and max (ColumnEditor's PagesFields).

describe('setPages', () => {
  it('on adds the pages tool and result entry, max defaulting to 3; off removes both', () => {
    const def = CONDUCTOR_V4_DEF;
    expect(pagesOf(def, 'planning')).toBeNull();
    const on = setPages(def, 'planning', {});
    const planning = on.states.planning as AgentState;
    expect(planning.tools).toEqual(['read', 'pages']);
    expect(planning.result).toEqual(['plan', 'summary', { pages: { max: PAGES_DEFAULT_MAX } }]);
    expect(validateWorkflow(on).ok).toBe(true);

    const five = setPages(on, 'planning', { max: 5 });
    expect(pagesOf(five, 'planning')).toEqual({ max: 5 });
    expect((five.states.planning as AgentState).tools).toEqual(['read', 'pages']);

    const off = setPages(five, 'planning', null);
    expect(off.states.planning).toEqual(def.states.planning);
  });

  it('on a state without tools or result, off leaves neither key', () => {
    const def = structuredClone(CONDUCTOR_V4_DEF);
    const impl = def.states.implementing as AgentState;
    delete impl.result;
    const round = setPages(setPages(def, 'implementing', {}), 'implementing', null);
    expect(round.states.implementing).toEqual(impl);
  });

  it('the version diff names the change', () => {
    const on = setPages(CONDUCTOR_V4_DEF, 'planning', {});
    const lines = diffVersions(CONDUCTOR_V4_DEF, on).flatMap((c) =>
      'lines' in c ? (c.lines as string[]) : [],
    );
    expect(lines.join('\n')).toContain('Pages: off → up to 3');
  });
});
