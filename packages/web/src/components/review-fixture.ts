// UX-4: an implementer report in the `.claude/agents/implementer.md` shape, as an agent's
// `personal_pr_ready_for_review` reason (the mock board and the tests use it).

export const REPORT_FIRST_LINE = 'Board cards now tell review requests from questions.';

/** 8 of 10 acceptance items met, gates green; `padTo` pads it to that many lines. */
export function implementerReport(padTo = 0): string {
  const lines = [
    'TASK: UX-4 Board cards: review requests vs questions, clamped previews',
    'BRANCH: conductor/119a1350/3242664f @ 6095b57',
    'STATUS: complete',
    '',
    REPORT_FIRST_LINE,
    'The session panel shows a Ready for review card with the full report collapsed.',
    'ACCEPTANCE:',
    ...Array.from({ length: 8 }, (_, i) => `- [x] criterion ${i + 1} — evidence: test ${i + 1}`),
    '- [-] criterion 9 — interface review (lead)',
    '- [ ] criterion 10 — Ben approves',
    'GATES: typecheck ✅  lint ✅  test ✅  build ✅',
    'DESIGN DOC CHANGES: none',
    'TECH DEBT: none',
  ];
  for (let i = lines.length; i < padTo; i++) lines.push(`NOTE ${i}: more detail on line ${i}.`);
  return lines.join('\n');
}
