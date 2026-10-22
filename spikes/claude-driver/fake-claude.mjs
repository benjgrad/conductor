#!/usr/bin/env node
// Fake `claude` honouring the ADR-0005 contract, for E2E (M1-T10).
// It speaks the same stream-json protocol subset the driver reads and calls
// the outcome tools through the SAME daemon-owned MCP endpoint it is handed
// in --mcp-config, so the daemon's real driver code path is exercised.
//
// Scenario: FAKE_CLAUDE_SCENARIO = JSON array, one entry per user turn, each a
// list of actions: {"say": text} | {"ask_user": question} |
// {"complete_state": object} ("$answer" values are replaced by the user text,
// or by its first "quoted" part) | {"exit": code} | {"cost": usd}.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const sessionId = flag('--resume') ?? flag('--session-id') ?? randomUUID();
const mcpConfig = flag('--mcp-config') ? JSON.parse(flag('--mcp-config')) : { mcpServers: {} };
const scenario = JSON.parse(process.env.FAKE_CLAUDE_SCENARIO ?? JSON.stringify([
  [{ say: 'I need a decision first.' }, { ask_user: 'Which greeting word should I use?' }],
  [{ complete_state: { greeting: '$answer' } }],
]));

const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sessionId }) + '\n');
let mcp;
async function callTool(name, args) {
  if (!mcp) {
    const url = mcpConfig.mcpServers?.conductor?.url;
    if (!url) throw new Error('fake-claude: no conductor MCP server in --mcp-config');
    mcp = new Client({ name: 'fake-claude', version: '0.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(url)));
  }
  const id = `toolu_fake_${randomUUID().slice(0, 8)}`;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: `mcp__conductor__${name}`, input: args }] }, parent_tool_use_id: null });
  const r = await mcp.callTool({ name, arguments: args });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: r.content }] }, parent_tool_use_id: null });
}

const subst = (v, answer) => typeof v === 'string' ? v.replace('$answer', answer)
  : Array.isArray(v) ? v.map((x) => subst(x, answer))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x, answer)])) : v;

let turn = 0; let totalCost = 0; let busy = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type !== 'user') return; // control messages ignored by the fake
  busy = busy.then(async () => {
    const text = (msg.message.content ?? []).map((c) => c.text ?? '').join('');
    const answer = /"([^"]+)"/.exec(text)?.[1] ?? text;
    out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: [], mcp_servers: [{ name: 'conductor', status: 'connected' }], model: 'fake', permissionMode: 'dontAsk' });
    const actions = scenario[turn++] ?? [{ say: 'No more scripted turns.' }];
    for (const a of actions) {
      if (a.say) out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: a.say }] }, parent_tool_use_id: null });
      if (a.ask_user) await callTool('ask_user', { question: a.ask_user });
      if (a.complete_state) await callTool('complete_state', { result: subst(a.complete_state, answer) });
      if (a.cost) totalCost += a.cost;
      if (a.exit !== undefined) process.exit(a.exit);
    }
    totalCost += 0.001;
    out({ type: 'result', subtype: 'success', is_error: false, num_turns: actions.length, result: '', total_cost_usd: totalCost, usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [] });
  });
});
process.stdin.on('end', async () => { await busy; await mcp?.close(); process.exit(0); });
