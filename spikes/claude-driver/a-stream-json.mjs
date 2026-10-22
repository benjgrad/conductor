// (a) Headless CLI with bidirectional stream-json.
// Shows: session_id from system/init (and that the daemon can pre-assign it
// with --session-id), streamed assistant output, cost/usage from `result`,
// and that the process stays alive after a turn until stdin closes.
import { randomUUID } from 'node:crypto';
import { spawnClaude, baseArgs, scratchRepo, summarize, logger } from './lib.mjs';

const log = logger('a-stream-json');
const cwd = scratchRepo('a');
const preassigned = randomUUID();
log('cwd', cwd);
log('pre-assigned --session-id', preassigned);

const cc = spawnClaude('a-stream-json', [...baseArgs({ maxTurns: 2 }), '--session-id', preassigned, '--tools', ''], { cwd });
cc.onMessage((m) => log('<-', summarize(m)));

// Does init arrive before we send anything? Wait up to 5 s to find out.
const initEarly = await cc.next((m) => m.type === 'system' && m.subtype === 'init', 5000).catch(() => null);
log('init before first user message?', initEarly ? 'YES' : 'NO (init is emitted only once input arrives)');

cc.send('Reply with exactly the word: pong');
const init = initEarly ?? await cc.next((m) => m.type === 'system' && m.subtype === 'init');
log('session_id from init =', init.session_id, '| matches pre-assigned:', init.session_id === preassigned);

const result = await cc.next((m) => m.type === 'result');
log('turn 1 result: cost_usd =', result.total_cost_usd, 'duration_ms =', result.duration_ms, 'usage =', JSON.stringify(result.usage));
log('modelUsage =', JSON.stringify(result.modelUsage));

// Process still alive after the result? (needed for live injection in (b)).
await new Promise((r) => setTimeout(r, 1500));
log('process alive after result (exitCode null)?', cc.child.exitCode === null);

cc.endInput();
const exit = await cc.exited;
log('exit after stdin closed:', JSON.stringify(exit));
await log.close();
