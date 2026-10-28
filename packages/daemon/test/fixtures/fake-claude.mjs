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
//                                       is replaced by the text of the user message of this turn.
//                                       ADR-0011: optional siblings "transition" and "reason"
//                                       are passed to the tool as given ("$answer" substituted),
//                                       e.g. {"complete_state": {}, "transition": "plan_ready",
//                                       "reason": "The plan is complete."}
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
//   {"await_message": true}             wait for a user message written mid-turn and fold it into
//                                       this turn, as the real CLI does (ADR-0007 spike): it runs
//                                       no turn of its own. "$message" in any later string is
//                                       replaced by its text. A message that arrives when no
//                                       await_message is waiting (e.g. before the turn reached it)
//                                       is queued as the next turn.
//   {"if_exists": {path, then, else}}   play the `then` actions if <cwd>/<path> exists, else the
//                                       `else` actions (ADR-0009 reviewer scenarios)
//   {"remove_file": path}               delete a file relative to cwd (must stay inside cwd)
//   {"git_commit": message}             `git add -A && git commit -m <message>` in cwd, like an
//                                       agent committing its work (ADR-0010: only committed
//                                       changes are checked); nothing to commit is a no-op
// A requirements reviewer's first message starts with "# Requirements review"; with
// FAKE_CLAUDE_SCENARIO_DIR it plays `<name>_review.json` for the ticket's `fake-scenario: <name>`.
// Turns past the end of the script answer "No more scripted turns." and succeed.
//
// Other env:
//   FAKE_CLAUDE_STATE_DIR   where per-session state lives (default: <tmpdir>/conductor-fake-claude)
//   FAKE_CLAUDE_ARGV_LOG    append one JSON line {argv, cwd, env} per process start
//   FAKE_CLAUDE_VERSION     claude_code_version reported in init and by `--version`
//                           (default "0.0.0-fake")
//   FAKE_CLAUDE_OLD_HELP    "1": `--help` lists no auto mode / --permission-prompts (ADR-0023
//                           fallback); otherwise `--help` lists both
//   CLAUDE_CONFIG_DIR       when set, write a transcript like the real CLI (ADR-0008):
//                           <dir>/projects/<realpath(cwd), non-alphanumerics → '-'>/<id>.jsonl,
//                           appending on --resume. Lines: each turn's user prompt, a
//                           queue-operation and a thinking-only assistant line (to be skipped),
//                           then every assistant / tool_result line written to stdout.
//
// `fake-claude --version` prints "<version> (Claude Code)" and exits 0, like the real CLI (the
// daemon reports it in `register`, U-015).
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
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

// ADR-0023: the daemon probes `claude --help` once for auto mode and `--permission-prompts`.
// FAKE_CLAUDE_OLD_HELP=1 answers like a CLI that has neither.
if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
  const old = process.env.FAKE_CLAUDE_OLD_HELP === '1';
  process.stdout.write(
    [
      'Usage: claude [options] [command] [prompt]',
      old
        ? '  --permission-mode <mode>  (choices: "acceptEdits", "bypassPermissions", "default", "dontAsk", "plan")'
        : '  --permission-mode <mode>  (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")',
      ...(old
        ? []
        : ['  --permission-prompts <target>  (choices: "host", "none", default: "host")']),
      '',
    ].join('\n'),
  );
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

/**
 * FAKE_CLAUDE_SCENARIO_DIR: the scenario named in the first message (or default.json). A
 * requirements reviewer (ADR-0009: its prompt starts with "# Requirements review" and carries the
 * ticket body) plays `<name>_review` instead.
 */
function scenarioNameFor(firstMessage) {
  const name = /fake-scenario:\s*([A-Za-z0-9_-]+)/.exec(firstMessage)?.[1] ?? 'default';
  return firstMessage.startsWith('# Requirements review') ? `${name}_review` : name;
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

// ADR-0008: the transcript the real CLI keeps under its config dir.
const transcriptFile = process.env.CLAUDE_CONFIG_DIR
  ? join(
      process.env.CLAUDE_CONFIG_DIR,
      'projects',
      realpathSync(process.cwd()).replace(/[^A-Za-z0-9]/g, '-'),
      `${sessionId}.jsonl`,
    )
  : null;
function transcript(line) {
  if (transcriptFile === null) return;
  mkdirSync(dirname(transcriptFile), { recursive: true });
  appendFileSync(
    transcriptFile,
    JSON.stringify({
      ...line,
      isSidechain: false,
      sessionId,
      cwd: process.cwd(),
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    }) + '\n',
  );
}

// 2./3. protocol
const out = (o) => {
  if (o.type === 'assistant' || o.type === 'user') transcript({ type: o.type, message: o.message });
  process.stdout.write(JSON.stringify({ ...o, session_id: sessionId }) + '\n');
};
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

/** ADR-0007: the last user message folded into a turn by `await_message`. */
let lastMessage = '';
/** Resolves the pending `await_message` with the next user message, if one is waiting. */
let messageWaiter = null;

const subst = (v, answer) =>
  typeof v === 'string'
    ? v.replaceAll('$answer', answer).replaceAll('$message', lastMessage)
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

function removeFile(path) {
  const target = resolve(process.cwd(), path);
  const rel = relative(process.cwd(), target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
    fail(`remove_file outside cwd: ${path}`);
  rmSync(target, { force: true });
}

function gitCommit(message) {
  const git = (...args) => execFileSync('git', args, { cwd: process.cwd(), stdio: 'pipe' });
  git('add', '-A');
  if (git('status', '--porcelain').toString().trim() === '') return;
  git('commit', '--quiet', '--no-verify', '-m', message);
}

async function runTurn(text) {
  if (scenario === null) {
    state.scenario = scenarioNameFor(text);
    scenario = loadNamedScenario(state.scenario);
  }
  transcript({ type: 'queue-operation', operation: 'enqueue', content: text });
  transcript({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  transcript({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Planning the turn.' }] },
  });
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
  // `if_exists` splices its `then` or `else` actions in place (a reviewer inspecting the worktree).
  const queue = [...actions];
  while (queue.length > 0) {
    const a = queue.shift();
    if (a.if_exists !== undefined) {
      const c = a.if_exists;
      const hit = existsSync(resolve(process.cwd(), String(c.path)));
      queue.unshift(...((hit ? c.then : c.else) ?? []));
      continue;
    }
    if (a.say !== undefined) {
      out({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: a.say.replaceAll('$message', lastMessage) }],
        },
        parent_tool_use_id: null,
      });
    }
    if (a.stderr !== undefined) process.stderr.write(a.stderr);
    if (a.write_file !== undefined) writeFile(a.write_file, text);
    if (a.remove_file !== undefined) removeFile(String(a.remove_file));
    if (a.git_commit !== undefined) gitCommit(subst(String(a.git_commit), text));
    if (a.raw !== undefined) process.stdout.write(a.raw + '\n');
    if (a.sleep !== undefined) await new Promise((r) => setTimeout(r, a.sleep));
    if (a.ignore_sigterm) process.on('SIGTERM', () => {});
    if (a.await_message) lastMessage = await new Promise((r) => (messageWaiter = r));
    if (a.ask_user !== undefined) await callTool('ask_user', { question: subst(a.ask_user, text) });
    if (a.complete_state !== undefined)
      await callTool('complete_state', {
        result: subst(a.complete_state, text),
        ...(a.transition !== undefined ? { transition: subst(a.transition, text) } : {}),
        ...(a.reason !== undefined ? { reason: subst(a.reason, text) } : {}),
      });
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
  if (messageWaiter !== null) {
    // Folded into the running turn (ADR-0007), not queued as a turn of its own.
    const w = messageWaiter;
    messageWaiter = null;
    w(userText(msg));
    return;
  }
  busy = busy
    .then(() => runTurn(userText(msg)))
    .catch((err) => fail(`turn failed: ${err?.message ?? err}`));
});
process.stdin.on('end', async () => {
  await busy;
  await mcp?.close();
  process.exit(0);
});
