import { describe, expect, it } from 'vitest';
import { parseStreamLine } from './stream-parser.js';

// Shapes trimmed from the M1-T00 spike's real-CLI captures (Claude Code 2.1.308).
const INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: '8cba9531-634d-4224-a516-249e74696fa2',
  tools: [],
  claude_code_version: '2.1.308',
});
const RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: '8cba9531-634d-4224-a516-249e74696fa2',
  total_cost_usd: 0.0006282900000000001,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 3098,
    cache_read_input_tokens: 649,
    output_tokens: 4,
  },
  permission_denials: [{ tool_name: 'Bash' }, { tool_name: 'Write' }],
});

describe('parseStreamLine', () => {
  it('reads session id and CLI version from system/init', () => {
    expect(parseStreamLine(INIT)).toEqual([
      { kind: 'init', sessionId: '8cba9531-634d-4224-a516-249e74696fa2', cliVersion: '2.1.308' },
    ]);
  });

  it('maps result to spend (cumulative total, per-turn usage) then turn_end', () => {
    expect(parseStreamLine(RESULT)).toEqual([
      {
        kind: 'event',
        event: {
          kind: 'spend',
          totalUsd: 0.0006282900000000001,
          usage: {
            inputTokens: 2,
            outputTokens: 4,
            cacheReadTokens: 649,
            cacheCreationTokens: 3098,
          },
        },
      },
      {
        kind: 'event',
        event: { kind: 'turn_end', isError: false, subtype: 'success', permissionDenials: 2 },
      },
    ]);
  });

  it('result without a cost still ends the turn; error results are flagged', () => {
    expect(
      parseStreamLine(
        JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }),
      ),
    ).toEqual([
      {
        kind: 'event',
        event: {
          kind: 'turn_end',
          isError: true,
          subtype: 'error_max_turns',
          permissionDenials: 0,
        },
      },
    ]);
  });

  it('maps assistant text and tool_use blocks, drops thinking', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } },
        ],
      },
    });
    expect(parseStreamLine(line).map((p) => (p.kind === 'event' ? p.event : p))).toEqual([
      { kind: 'output', stream: 'assistant', text: 'hello' },
      { kind: 'output', stream: 'tool_use', text: 'Read {"file_path":"a"}' },
    ]);
  });

  it('maps user tool_result content (string or blocks)', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'plain' },
          {
            type: 'tool_result',
            tool_use_id: 't2',
            content: [
              { type: 'text', text: 'a' },
              { type: 'text', text: 'b' },
            ],
          },
        ],
      },
    });
    expect(parseStreamLine(line).map((p) => (p.kind === 'event' ? p.event : p))).toEqual([
      { kind: 'output', stream: 'tool_result', text: 'plain' },
      { kind: 'output', stream: 'tool_result', text: 'a\nb' },
    ]);
  });

  it('is lenient: garbage, non-objects and unknown types become debug output', () => {
    for (const line of [
      'not json {',
      '[1,2]',
      '42',
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} }),
      JSON.stringify({ type: 'system', subtype: 'permission_denied' }),
      JSON.stringify({ type: 'tool_progress' }),
    ]) {
      expect(parseStreamLine(line)).toEqual([
        { kind: 'event', event: { kind: 'output', stream: 'debug', text: line } },
      ]);
    }
    expect(parseStreamLine('')).toEqual([]);
    // malformed known types never throw
    expect(parseStreamLine(JSON.stringify({ type: 'assistant', message: null }))).toEqual([]);
    expect(parseStreamLine(JSON.stringify({ type: 'user' }))).toEqual([]);
    expect(parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toEqual([
      { kind: 'init', sessionId: undefined, cliVersion: undefined },
    ]);
  });

  it('drops system/thinking_tokens progress estimates', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'thinking_tokens',
      estimated_tokens: 150,
      estimated_tokens_delta: 100,
    });
    expect(parseStreamLine(line)).toEqual([]);
  });
});
