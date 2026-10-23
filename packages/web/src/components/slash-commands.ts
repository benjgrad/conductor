// Slash commands in the Messages composer. Conductor commands are handled by the UI; Claude Code
// commands are sent to the agent as a plain message, which Claude Code runs natively (ADR-0007).

export type SlashKind = 'conductor' | 'claude';
export type ConductorCommand = 'cancel' | 'retry' | 'details' | 'help';

export interface SlashCommand {
  name: string;
  description: string;
  kind: SlashKind;
}

export const CONDUCTOR_COMMANDS: readonly (SlashCommand & { name: ConductorCommand })[] = [
  { name: 'cancel', description: 'Cancel this session (asks first)', kind: 'conductor' },
  {
    name: 'retry',
    description: 'Retry the failed step (same as the Retry button)',
    kind: 'conductor',
  },
  {
    name: 'details',
    description: 'Show the agent, machine, workflow and context',
    kind: 'conductor',
  },
  { name: 'help', description: 'List the commands you can use here', kind: 'conductor' },
];

export const CLAUDE_COMMANDS: readonly SlashCommand[] = [
  { name: 'context', description: 'Show how full the context window is', kind: 'claude' },
  { name: 'compact', description: 'Summarise the conversation to free up context', kind: 'claude' },
];

export interface SlashAvailability {
  /** The agent has a live process to message. */
  canMessage: boolean;
  /** The session can still be cancelled. */
  canCancel: boolean;
  /** An open non-agent input request (retries exhausted, timeout, …). */
  canRetry: boolean;
}

export function availableCommands(a: SlashAvailability): SlashCommand[] {
  return [
    ...CONDUCTOR_COMMANDS.filter(
      (c) => (c.name !== 'cancel' || a.canCancel) && (c.name !== 'retry' || a.canRetry),
    ),
    ...(a.canMessage ? CLAUDE_COMMANDS : []),
  ];
}

/** The partial command name while the text is just `/word` (the menu is open), else null. */
export function slashQuery(text: string): string | null {
  const m = /^\/(\S*)$/.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

/** Prefix matches first, then names that merely contain the query. */
export function filterCommands(cmds: readonly SlashCommand[], query: string): SlashCommand[] {
  const prefix = cmds.filter((c) => c.name.startsWith(query));
  const inner = cmds.filter((c) => !c.name.startsWith(query) && c.name.includes(query));
  return [...prefix, ...inner];
}

/** `/name rest…` → {name, rest}; anything else → null. */
export function parseSlash(text: string): { name: string; rest: string } | null {
  const m = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1]!.toLowerCase(), rest: (m[2] ?? '').trim() } : null;
}

export function isConductorCommand(name: string): name is ConductorCommand {
  return CONDUCTOR_COMMANDS.some((c) => c.name === name);
}
