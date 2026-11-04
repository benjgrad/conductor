import { z } from 'zod';

// Questions UX (06 §Agent question options): the choices an agent may attach to `ask_user`, shown
// on the board as clickable buttons. Additive everywhere: an old daemon never sends them, an old
// orchestrator strips them (zod objects drop unknown keys), and the human can always type an answer.

/** Fewer than this is not a choice: the options are dropped. */
export const ASK_USER_OPTIONS_MIN = 2;
/** More than this does not fit as buttons: the options are dropped. */
export const ASK_USER_OPTIONS_MAX = 6;
/** Cap on one option's label (the button text, and the answer the agent gets back). */
export const ASK_USER_OPTION_LABEL_MAX = 80;
/** Cap on one option's description (muted text under the label). */
export const ASK_USER_OPTION_DESCRIPTION_MAX = 300;

export const QuestionOptionSchema = z.object({
  label: z.string().min(1).max(ASK_USER_OPTION_LABEL_MAX),
  description: z.string().max(ASK_USER_OPTION_DESCRIPTION_MAX).optional(),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

/**
 * The options of an agent question. `multi_select`: the human may pick several (the answer is the
 * labels joined with ", "); otherwise one click answers.
 */
export const QuestionOptionsSchema = z.object({
  multi_select: z.boolean(),
  items: z
    .array(QuestionOptionSchema)
    .min(ASK_USER_OPTIONS_MIN)
    .max(ASK_USER_OPTIONS_MAX)
    .refine((items) => new Set(items.map((i) => i.label)).size === items.length, {
      message: 'option labels must be unique',
    }),
});
export type QuestionOptions = z.infer<typeof QuestionOptionsSchema>;

/**
 * What the `ask_user` tool received as `options` / `multi_select`, bounded: the options when
 * they are valid (labels trimmed, empty descriptions left out), else undefined. Never throws: a
 * bad option list is dropped and the question is still sent (like `boundedSuggestions`).
 */
export function boundedQuestionOptions(
  options: unknown,
  multiSelect: unknown,
): QuestionOptions | undefined {
  if (!Array.isArray(options)) return undefined;
  const items: QuestionOption[] = [];
  for (const o of options as unknown[]) {
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return undefined;
    const rec = o as Record<string, unknown>;
    if (typeof rec.label !== 'string') return undefined;
    const label = rec.label.trim();
    const description =
      typeof rec.description === 'string' && rec.description.trim() !== ''
        ? rec.description.trim()
        : undefined;
    items.push({ label, ...(description !== undefined ? { description } : {}) });
  }
  const parsed = QuestionOptionsSchema.safeParse({ multi_select: multiSelect === true, items });
  return parsed.success ? parsed.data : undefined;
}

/** The answer text for chosen labels: the label, or the labels joined with ", ". */
export function questionOptionsAnswer(labels: readonly string[]): string {
  return labels.join(', ');
}
