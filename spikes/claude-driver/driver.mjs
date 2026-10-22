// Prototype of the ClaudeDriver contract proposed in ADR-0005, in plain JS.
// The daemon's real implementation (M1-T05/T07) is TypeScript; this exists to
// prove the shape works end to end against the real CLI AND the fake.
//
//   const driver = createClaudeDriver({ claudeBin, outcome })
//   const s = driver.start({ cwd, prompt, tools, resumeSessionId?, sessionId?, env, model, maxTurns, maxBudgetUsd })
//   s.on(ev => ...)   // claude_session_id | output | ask_user | complete_state | turn_end | spend | exit
//   s.sendInput(text) // live answer injection (stdin)
//   s.end()           // graceful: close stdin, process exits 0
//   s.kill()          // SIGTERM, then SIGKILL after a grace period
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { TOOL_NAMES } from './outcome-server.mjs';

const ASK_RETURN = 'Your question was sent to a human. End your turn now without calling more tools. The answer will arrive as the next user message.';
const DONE_RETURN = 'Recorded. Stop now: do not call any other tool and end your turn.';

function userLine(text) {
  return JSON.stringify({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
}

export function createClaudeDriver({ claudeBin = 'claude', outcome }) {
  return {
    start(opts) {
      const listeners = new Set();
      const emit = (ev) => { for (const l of listeners) l(ev); };
      let claudeSessionId = opts.resumeSessionId ?? opts.sessionId ?? randomUUID();
      let announced = false;
      let questionPending = false;
      let completed = false;

      const reg = outcome.register({
        async askUser(question) {
          questionPending = true;
          emit({ kind: 'ask_user', question });
          return ASK_RETURN;
        },
        async completeState(result) {
          if (questionPending) return 'A question to the human is still pending. End your turn and wait for the answer.';
          if (completed) return 'complete_state was already recorded. End your turn.';
          completed = true;
          emit({ kind: 'complete_state', result });
          return DONE_RETURN;
        },
      });

      const t = opts.tools;
      const args = [
        '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--model', opts.model ?? 'sonnet',
        '--max-turns', String(opts.maxTurns ?? 50),
        ...(opts.maxBudgetUsd ? ['--max-budget-usd', String(opts.maxBudgetUsd)] : []),
        '--setting-sources', '', '--strict-mcp-config', '--permission-prompts', 'none',
        '--permission-mode', 'dontAsk',
        '--mcp-config', reg.mcpConfig,
        '--tools', t.builtin.join(','),
        '--allowedTools', [...t.allow, ...TOOL_NAMES].join(','),
        ...(t.deny.length ? ['--disallowedTools', t.deny.join(',')] : []),
        ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : ['--session-id', claudeSessionId]),
      ];
      const child = spawn(claudeBin, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.on('data', (d) => emit({ kind: 'output', stream: 'stderr', text: d.toString() }));

      createInterface({ input: child.stdout }).on('line', (line) => {
        let m; try { m = JSON.parse(line); } catch { emit({ kind: 'output', stream: 'raw', text: line }); return; }
        if (m.type === 'system' && m.subtype === 'init') {
          // init repeats at the start of every turn; announce the id once.
          if (!announced || m.session_id !== claudeSessionId) { claudeSessionId = m.session_id; announced = true; emit({ kind: 'claude_session_id', id: m.session_id }); }
        } else if (m.type === 'assistant') {
          for (const c of m.message?.content ?? []) {
            if (c.type === 'text') emit({ kind: 'output', stream: 'assistant', text: c.text });
            else if (c.type === 'tool_use') emit({ kind: 'output', stream: 'tool_use', text: `${c.name} ${JSON.stringify(c.input)}` });
          }
        } else if (m.type === 'result') {
          emit({ kind: 'spend', totalUsd: m.total_cost_usd, usage: m.usage });
          emit({ kind: 'turn_end', subtype: m.subtype, isError: m.is_error, denials: (m.permission_denials ?? []).length });
        }
      });
      child.on('exit', (code, signal) => { reg.unregister(); emit({ kind: 'exit', code, signal }); });

      child.stdin.write(userLine(opts.prompt));
      return {
        get claudeSessionId() { return claudeSessionId; },
        on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        sendInput(text) { questionPending = false; child.stdin.write(userLine(text)); },
        end() { child.stdin.end(); },
        kill(graceMs = 5000) {
          child.kill('SIGTERM');
          const t2 = setTimeout(() => child.kill('SIGKILL'), graceMs); t2.unref();
        },
      };
    },
  };
}
