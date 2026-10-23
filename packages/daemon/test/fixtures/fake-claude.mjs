#!/usr/bin/env node
// Process-boundary fake `claude` (ADR-0005 §Fake Claude for E2E, items 1-5). Selected with
// CONDUCTOR_CLAUDE_BIN, so the daemon's real driver, stream parser and outcome server all run.
// Grown from spikes/claude-driver/fake-claude.mjs; fixes TD-001 (turn state and the cumulative
// cost are keyed by session id and persisted, so `--resume` continues the script and the spend).
//
// 1. Requires the ADR's mode flags (-p, stream-json in/out, --verbose) and reads
//    --session-id / --resume and --mcp-config (JSON string or file path).
// 2. Reads stream-json user messages from stdin. Per turn: system/init (session id,
//    claude_code_version), the scripted assistant/tool lines, then result with a CUMULATIVE
//    total_cost_usd.
// 3. complete_state / ask_user are real MCP tools/call requests to the --mcp-config URL.
// 4. Stays alive between turns; exits 0 when stdin closes.
// 5. Scenario-driven (below); `--resume` of an unknown id fails like the real CLI.
//
// Scenario: FAKE_CLAUDE_SCENARIO (JSON) or FAKE_CLAUDE_SCENARIO_FILE (path to JSON). Either an
// array of turns or { "turns": [...], "costPerTurnUsd": 0.001, "defaultTurn": [...] }.
// Per-session scenarios (M1-T10, for one daemon running several tickets): when neither of those
// is set and FAKE_CLAUDE_SCENARIO_DIR is, a new session picks <dir>/<name>.json from the marker
// `fake-scenario: <name>` in its first user message (the rendered ticket body), else
// <dir>/default.json, else the built-in default. The choice is kept in the session state, so a
// `--resume` continues the same scenario. `defaultTurn` (optional) is played for every turn past
// the end of `turns`. A turn is an array of actions:
//   {"say": text}                       assistant text
//   {"ask_user": question}              MCP tools/call ask_user
//   {"complete_state": object}          MCP tools/call complete_state; "$answer" in any string
//                                       is replaced by the text of the user message of this turn
//   {"tool": name, "args": object}      any other MCP tools/call on the conductor server
//   {"cost": usd}                       extra cost added to this turn
//   {"denials": n}                      n entries in result.permission_denials
//   {"stderr": text}                    write to stderr
//   {"raw": line}                       write a raw stdout line (parser leniency tests)
//   {"sleep": ms}                       wait
//   {"ignore_sigterm": true}            from now on SIGTERM is ignored (kill-escalation tests)
//   {"hang": true}                      never finish this turn
//   {"exit": code}                      exit now with that code, no result line
//   {"crash": signal}                   kill itself with that signal (e.g. "SIGKILL")
//   {"error": subtype}                  end the turn with result is_error=true and that subtype
//   {"write_file": {path, content}}     write a file relative to cwd (parents created; must stay
//                                       inside cwd), like an agent's edit (M1-T10 fixtures)
// Turns past the end of the script answer "No more scripted turns." and succeed.
//
// Other env:
//   FAKE_CLAUDE_STATE_DIR   where per-session state lives (default: <tmpdir>/conductor-fake-claude)
//   FAKE_CLAUDE_ARGV_LOG    append one JSON line {argv, cwd, env} per process start
//   FAKE_CLAUDE_VERSION     claude_code_version reported in init and by `--version`
//                           (default "0.0.0-fake")
//
// `fake-claude --version` prints "<version> (Claude Code)" and exits 0, like the real CLI (the
// daemon reports it in `register`, U-015).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const fail = (msg, code = 1) => {
  process.stderr.write(`fake-claude: ${msg}\n`);
  process.exit(code);
};
const version = process.env.FAKE_CLAUDE_VERSION ?? '0.0.0-fake';

if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
  process.stdout.write(`${version} (Claude Code)\n`);
  process.exit(0);
}

if (process.env.FAKE_CLAUDE_ARGV_LOG) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) =>
      /^(PORT|CONDUCTOR_|GIT_|FAKE_TEST_|ENABLE_CLAUDEAI_)/.test(k),
    ),
  );
  appendFileSync(
    process.env.FAKE_CLAUDE_ARGV_LOG,
    JSON.stringify({ argv, cwd: process.cwd(), env }) + '\n',
  );
}

// 1. flags
if (!argv.includes('-p')) fail('expected -p', 2);
if (flag('--input-format') !== 'stream-json') fail('expected --input-format stream-json', 2);
if (flag('--output-format') !== 'stream-json') fail('expected --output-format stream-json', 2);
if (!argv.includes('--verbose')) fail('stream-json output requires --verbose', 2);
const resumeId = flag('--resume');
const newId = flag('--session-id');
if ((resumeId === undefined) === (newId === undefined))
  fail('expected exactly one of --session-id / --resume', 2);
const sessionId = resumeId ?? newId;
// Like the real CLI, --mcp-config is a JSON string or a path to a JSON file (the driver passes a
// 0600 file since M1-T14, so the URL token stays out of argv).
let mcpConfig = { mcpServers: {} };
try {
  const raw = flag('--mcp-config');
  if (raw !== undefined) {
    mcpConfig = JSON.parse(raw.trimStart().startsWith('{') ? raw : readFileSync(raw, 'utf8'));
  }
} catch {
  fail('invalid --mcp-config (not JSON, nor a readable JSON file)', 2);
}

// 5. scenario + per-session state
const BUILTIN_SCENARIO = [
  [{ say: 'I need a decision first.' }, { ask_user: 'Which greeting word should I use?' }],
  [{ complete_state: { greeting: '$answer' } }],
];
const scenarioDir = process.env.FAKE_CLAUDE_SCENARIO_DIR;
const normalize = (s) => (Array.isArray(s) ? { turns: s } : s);

/** The env-wide scenario, or null when it is chosen per session (FAKE_CLAUDE_SCENARIO_DIR). */
function loadGlobalScenario() {
  let raw = process.env.FAKE_CLAUDE_SCENARIO;
  if (raw === undefined && process.env.FAKE_CLAUDE_SCENARIO_FILE) {
    raw = readFileSync(process.env.FAKE_CLAUDE_SCENARIO_FILE, 'utf8');
  }
  if (raw !== undefined) return normalize(JSON.parse(raw));
  return scenarioDir ? null : normalize(BUILTIN_SCENARIO);
}

/** FAKE_CLAUDE_SCENARIO_DIR: the scenario named in the first message (or default.json). */
function scenarioNameFor(firstMessage) {
  return /fake-scenario:\s*([A-Za-z0-9_-]+)/.exec(firstMessage)?.[1] ?? 'default';
}
function loadNamedScenario(name) {
  const path = join(scenarioDir, `${name}.json`);
  if (existsSync(path)) return normalize(JSON.parse(readFileSync(path, 'utf8')));
  if (name === 'default') return normalize(BUILTIN_SCENARIO);
  fail(`no scenario ${path}`);
}

let scenario = loadGlobalScenario();

const stateDir = process.env.FAKE_CLAUDE_STATE_DIR ?? join(tmpdir(), 'conductor-fake-claude');
mkdirSync(stateDir, { recursive: true });
const statePath = join(stateDir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
let state;
if (resumeId !== undefined) {
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    fail(`No conversation found with session ID: ${resumeId}`);
  }
} else {
  state = { turn: 0, totalCostUsd: 0 };
}
const saveState = () => writeFileSync(statePath, JSON.stringify(state));
saveState();
if (scenario === null && state.scenario !== undefined) scenario = loadNamedScenario(state.scenario);

// 2./3. protocol
const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sessionId }) + '\n');
let mcp;
async function callTool(name, args) {
  if (!mcp) {
    const url = mcpConfig.mcpServers?.conductor?.url;
    if (!url) throw new Error('fake-claude: no conductor MCP server in --mcp-config');
    mcp = new Client({ name: 'fake-claude', version });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(url)));
  }
  const id = `toolu_fake_${randomUUID().slice(0, 8)}`;
  out({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: `mcp__conductor__${name}`, input: args }],
    },
    parent_tool_use_id: null,
  });
  const r = await mcp.callTool({ name, arguments: args });
  out({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, content: r.content, is_error: r.isError === true },
      ],
    },
    parent_tool_use_id: null,
  });
}

const subst = (v, answer) =>
  typeof v === 'string'
    ? v.replaceAll('$answer', answer)
    : Array.isArray(v)
      ? v.map((x) => subst(x, answer))
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x, answer)]))
        : v;

const userText = (msg) => {
  const c = msg.message?.content;
  if (typeof c === 'string') return c;
  return (Array.isArray(c) ? c : [])
    .map((b) => (typeof b?.text === 'string' ? b.text : ''))
    .join('');
};

function writeFile(spec, answer) {
  const target = resolve(process.cwd(), String(spec.path));
  const rel = relative(process.cwd(), target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
    fail(`write_file outside cwd: ${spec.path}`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, subst(String(spec.content ?? ''), answer));
}

async function runTurn(text) {
  if (scenario === null) {
    state.scenario = scenarioNameFor(text);
    scenario = loadNamedScenario(state.scenario);
  }
  const turnIndex = state.turn;
  state.turn += 1;
  saveState(); // a crash mid-turn resumes at the next turn, like a real transcript
  out({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    tools: [],
    mcp_servers: [{ name: 'conductor', status: 'connected' }],
    model: flag('--model') ?? 'fake',
    permissionMode: flag('--permission-mode') ?? 'default',
    claude_code_version: version,
  });
  const actions = scenario.turns[turnIndex] ??
    scenario.defaultTurn ?? [{ say: 'No more scripted turns.' }];
  let turnCost = scenario.costPerTurnUsd ?? 0.001;
  let denials = 0;
  let errorSubtype;
  for (const a of actions) {
    if (a.say !== undefined) {
      out({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: a.say }] },
        parent_tool_use_id: null,
      });
    }
    if (a.stderr !== undefined) process.stderr.write(a.stderr);
    if (a.write_file !== undefined) writeFile(a.write_file, text);
    if (a.raw !== undefined) process.stdout.write(a.raw + '\n');
    if (a.sleep !== undefined) await new Promise((r) => setTimeout(r, a.sleep));
    if (a.ignore_sigterm) process.on('SIGTERM', () => {});
    if (a.ask_user !== undefined) await callTool('ask_user', { question: subst(a.ask_user, text) });
    if (a.complete_state !== undefined)
      await callTool('complete_state', { result: subst(a.complete_state, text) });
    if (a.tool !== undefined) await callTool(a.tool, subst(a.args ?? {}, text));
    if (a.cost !== undefined) turnCost += a.cost;
    if (a.denials !== undefined) denials += a.denials;
    if (a.error !== undefined) errorSubtype = a.error;
    if (a.hang) await new Promise(() => setInterval(() => {}, 60_000)); // keeps the loop alive
    if (a.exit !== undefined) process.exit(a.exit);
    if (a.crash !== undefined) process.kill(process.pid, a.crash);
  }
  state.totalCostUsd = Math.round((state.totalCostUsd + turnCost) * 1e9) / 1e9;
  saveState();
  out({
    type: 'result',
    subtype: errorSubtype ?? 'success',
    is_error: errorSubtype !== undefined,
    num_turns: 1,
    result: '',
    total_cost_usd: state.totalCostUsd,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    },
    permission_denials: Array.from({ length: denials }, (_, i) => ({
      tool_name: 'Bash',
      tool_use_id: `deny_${i}`,
      tool_input: {},
    })),
  });
}

// 4. turns run one at a time; a message written mid-turn is queued (as the real CLI does)
let busy = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    fail('invalid stream-json input line');
  }
  if (msg.type !== 'user') return; // control messages are ignored by the fake
  busy = busy
    .then(() => runTurn(userText(msg)))
    .catch((err) => fail(`turn failed: ${err?.message ?? err}`));
});
process.stdin.on('end', async () => {
  await busy;
  await mcp?.close();
  process.exit(0);
});
