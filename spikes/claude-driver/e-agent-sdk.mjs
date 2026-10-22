// (e) The same mechanisms through the Claude Agent SDK.
//  - streaming input: prompt is an AsyncIterable the daemon pushes into
//  - custom tools in-process via createSdkMcpServer (no HTTP listener)
//  - live answer injection: push to the iterable after the turn ends
//  - resume: a second query() with options.resume
//  - cost: total_cost_usd / usage on the result message
// Set SDK_USE_INSTALLED_CLI=1 to run against the installed `claude` instead of
// the binary bundled in the SDK's platform package.
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { scratchRepo, summarize, logger, OUT, MODEL } from './lib.mjs';

const log = logger('e-agent-sdk');
const raw = createWriteStream(join(OUT, 'e-agent-sdk.ndjson'));
const cwd = scratchRepo('e');
const IDLE_MS = Number(process.env.IDLE_MS ?? 10_000);
const pathToClaudeCodeExecutable = process.env.SDK_USE_INSTALLED_CLI
  ? execFileSync('which', ['claude']).toString().trim()
  : undefined;
log('cli:', pathToClaudeCodeExecutable ?? '(bundled with SDK)');

/** Minimal push-able async queue: the daemon's stdin equivalent. */
function inputQueue() {
  const items = []; let wake; let closed = false;
  return {
    push(text) { items.push(text); wake?.(); },
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length) {
          const text = items.shift();
          yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } };
        }
        if (closed) return;
        await new Promise((r) => { wake = r; });
        wake = undefined;
      }
    },
  };
}

const events = [];
const emit = (e) => { events.push(e); log('DAEMON EVENT', JSON.stringify(e)); };
const conductor = createSdkMcpServer({
  name: 'conductor',
  version: '0.0.0',
  alwaysLoad: true,
  tools: [
    tool('complete_state', 'Call exactly once when the state\'s work is finished. After calling it, stop.',
      { result: z.record(z.string(), z.unknown()) },
      async ({ result }) => { emit({ kind: 'complete_state', result }); return { content: [{ type: 'text', text: 'Recorded. Stop now and end your turn.' }] }; }),
    tool('ask_user', 'Ask the human operator one clear question when you cannot proceed without a decision.',
      { question: z.string().min(1) },
      async ({ question }) => { emit({ kind: 'ask_user', question }); return { content: [{ type: 'text', text: 'Sent to a human. End your turn now; the answer will arrive as the next user message.' }] }; }),
  ],
});

const baseOptions = {
  cwd,
  model: MODEL,
  pathToClaudeCodeExecutable,
  settingSources: [],          // isolation: no user/project settings, hooks, plugins
  // Without this the logged-in user's claude.ai connectors (Gmail, Slack, ...)
  // are attached to the unattended agent: see out/e-agent-sdk-nonstrict.redacted.json.
  strictMcpConfig: process.env.SDK_NONSTRICT ? false : true,
  permissionPrompts: 'none',   // nobody approves anything at runtime
  skills: [],                  // no skills in the model's listing
  tools: [],                   // no built-in tools needed for this demo
  mcpServers: { conductor },
  allowedTools: ['mcp__conductor__complete_state', 'mcp__conductor__ask_user'],
  permissionMode: 'dontAsk',
  maxTurns: 6,
  maxBudgetUsd: 0.3,
  stderr: (d) => log('stderr', d.trim()),
};

// ---- live session ----
const input = inputQueue();
input.push('Workflow state "implement". Call ask_user to ask which greeting word to use (do not guess). When answered, call complete_state with result {"greeting": <word>}. Nothing else.');
const q = query({ prompt: input, options: baseOptions });
let sessionId; let results = 0;
for await (const m of q) {
  raw.write(JSON.stringify(m) + '\n');
  log('<-', summarize(m));
  if (m.type === 'system' && m.subtype === 'init') sessionId = m.session_id;
  if (m.type === 'result') {
    results++;
    log(`result #${results}: total_cost_usd=${m.total_cost_usd} session_id=${m.session_id}`);
    if (results === 1) {
      log(`idle ${IDLE_MS} ms, process alive; then push answer into the live input stream`);
      setTimeout(() => input.push('Answer to your question: "bonjour".'), IDLE_MS);
    } else if (events.some((e) => e.kind === 'complete_state')) {
      input.close(); // daemon ends the session after complete_state
    }
  }
}
log('live query finished; session', sessionId, 'events', JSON.stringify(events));

// ---- resume path ----
const r = query({ prompt: 'Resumed after a restart. Which greeting word was chosen? Reply with just the word.', options: { ...baseOptions, resume: sessionId, mcpServers: { conductor }, maxTurns: 2 } });
for await (const m of r) {
  raw.write(JSON.stringify(m) + '\n');
  log('resume <-', summarize(m));
}
raw.end();
await log.close();
