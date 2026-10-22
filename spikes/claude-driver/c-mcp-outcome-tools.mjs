// (c) Structured outcome tools from a daemon-owned MCP server (HTTP, in-process).
// Two ask_user styles are compared, both against the real CLI:
//   "return": ask_user returns at once ("end your turn"); the turn ends, the
//             process idles, and the daemon later writes the answer to stdin.
//             Same shape as the --resume fallback (answer = next user message).
//   "block":  ask_user's handler awaits the answer; the tool result IS the
//             answer. The process sits inside a pending tool call meanwhile.
// In both, complete_state reaches the daemon as a structured object.
import { spawnClaude, baseArgs, scratchRepo, summarize, logger } from './lib.mjs';
import { startOutcomeServer, TOOL_NAMES } from './outcome-server.mjs';

const ANSWER_DELAY_MS = Number(process.env.ANSWER_DELAY_MS ?? 15_000);
const PROMPT = [
  'You are in a workflow state named "implement".',
  'Step 1: call the ask_user tool to ask which greeting word to use. Do not guess.',
  'Step 2: once you have the answer, call complete_state with result {"greeting": <the word>}.',
  'Do nothing else.',
].join(' ');

const outcome = await startOutcomeServer();

async function run(mode) {
  const name = `c-${mode}`;
  const log = logger(name);
  const cwd = scratchRepo(name);
  let pendingAnswer; // resolve fn for the "block" style
  const events = [];
  const emit = (e) => { events.push(e); log('DAEMON EVENT', JSON.stringify(e)); };

  const reg = outcome.register({
    async completeState(result) {
      emit({ kind: 'complete_state', result });
      return 'Recorded. Stop now: do not call any other tool and end your turn.';
    },
    async askUser(question) {
      emit({ kind: 'ask_user', question });
      if (mode === 'return') {
        return 'Your question was sent to a human. End your turn now without calling more tools. The answer will arrive as the next user message.';
      }
      log(`ask_user handler BLOCKING for ${ANSWER_DELAY_MS} ms (tool call stays open)`);
      const answer = await new Promise((r) => { pendingAnswer = r; });
      log('ask_user handler returning the answer as the tool result');
      return `The human answered: ${answer}`;
    },
  });

  const args = [...baseArgs({ maxTurns: 6 }), '--tools', '', '--mcp-config', reg.mcpConfig, '--allowedTools', TOOL_NAMES.join(',')];
  const cc = spawnClaude(name, args, { cwd });
  cc.onMessage((m) => log('<-', summarize(m)));
  cc.send(PROMPT);
  const init = await cc.next((m) => m.type === 'system' && m.subtype === 'init');
  log('mcp servers in init:', JSON.stringify(init.mcp_servers), 'tools:', init.tools.join(','));

  if (mode === 'return') {
    await cc.next((m) => m.type === 'result');
    const asked = events.find((e) => e.kind === 'ask_user');
    log('turn ended after ask_user?', !!asked, '| process idle & alive:', cc.child.exitCode === null);
    await new Promise((r) => setTimeout(r, ANSWER_DELAY_MS));
    log('-> daemon injects answer via stdin (send_input)');
    cc.send('Answer to your question: "howdy".', init.session_id);
  } else {
    while (!pendingAnswer) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, ANSWER_DELAY_MS));
    log('-> daemon resolves the pending ask_user call');
    pendingAnswer('howdy');
  }

  const final = await cc.next((m) => m.type === 'result');
  const done = events.find((e) => e.kind === 'complete_state');
  log('complete_state received:', JSON.stringify(done), '| final result subtype', final.subtype, 'cost', final.total_cost_usd);
  cc.endInput(); // daemon ends the session after complete_state
  log('exit:', JSON.stringify(await cc.exited));
  reg.unregister();
  await log.close();
}

const modes = process.argv.slice(2).length ? process.argv.slice(2) : ['return', 'block'];
for (const m of modes) await run(m);
await outcome.close();
