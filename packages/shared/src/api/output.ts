import { z } from 'zod';
import { IsoDateTimeSchema, OutputStreamSchema, UuidSchema } from '../domain.js';

// Output stream chunk (03 §SSE). Separate from sse.ts so rest.ts and sse.ts don't import each
// other. Re-exported from sse.ts.

/** One chunk of terminal output, as kept in the orchestrator ring buffer and streamed. */
export const OutputChunkSchema = z.object({
  session_id: UuidSchema,
  /** Monotonic per session within the orchestrator process (resets on restart). */
  seq: z.number().int().nonnegative(),
  stream: OutputStreamSchema,
  text: z.string(),
  ts: IsoDateTimeSchema,
  /**
   * How a person's `user` chunk reached conductor, when not the board: `mcp`, a conductor MCP
   * tool (message_agent, answer_input, reopen_ticket). Absent otherwise, and on transcript
   * history, which can't tell.
   */
  via: z.enum(['mcp']).optional(),
});
export type OutputChunk = z.infer<typeof OutputChunkSchema>;
/** `OutputChunk.via`. */
export type ChunkVia = NonNullable<OutputChunk['via']>;
