import type {
  JsonObject,
  SessionSnapshot,
  WorkflowDefinition,
  WorkflowState,
} from '@conductor/shared';

// Prompt render (M1-T04b; 05 §Execution › Prompt render). apply() is pure and copies the agent
// state's `prompt` (a template name or inline template) or `skill` into the start_session
// effect, possibly followed by attached text (e.g. `attach: output`). The EngineService wrapper
// renders that head into the text Claude receives, just before it builds the outbox payload.
// A resume prompt that is the pending human answer is never rendered (it is the user's text).

/** Named prompt templates an agent state's `prompt` can reference (M1: one). */
export const PROMPT_TEMPLATES: Readonly<Record<string, string>> = {
  ticket_template: [
    'You are working on ticket {{ticket.ref}}: {{ticket.title}}',
    '',
    'Repository: {{ticket.repo}}',
    'Workflow state: {{state}}',
    '',
    '{{ticket.body}}',
    '',
    'Make the change on the current branch and commit it. When you are finished, call the ' +
      'complete_state tool with your result. If you are blocked on a decision only a human can ' +
      'make, call ask_user with one clear question.',
  ].join('\n'),
};

export interface PromptVars {
  ticket: SessionSnapshot['ticket'];
  state: string;
  /** The state's `input`, with `$state.key` refs resolved against `snapshot.context`. */
  input: Record<string, string>;
}

const PLACEHOLDER = /\{\{\s*([a-z_]+(?:\.[A-Za-z0-9_]+)?)\s*\}\}/g;

/** Substitute `{{ticket.title}}`-style placeholders. Unknown placeholders are left verbatim. */
export function renderTemplate(template: string, vars: PromptVars): string {
  return template.replace(PLACEHOLDER, (whole, path: string) => {
    const [head, key] = path.split('.') as [string, string | undefined];
    if (head === 'state' && key === undefined) return vars.state;
    if (head === 'ticket' && key !== undefined) {
      if (key === 'ref') return vars.ticket.external_ref ?? vars.ticket.id;
      const v = (vars.ticket as Record<string, unknown>)[key];
      if (typeof v === 'string') return v;
      return whole;
    }
    if (head === 'input' && key !== undefined && key in vars.input) return vars.input[key]!;
    return whole;
  });
}

/** Resolve an agent state's `input` map: literals as strings, `$state.key` from context. */
export function resolveInputs(
  state: WorkflowState,
  context: Record<string, JsonObject>,
): Record<string, string> {
  if (state.type !== 'agent' || state.input === undefined) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(state.input)) {
    if (typeof v === 'string' && v.startsWith('$')) {
      const [from, key] = v.slice(1).split('.', 2) as [string, string | undefined];
      const value = key === undefined ? undefined : context[from]?.[key];
      out[k] =
        value === undefined || value === null
          ? ''
          : typeof value === 'string'
            ? value
            : JSON.stringify(value);
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

function inputBlock(input: Record<string, string>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  return '\n\nInputs:\n' + keys.map((k) => `- ${k}: ${input[k]}`).join('\n');
}

/**
 * Render a start_session effect's prompt. `snapshot` is the session AFTER apply.
 * - The pending human answer (resume) passes through untouched.
 * - Agent state with `prompt`: when the effect prompt starts with it, that head is replaced by
 *   the named template (PROMPT_TEMPLATES) or, if no template has that name, by the prompt itself
 *   treated as an inline template. The rest (attached output) is kept.
 * - Agent state with `skill`: when the effect prompt starts with the skill name, the head becomes
 *   an instruction to run that skill for the ticket, plus the resolved inputs.
 * - Anything else (apply already rendered it, unknown state) passes through.
 */
export function renderStartPrompt(
  def: WorkflowDefinition,
  snapshot: SessionSnapshot,
  effect: { state: string; prompt: string },
): string {
  if (snapshot.pending_answer !== null && effect.prompt === snapshot.pending_answer.answer) {
    return effect.prompt;
  }
  const state = def.states[effect.state];
  if (state?.type !== 'agent') return effect.prompt;
  const vars: PromptVars = {
    ticket: snapshot.ticket,
    state: effect.state,
    input: resolveInputs(state, snapshot.context),
  };
  if (state.prompt !== undefined && effect.prompt.startsWith(state.prompt)) {
    const rest = effect.prompt.slice(state.prompt.length);
    const template = PROMPT_TEMPLATES[state.prompt] ?? state.prompt;
    return renderTemplate(template, vars) + inputBlock(vars.input) + rest;
  }
  if (state.skill !== undefined && effect.prompt.startsWith(state.skill)) {
    const rest = effect.prompt.slice(state.skill.length);
    const head = renderTemplate(
      `Use the ${state.skill} skill for ticket {{ticket.ref}}: {{ticket.title}} ` +
        '(repository {{ticket.repo}}). When it is done, call complete_state with your result.',
      vars,
    );
    return head + inputBlock(vars.input) + rest;
  }
  return effect.prompt;
}
