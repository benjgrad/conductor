import { z } from 'zod';

// ADR-0011: the input of the agent's `complete_state` MCP tool, shared by the daemon's outcome
// server (`registerTool(..., {inputSchema: COMPLETE_STATE_INPUT_SHAPE})`) and the fake claude.
// The caps live here, at the tool call, so the agent gets a correctable error; the WS
// `session_event complete_state` itself is uncapped (a dropped event would lose the outcome).

/** Longest transition name accepted from the agent. */
export const TRANSITION_NAME_MAX = 100;
/** Longest `reason` accepted from the agent (it may become the human's question). */
export const TRANSITION_REASON_MAX = 4_000;

/** The raw zod shape, as MCP `registerTool` takes it. */
export const COMPLETE_STATE_INPUT_SHAPE = {
  transition: z
    .string()
    .min(1)
    .max(TRANSITION_NAME_MAX)
    .optional()
    .describe('The name of the transition you take (one of the names listed in your prompt)'),
  reason: z
    .string()
    .max(TRANSITION_REASON_MAX)
    .optional()
    .describe('Why you take it; for a question transition, the question for the human'),
  result: z.record(z.string(), z.unknown()).describe('Structured outcome of this state'),
};

/** `complete_state {transition?, reason?, result}`. Absent `transition` = `done` (old prompts). */
export const CompleteStateInputSchema = z.object(COMPLETE_STATE_INPUT_SHAPE);
export type CompleteStateInput = z.infer<typeof CompleteStateInputSchema>;
