// (g) Background shells in -p stream-json (ticket "Messaging doesn't interrupt running tasks", ADR-0035).
//  a. Which background-output / stop tools exist, and does an unknown name in --tools break the run?
//  b. A turn ends while a background shell still runs: does the CLI start a turn of its own when
//     the job finishes?
//  d. Is a `run_in_background` Bash command held to the same permission rules?
import { spawnClaude, baseArgs, scratchRepo, summarize, logger } from './lib.mjs';

const log = logger('g-background');
const cwd = scratchRepo('g');
const TOOLS = 'Bash,Read,BashOutput,KillShell,TaskOutput,TaskStop,NoSuchTool';

const cc = spawnClaude(
  'g-background',
  [
    ...baseArgs({ maxTurns: 8 }),
    '--permission-mode', 'dontAsk',
    '--tools', TOOLS,
    '--allowedTools', 'Bash(sleep:*),Bash(echo:*),Read,BashOutput,TaskOutput,TaskStop,KillShell',
  ],
  { cwd },
);
const seen = [];
cc.onMessage((m) => {
  seen.push(m);
  log('<-', summarize(m));
});

cc.send(
  'First, list the exact names of every tool you have, comma separated, on one line. ' +
    'Then run this Bash command with run_in_background set to true: `sleep 15; echo bg-done`. ' +
    'Also try running `ls` with run_in_background true. Then end your turn immediately: do not wait for either.',
);
const init = await cc.next((m) => m.type === 'system' && m.subtype === 'init');
log('init tools:', JSON.stringify(init.tools));
const r1 = await cc.next((m) => m.type === 'result');
log('turn 1 result:', JSON.stringify(r1.result), 'denials', JSON.stringify(r1.permission_denials));

// b: wait past the background job without writing anything.
const r2 = await cc.next((m) => m.type === 'result', 40_000).catch(() => null);
log('unsolicited turn after the background job finished?', r2 ? 'YES: ' + JSON.stringify(r2.result) : 'no');

cc.endInput();
log('exit:', JSON.stringify(await cc.exited));
await log.close();
