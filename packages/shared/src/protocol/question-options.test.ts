import { describe, expect, it } from 'vitest';
import {
  ASK_USER_OPTION_DESCRIPTION_MAX,
  ASK_USER_OPTION_LABEL_MAX,
  ASK_USER_OPTIONS_MAX,
  boundedQuestionOptions,
  questionOptionsAnswer,
} from './question-options.js';
import { SessionEventPayloadSchema } from './ws.js';

describe('boundedQuestionOptions (Questions UX)', () => {
  it('keeps a valid list: labels trimmed, blank descriptions left out', () => {
    expect(
      boundedQuestionOptions(
        [{ label: ' Postgres ', description: 'recommended' }, { label: 'SQLite', description: ' ' }],
        true,
      ),
    ).toEqual({
      multi_select: true,
      items: [{ label: 'Postgres', description: 'recommended' }, { label: 'SQLite' }],
    });
  });

  it('multi_select is true only when given as true', () => {
    const two = [{ label: 'a' }, { label: 'b' }];
    expect(boundedQuestionOptions(two, undefined)?.multi_select).toBe(false);
    expect(boundedQuestionOptions(two, 'yes')?.multi_select).toBe(false);
  });

  it.each([
    ['absent', undefined],
    ['not an array', { label: 'a' }],
    ['one option', [{ label: 'a' }]],
    ['too many', Array.from({ length: ASK_USER_OPTIONS_MAX + 1 }, (_, i) => ({ label: `o${i}` }))],
    ['a non-object', ['a', 'b']],
    ['a missing label', [{ label: 'a' }, { description: 'b' }]],
    ['a blank label', [{ label: 'a' }, { label: '  ' }]],
    ['a long label', [{ label: 'a' }, { label: 'x'.repeat(ASK_USER_OPTION_LABEL_MAX + 1) }]],
    [
      'a long description',
      [{ label: 'a' }, { label: 'b', description: 'x'.repeat(ASK_USER_OPTION_DESCRIPTION_MAX + 1) }],
    ],
    ['duplicate labels', [{ label: 'a' }, { label: ' a' }]],
  ])('drops %s', (_name, options) => {
    expect(boundedQuestionOptions(options, false)).toBeUndefined();
  });

  it('the answer is the label, or the labels joined', () => {
    expect(questionOptionsAnswer(['Postgres'])).toBe('Postgres');
    expect(questionOptionsAnswer(['a', 'b'])).toBe('a, b');
  });

  it('the ask_user session_event carries them, and parses without them', () => {
    const options = { multi_select: false, items: [{ label: 'a' }, { label: 'b' }] };
    expect(
      SessionEventPayloadSchema.parse({ kind: 'ask_user', data: { question: 'q', options } }),
    ).toEqual({ kind: 'ask_user', data: { question: 'q', options } });
    expect(SessionEventPayloadSchema.parse({ kind: 'ask_user', data: { question: 'q' } })).toEqual({
      kind: 'ask_user',
      data: { question: 'q' },
    });
  });
});
