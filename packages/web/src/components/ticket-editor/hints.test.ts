import { describe, expect, it } from 'vitest';
import ticket from './fixtures/ux-3-ticket.md?raw';
import { requirementHints } from './hints.js';
import { stripPlaceholders, TICKET_TEMPLATE } from './template.js';

describe('requirementHints (UX-3 FR-4)', () => {
  it('flags the untouched template: placeholders are not requirements', () => {
    expect(requirementHints(TICKET_TEMPLATE)).toEqual(['No functional requirements yet']);
  });

  it('names requirements the Verification section never mentions', () => {
    const md = `## Goal\nG\n## Context\nC\n## Functional requirements\n- FR-1 a\n- **FR-2** b\n## Non-functional requirements\n- NFR-1 c\n## Out of scope\n- x\n## Verification\n| Req | How |\n|---|---|\n| FR-1, NFR-1 | test |\n`;
    expect(requirementHints(md)).toEqual(['FR-2 has no verification']);
  });

  it('does not confuse NFR-n with FR-n', () => {
    const md = `## Functional requirements\n- FR-1 a\n## Verification\n- NFR-1 only\n`;
    expect(requirementHints(md)).toContain('FR-1 has no verification');
  });

  it('reports missing sections, ignoring headings inside code fences', () => {
    const md = '## Goal\nG\n```\n## Context\n```\n';
    const hints = requirementHints(md);
    expect(hints).toContain('Missing section: Context');
    expect(hints).toContain('Missing section: Verification');
    expect(hints).toContain('No functional requirements yet');
  });

  it("on this ticket's own body, lists the NFRs its Verification table skips", () => {
    expect(requirementHints(ticket)).toEqual([
      'NFR-1 has no verification',
      'NFR-2 has no verification',
      'NFR-3 has no verification',
      'NFR-4 has no verification',
      'NFR-5 has no verification',
    ]);
  });

  it('caps the list and stays fast on a 2,000-requirement body', () => {
    const frs = Array.from({ length: 2000 }, (_, i) => `- FR-${i + 1} r`).join('\n');
    const md = `## Functional requirements\n${frs}\n## Verification\n| FR-1 | t |\n`;
    const start = performance.now();
    const hints = requirementHints(md);
    expect(performance.now() - start).toBeLessThan(50);
    expect(hints).toContain('FR-2 has no verification');
    expect(hints).toContain('1994 more requirements have no verification');
  });
});

describe('stripPlaceholders', () => {
  it('turns an untouched template (in either bullet style) into an empty body', () => {
    expect(stripPlaceholders(TICKET_TEMPLATE)).toBe('');
    expect(stripPlaceholders(TICKET_TEMPLATE.replace(/^- /gm, '* '))).toBe('');
  });

  it('keeps what the user wrote and drops only the untouched lines', () => {
    const md = TICKET_TEMPLATE.replace('- FR-1 …', '- FR-1 Users can log in').replace(
      '| FR-1 | … |',
      '| FR-1 | e2e login test |',
    );
    const out = stripPlaceholders(md);
    expect(out).toContain('## Goal\n\n## Context');
    expect(out).toContain('- FR-1 Users can log in');
    expect(out).toContain('| FR-1 | e2e login test |');
    expect(out).not.toContain('NFR-1 …');
  });

  it('drops a table left with only its header', () => {
    const md = TICKET_TEMPLATE.replace('- FR-1 …', '- FR-1 Real');
    expect(stripPlaceholders(md)).not.toContain('| Req |');
  });
});
