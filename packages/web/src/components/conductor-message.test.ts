import { describe, expect, it } from 'vitest';
import { classifyUserText, conductorLabel, taskTone } from './conductor-message.js';

// As Claude Code writes them into the transcript (seen in real conductor sessions).
const done =
  '<task-notification>\n<task-id>b1x2</task-id>\n<tool-use-id>toolu_01A</tool-use-id>\n' +
  '<output-file>/tmp/claude-1000/wt/tasks/b1x2.output</output-file>\n<status>completed</status>\n' +
  '<summary>Background command "Run the tests" completed (exit code 0)</summary>\n</task-notification>';
const failed =
  '<task-notification>\n<task-id>b3y4</task-id>\n<status>failed</status>\n' +
  '<summary>Background command "Lint" failed with exit code 1</summary>\n</task-notification>';

const later = { first: false };

describe('classifyUserText', () => {
  it('reads a background job notification', () => {
    expect(classifyUserText(done, later)).toEqual({
      notices: [
        {
          kind: 'task',
          status: 'completed',
          summary: 'Background command "Run the tests" completed (exit code 0)',
          outputFile: '/tmp/claude-1000/wt/tasks/b1x2.output',
          taskId: 'b1x2',
        },
      ],
      rest: '',
    });
  });

  it('unwraps a system-reminder around a notification', () => {
    const m = classifyUserText(`<system-reminder>\n${failed}\n</system-reminder>`, later);
    expect(m?.notices).toEqual([
      expect.objectContaining({ kind: 'task', status: 'failed', outputFile: null, taskId: 'b3y4' }),
    ]);
  });

  it('keeps the text after the blocks, and reads several blocks', () => {
    const m = classifyUserText(`${done}\n${failed}\nRead the output file to see it.`, later);
    expect(m?.notices.map((n) => n.kind)).toEqual(['task', 'task']);
    expect(m?.rest).toBe('Read the output file to see it.');
  });

  it("falls back to the notification's text when it has no summary", () => {
    const m = classifyUserText(
      '<task-notification><task-id>x</task-id> gone </task-notification>',
      later,
    );
    expect(m?.notices[0]).toMatchObject({ kind: 'task', summary: 'x gone', status: '' });
  });

  it('decodes the escaped text Claude Code writes (`&&` as `&amp;&amp;`)', () => {
    const m = classifyUserText(
      '<task-notification><status>completed</status><summary>Background command "a &amp;&amp; b &gt; out" completed</summary></task-notification>',
      later,
    );
    expect(m?.notices[0]).toMatchObject({ summary: 'Background command "a && b > out" completed' });
  });

  it('a reminder of plain text is a note', () => {
    expect(classifyUserText('<system-reminder>\nBe brief.\n</system-reminder>', later)).toEqual({
      notices: [{ kind: 'note', tag: 'system-reminder', text: 'Be brief.' }],
      rest: '',
    });
  });

  it("conductor's nudge", () => {
    const nudge =
      'You must finish by calling complete_state with your result, or ask_user if you need a human';
    expect(classifyUserText(nudge, later)).toEqual({ notices: [{ kind: 'nudge' }], rest: '' });
  });

  it('a later step prompt, but never the first message (the Ticket)', () => {
    const prompt = '# Ticket: Add /health\n\nBody\n\n## Your step: implementing\n\nMake it.';
    expect(classifyUserText(prompt, later)?.notices).toEqual([
      { kind: 'step-prompt', step: 'implementing', text: prompt },
    ]);
    expect(classifyUserText(prompt, { first: true })).toBeNull();
  });

  it.each([
    'use Postgres',
    '<b>bold</b> please',
    `see this: ${done}`,
    '<task-notification> never closed',
    '<custom>x</custom>',
  ])('%j is the human', (text) => {
    expect(classifyUserText(text, later)).toBeNull();
  });
});

describe('conductorLabel', () => {
  it('names what the bubble holds', () => {
    const of = (t: string) => conductorLabel(classifyUserText(t, later)!);
    expect(of(done)).toBe('Conductor · background job');
    expect(of(`${done}${failed}`)).toBe('Conductor · background jobs');
    expect(of('You must finish by calling complete_state')).toBe('Conductor · reminder');
    expect(of('# Ticket: x')).toBe('Conductor · step prompt');
    expect(of('<system-reminder>hi</system-reminder>')).toBe('Conductor · note');
  });
});

describe('taskTone', () => {
  it.each([
    ['completed', 'ok'],
    ['failed', 'failed'],
    ['killed', 'stopped'],
    ['stopped', 'stopped'],
    ['', 'other'],
  ])('%s → %s', (status, tone) => {
    expect(taskTone(status)).toBe(tone);
  });
});
