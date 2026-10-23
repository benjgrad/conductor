// Lenient parser for the CLI's stream-json NDJSON (ADR-0005 §Parsing). The format is unversioned
// and the CLI auto-updates (U-015), so nothing here throws: a line that is not JSON, not an
// object, or of a type we don't use becomes `debug` output. Only system/init, assistant, user
// (tool results) and result drive DriverEvents.
import type { DriverEvent } from './driver.js';

export type ParsedLine =
  | { kind: 'init'; sessionId: string | undefined; cliVersion: string | undefined }
  | { kind: 'event'; event: DriverEvent };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const debug = (text: string): ParsedLine => ({
  kind: 'event',
  event: { kind: 'output', stream: 'debug', text },
});

function contentBlocks(m: Obj): Obj[] {
  const message = m.message;
  if (!isObj(message)) return [];
  const content = message.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.filter(isObj) : [];
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : JSON.stringify(c)))
      .join('\n');
  }
  return content === undefined ? '' : JSON.stringify(content);
}

/** Parse one stdout line into zero or more items. Never throws. */
export function parseStreamLine(line: string): ParsedLine[] {
  if (line.trim() === '') return [];
  let m: unknown;
  try {
    m = JSON.parse(line);
  } catch {
    return [debug(line)];
  }
  if (!isObj(m)) return [debug(line)];

  switch (m.type) {
    case 'system':
      if (m.subtype === 'init') {
        return [
          { kind: 'init', sessionId: str(m.session_id), cliVersion: str(m.claude_code_version) },
        ];
      }
      // A running estimate emitted many times per turn; in a real session it was two thirds of
      // the output ring and says nothing a reader needs.
      if (m.subtype === 'thinking_tokens') return [];
      return [debug(line)];

    case 'assistant': {
      const out: ParsedLine[] = [];
      for (const c of contentBlocks(m)) {
        if (c.type === 'text' && typeof c.text === 'string') {
          out.push({ kind: 'event', event: { kind: 'output', stream: 'assistant', text: c.text } });
        } else if (c.type === 'tool_use') {
          const name = str(c.name) ?? '?';
          out.push({
            kind: 'event',
            event: {
              kind: 'output',
              stream: 'tool_use',
              text: `${name} ${JSON.stringify(c.input ?? {})}`,
            },
          });
        }
        // thinking / redacted_thinking / other blocks are dropped (no user-facing text).
      }
      return out;
    }

    case 'user': {
      const out: ParsedLine[] = [];
      for (const c of contentBlocks(m)) {
        if (c.type === 'tool_result') {
          out.push({
            kind: 'event',
            event: { kind: 'output', stream: 'tool_result', text: toolResultText(c.content) },
          });
        }
      }
      return out;
    }

    case 'result': {
      const out: ParsedLine[] = [];
      const usage = isObj(m.usage) ? m.usage : {};
      if (typeof m.total_cost_usd === 'number' && Number.isFinite(m.total_cost_usd)) {
        // Cumulative per Claude session, across --resume (ADR-0005). Missing → no spend event.
        out.push({
          kind: 'event',
          event: {
            kind: 'spend',
            totalUsd: m.total_cost_usd,
            usage: {
              inputTokens: num(usage.input_tokens),
              outputTokens: num(usage.output_tokens),
              cacheReadTokens: num(usage.cache_read_input_tokens),
              cacheCreationTokens: num(usage.cache_creation_input_tokens),
            },
          },
        });
      }
      out.push({
        kind: 'event',
        event: {
          kind: 'turn_end',
          isError: m.is_error === true,
          subtype: str(m.subtype) ?? 'unknown',
          permissionDenials: Array.isArray(m.permission_denials) ? m.permission_denials.length : 0,
        },
      });
      return out;
    }

    default:
      // rate_limit_event, stream_event, tool_progress, system/* other than init, …
      return [debug(line)];
  }
}
