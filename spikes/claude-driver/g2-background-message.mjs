// (g2) Follow-up to g: a message while the process idles with a background job running, a
// background command outside the allow-list, and stdin closing while a job still runs.
import { spawnClaude, baseArgs, scratchRepo, summarize, logger } from './lib.mjs';

const log = logger('g2-background-message');
const cwd = scratchRepo('g2');
const cc = spawnClaude(
  'g2-background-message',
  [
    ...baseArgs({ maxTurns: 8 }),
    '--permission-mode', 'dontAsk',
    '--tools', 'Bash,Read,TaskStop',
    '--allowedTools', 'Bash(sleep:*),Bash(echo:*),Read,TaskStop',
  ],
  { cwd },
);
cc.onMessage((m) => log('<-', summarize(m)));

cc.send(
  'Run `touch made-in-background` with run_in_background true and report whether it was allowed. ' +
    'Then run `sleep 40; echo slow-done` with run_in_background true and end your turn without waiting.',
);
const r1 = await cc.next((m) => m.type === 'result');
log('turn 1:', JSON.stringify(r1.result), 'denials', JSON.stringify(r1.permission_denials));
await new Promise((r) => setTimeout(r, 3000));
log('-> message while idle with a background job running');
cc.send('Quick question while that runs: what is 2+2? Answer, then end your turn; do not wait for the job.');
const r2 = await cc.next((m) => m.type === 'result');
log('turn 2 (message):', JSON.stringify(r2.result));
log('-> closing stdin while the job still runs');
const t = Date.now();
cc.endInput();
log('exit:', JSON.stringify(await cc.exited), 'after', Date.now() - t, 'ms');
await log.close();
