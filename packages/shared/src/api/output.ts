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
});
export type OutputChunk = z.infer<typeof OutputChunkSchema>;
