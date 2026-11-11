import type { EngineEvent } from '@conductor/shared';
import type {
  ApplyEventOptions,
  ApplyEventResult,
  EngineService,
  OutputBus,
} from '../contracts.js';

/**
 * ADR-0007: a message to the running agent, for POST /api/sessions/:id/messages and MCP's
 * message_agent (ADR-0031). `operator.message` → one send_message command; once the apply has
 * committed, the text is appended to the output ring as a `user` chunk (Claude does not echo
 * user messages, so this is how the board shows what the human said).
 */
export async function sendOperatorMessage(
  deps: { engine: EngineService; outputBus: OutputBus },
  sessionId: string,
  text: string,
): Promise<ApplyEventResult> {
  const result = await deps.engine.applyEvent(sessionId, { type: 'operator.message', text });
  if (result.status === 'applied') deps.outputBus.append(sessionId, 'user', text);
  return result;
}

/**
 * A human's answer to an open input request (POST /api/sessions/:id/input, MCP answer_input and
 * message_agent `as_answer`): `input.provided`, then, once the apply has committed, the answer as
 * a `user` chunk, as for a live message. Neither path to the agent (send_input or a resume with the
 * answer as its prompt) echoes it, so without this the answer never shows in the Messages thread.
 */
export async function provideAnswer(
  deps: { engine: EngineService; outputBus: OutputBus },
  sessionId: string,
  event: Extract<EngineEvent, { type: 'input.provided' }>,
  opts: ApplyEventOptions = {},
): Promise<ApplyEventResult> {
  const result = await deps.engine.applyEvent(sessionId, event, opts);
  if (result.status === 'applied' && event.answer.trim() !== '') {
    deps.outputBus.append(sessionId, 'user', event.answer);
  }
  return result;
}
