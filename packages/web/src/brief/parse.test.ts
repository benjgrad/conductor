import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expandIds, parseBrief, tally, verificationFor } from './parse.js';
import { UX2_TICKET_BODY } from './ux2-ticket.js';

describe('parseBrief: UX-2 ticket body', () => {
  const brief = parseBrief(UX2_TICKET_BODY);

  it('reads every known section, with no warnings', () => {
    expect(brief.warnings).toEqual([]);
    expect(brief.goal).toMatch(/^Anyone opening a session sees/);
    expect(brief.context).toMatch(/^- Design review 2026-10-27/);
    expect(brief.outOfScope).toMatch(/Per-requirement verification STATUS/);
    expect(brief.other.map((s) => s.heading)).toEqual(['Gates']);
  });

  it('5 FR and 5 NFR, ids stripped from the text', () => {
    expect(brief.functional.map((r) => r.id)).toEqual(['FR-1', 'FR-2', 'FR-3', 'FR-4', 'FR-5']);
    expect(brief.nonFunctional.map((r) => r.id)).toEqual([
      'NFR-1',
      'NFR-2',
      'NFR-3',
      'NFR-4',
      'NFR-5',
    ]);
    expect(brief.functional[0]!.text).toMatch(/^A pure parser /);
    expect(brief.nonFunctional[0]!.text).toMatch(/^\*\*Web-only\.\*\*/);
  });

  // The ticket's own table says "7-row"; the body actually has 6 rows.
  it('a 6-row verification table, each row matched to a requirement', () => {
    expect(brief.verification.map((v) => v.req)).toEqual([
      'FR-1',
      'FR-2',
      'FR-3',
      'FR-4',
      'FR-5',
      'NFR-5',
    ]);
    expect(verificationFor(brief, 'FR-3')).toEqual([
      'A test: the tally counts and the warning colour when a requirement lacks verification',
    ]);
    expect(tally(brief)).toEqual({
      fr: 5,
      nfr: 5,
      total: 10,
      verified: 6,
      missing: ['NFR-1', 'NFR-2', 'NFR-3', 'NFR-4'],
    });
  });
});

describe('parseBrief', () => {
  it('a legacy body is all `other`, with one warning', () => {
    const b = parseBrief('Rename the field to `full_name` everywhere.');
    expect(b.other).toEqual([
      { heading: '', markdown: 'Rename the field to `full_name` everywhere.' },
    ]);
    expect(b.functional).toEqual([]);
    expect(b.warnings).toEqual(['No recognised sections: showing the ticket as written']);
  });

  it('legacy headings that are not ours stay as sections', () => {
    const b = parseBrief('Intro\n\n## Steps\n1. a\n2. b');
    expect(b.other.map((s) => s.heading)).toEqual(['', 'Steps']);
    expect(b.warnings).toHaveLength(1);
  });

  it('an empty body says so', () => {
    expect(parseBrief('  \n').warnings).toEqual(['The ticket has no description']);
  });

  it('matches headings case-insensitively, with a trailing colon', () => {
    const b = parseBrief(
      [
        '## goal',
        'Do it',
        '## FUNCTIONAL REQUIREMENTS:',
        '- FR-1: one',
        '## Non-Functional Requirements',
        '- **NFR-1** two',
        '## OUT OF SCOPE',
        'none',
        '## context',
        'c',
        '## Verification',
        '- FR-1: a test',
        '- NFR-1 — a benchmark',
      ].join('\n'),
    );
    expect(b.goal).toBe('Do it');
    expect(b.functional).toEqual([{ id: 'FR-1', text: 'one' }]);
    expect(b.nonFunctional).toEqual([{ id: 'NFR-1', text: 'two' }]);
    expect(b.verification).toEqual([
      { req: 'FR-1', how: 'a test' },
      { req: 'NFR-1', how: 'a benchmark' },
    ]);
    expect(b.warnings).toEqual([]);
  });

  it('warns for each missing section', () => {
    const b = parseBrief('## Goal\nx\n## Functional requirements\n- FR-1 a');
    expect(b.warnings).toEqual([
      'No Context section',
      'No Non-functional requirements section',
      'No Out of scope section',
      'No Verification section',
    ]);
    expect(tally(b).missing).toEqual(['FR-1']);
  });

  it('expands ranges and lists in verification rows', () => {
    const b = parseBrief(
      [
        '## Functional requirements',
        '- FR-1 a',
        '- FR-2 b',
        '- FR-3 c',
        '## Non-functional requirements',
        '- NFR-1 d',
        '## Verification',
        '- FR-1..3: e2e',
        '- FR-2, NFR-1: unit',
      ].join('\n'),
    );
    expect(b.verification).toEqual([
      { req: 'FR-1', how: 'e2e' },
      { req: 'FR-2', how: 'e2e' },
      { req: 'FR-3', how: 'e2e' },
      { req: 'FR-2', how: 'unit' },
      { req: 'NFR-1', how: 'unit' },
    ]);
    expect(verificationFor(b, 'FR-2')).toEqual(['e2e', 'unit']);
    expect(tally(b)).toMatchObject({ verified: 4, missing: [] });
  });

  it('expandIds handles the usual forms', () => {
    expect(expandIds('FR-1..FR-3')).toEqual(['FR-1', 'FR-2', 'FR-3']);
    expect(expandIds('NFR-2–4')).toEqual(['NFR-2', 'NFR-3', 'NFR-4']);
    expect(expandIds('fr-1 and nfr-2')).toEqual(['FR-1', 'NFR-2']);
    expect(expandIds('**FR-5**')).toEqual(['FR-5']);
  });

  it('warns about an id-less bullet, a wrong prefix, a duplicate and an unmatched row', () => {
    const b = parseBrief(
      [
        '## Functional requirements',
        '- FR-1 a',
        '- something without an id',
        '- FR-1 again',
        '## Non-functional requirements',
        '- FR-9 wrong prefix',
        '## Verification',
        '| Req | How |',
        '|---|---|',
        '| FR-1 | a test |',
        '| FR-7 | nothing to match |',
      ].join('\n'),
    );
    expect(b.functional.map((r) => r.id)).toEqual(['FR-1', 'FR-?2', 'FR-1']);
    expect(b.nonFunctional.map((r) => r.id)).toEqual(['NFR-?1']);
    expect(b.warnings).toEqual(
      expect.arrayContaining([
        'Functional requirement 2 has no FR-n id',
        'Non-functional requirement 1 has no NFR-n id',
        'FR-1 appears twice',
        'Verification row FR-7 matches no requirement',
      ]),
    );
  });

  it('joins continuation lines and nested bullets into the item', () => {
    const b = parseBrief(
      '## Functional requirements\n- FR-1 first line\n  second line\n  - nested',
    );
    expect(b.functional).toEqual([{ id: 'FR-1', text: 'first line second line - nested' }]);
  });

  it('a heading inside a code fence is not a section', () => {
    const b = parseBrief('## Goal\nSee:\n```\n## Verification\n```\n');
    expect(b.goal).toBe('See:\n```\n## Verification\n```');
    expect(b.warnings).toContain('No Verification section');
  });

  it('keeps an escaped pipe in a table cell, and CRLF bodies parse', () => {
    const b = parseBrief(
      '## Functional requirements\r\n- FR-1 a\r\n## Verification\r\n| Req | How |\r\n|:--|--|\r\n| FR-1 | `a \\| b` |\r\n',
    );
    expect(b.verification).toEqual([{ req: 'FR-1', how: '`a | b`' }]);
  });

  it('a second copy of a known section goes to `other`', () => {
    const b = parseBrief('## Goal\none\n## Goal\ntwo');
    expect(b.goal).toBe('one');
    expect(b.other).toEqual([{ heading: 'Goal', markdown: 'two' }]);
    expect(b.warnings).toContain('A second Goal section is shown as written');
  });
});

describe('NFR-5', () => {
  it('parse.ts has no imports (no React, no DOM), so it can move to @conductor/shared', () => {
    const src = readFileSync(new URL('./parse.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^\s*import\s|require\(|\bdocument\b|\bwindow\b/m);
  });
});
