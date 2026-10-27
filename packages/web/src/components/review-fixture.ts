// UX-4: an implementer report in the `.claude/agents/implementer.md` shape, as an agent's
// `personal_pr_ready_for_review` reason (the mock board and the tests use it). Real reports go
// straight from the TASK/BRANCH/STATUS header into ACCEPTANCE; prose, if any, comes last.

export const REPORT_PROSE_LINE = 'Can you review the PR, mainly how the board cards look?';

/**
 * 8 of 10 of the agent's acceptance items met, one lead-owned `[-]` item, gates green. `padTo`
 * pads it to that many lines (with `NOTES:` fields before the closing prose).
 */
export function implementerReport(padTo = 0): string {
  const head = [
    'TASK: UX-4 Board cards: review requests vs questions, clamped previews',
    'BRANCH: conductor/119a1350/3242664f @ 6095b57',
    'STATUS: complete',
    'ACCEPTANCE:',
    ...Array.from({ length: 8 }, (_, i) => `- [x] criterion ${i + 1} — evidence: test ${i + 1}`),
    '- [ ] criterion 9 — evidence: none yet',
    '- [ ] criterion 10 — evidence: none yet',
    '- [-] an interface-review agent confirms the DTO (lead)',
    'GATES: typecheck ✅  lint ✅  test ✅  build ✅',
    'DESIGN DOC CHANGES: none',
    'TECH DEBT: none',
  ];
  const tail = ['', REPORT_PROSE_LINE];
  for (let i = head.length + tail.length; i < padTo; i++) {
    head.push(`NOTES: more detail on line ${i}.`);
  }
  return [...head, ...tail].join('\n');
}
