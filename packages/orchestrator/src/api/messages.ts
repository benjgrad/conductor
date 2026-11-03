import type { ApplyEventResult, EngineService, OutputBus } from '../contracts.js';

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
