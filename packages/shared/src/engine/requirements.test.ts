import { describe, expect, it } from 'vitest';
import {
  parseRequirementList,
  proposalDiff,
  proposedOfResult,
  recordVerdict,
  REQUIREMENT_TEXT_MAX,
  REQUIREMENTS_CONTEXT_KEY,
  REQUIREMENTS_MAX,
  requirementsOfContext,
  requirementsProgress,
  sameList,
  setRequirements,
  withRequirements,
} from './requirements.js';

// ADR-0045: the pure checklist helpers.

const AGENT = { set_by: 'agent', set_in: 'planning' } as const;

describe('parseRequirementList', () => {
  it('trims, collapses whitespace, drops blanks and normalised duplicates in order', () => {
    expect(parseRequirementList(['  a  b ', '', 'C', 'A B', 'c'])).toEqual(['a b', 'C']);
  });

  it('is null for a non-array, a non-string entry, nothing left, too many or too long', () => {
    expect(parseRequirementList('a')).toBeNull();
    expect(parseRequirementList(['a', 1])).toBeNull();
    expect(parseRequirementList([' '])).toBeNull();
    expect(parseRequirementList([])).toBeNull();
    const many = Array.from({ length: REQUIREMENTS_MAX + 1 }, (_, i) => `r${i}`);
    expect(parseRequirementList(many)).toBeNull();
    expect(parseRequirementList(many.slice(0, REQUIREMENTS_MAX))).toHaveLength(REQUIREMENTS_MAX);
    expect(parseRequirementList(['x'.repeat(REQUIREMENT_TEXT_MAX + 1)])).toBeNull();
  });
});

describe('setRequirements / recordVerdict', () => {
  it('a first list is all pending at revision 1', () => {
    expect(setRequirements(null, ['a', 'b'], AGENT)).toEqual({
      items: [
        { text: 'a', status: 'pending', reason: null, checked_in: null },
        { text: 'b', status: 'pending', reason: null, checked_in: null },
      ],
      ...AGENT,
      revision: 1,
      proposed: null,
      ignored: null,
    });
  });

  it('a verdict ticks matching items; a new list keeps unchanged items and clears the proposal', () => {
    const first = setRequirements(null, ['a', 'b'], AGENT);
    const judged = recordVerdict(
      first,
      [
        { item: 'A', met: true, reason: 'done' },
        { item: 'b', met: false, reason: '' },
        { item: 'gate item', met: true, reason: 'x' },
      ],
      'step',
    );
    expect(judged.items).toEqual([
      { text: 'a', status: 'met', reason: 'done', checked_in: 'step' },
      { text: 'b', status: 'unmet', reason: null, checked_in: 'step' },
    ]);
    expect(requirementsProgress(judged)).toEqual({ met: 1, total: 2 });
    const next = setRequirements(
      { ...judged, proposed: { items: ['z'], from_state: 'i', revision_of: 1 } },
      ['a', 'c'],
      { set_by: 'human', set_in: 'ui' },
    );
    expect(next.items.map((i) => [i.text, i.status])).toEqual([
      ['a', 'met'],
      ['c', 'pending'],
    ]);
    expect(next).toMatchObject({ revision: 2, proposed: null, set_by: 'human' });
  });
});

describe('the rest', () => {
  it('sameList, proposalDiff, proposedOfResult', () => {
    expect(sameList(['A  b'], ['a b'])).toBe(true);
    expect(sameList(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(proposalDiff(['a', 'b'], ['B', 'c'])).toEqual({ added: ['c'], removed: ['a'] });
    expect(proposedOfResult({ proposed_requirements: ['x'], requirements: ['y'] })).toEqual(['x']);
    expect(proposedOfResult({ requirements: ['y'] })).toEqual(['y']);
    expect(proposedOfResult({ summary: 's' })).toBeNull();
  });

  it('round-trips through context; an older record without `ignored` parses', () => {
    const r = setRequirements(null, ['a'], AGENT);
    const ctx = withRequirements({}, r);
    expect(requirementsOfContext(ctx)).toEqual(r);
    const old: Partial<typeof r> = { ...r };
    delete old.ignored;
    expect(requirementsOfContext({ [REQUIREMENTS_CONTEXT_KEY]: old })?.ignored).toBeNull();
    expect(requirementsOfContext({ [REQUIREMENTS_CONTEXT_KEY]: { items: 'no' } })).toBeNull();
  });
});
