import { describe, expect, it } from 'vitest';
import type { DriverEvent, DriverStartOptions } from './driver.js';
import { FakeClaudeDriver } from './fake-driver.js';

const flush = () => new Promise<void>((r) => setImmediate(r));

const opts = (over: Partial<DriverStartOptions> = {}): DriverStartOptions => ({
  cwd: '/tmp/wt',
  prompt: 'implement the ticket',
  tools: { builtin: ['Read', 'Edit'], allow: ['Edit(./**)'], deny: ['Bash(git push:*)'] },
  claudeSessionId: '3c1f7a52-2b9e-4d61-8f04-6e5d4c3b2a19',
  resume: false,
  env: {},
  ...over,
});

const kinds = (evs: DriverEvent[]) => evs.map((e) => e.kind);

describe('FakeClaudeDriver', () => {
  it('runs ask_user → live answer → complete_state, then exits 0 on end()', async () => {
    const driver = new FakeClaudeDriver({
      turns: [
        [{ say: 'looking' }, { askUser: 'Which DB?' }],
        (answer) => [{ completeState: { db: answer } }],
      ],
    });
    const s = driver.start(opts());
    const seen: DriverEvent[] = [];
    s.on((e) => seen.push(e));
    await flush();
    expect(kinds(seen)).toEqual(['claude_session_id', 'output', 'ask_user', 'spend', 'turn_end']);

    s.sendInput('postgres');
    await flush();
    expect(seen.find((e) => e.kind === 'complete_state')).toEqual({
      kind: 'complete_state',
      result: { db: 'postgres' },
    });
    s.end();
    await flush();
    expect(seen.at(-1)).toEqual({ kind: 'exit', code: 0, signal: null });
    expect(() => s.sendInput('late')).toThrow();
  });

  it('continues the script and cumulative spend on resume', async () => {
    const driver = new FakeClaudeDriver({
      costPerTurnUsd: 0.5,
      turns: [[{ askUser: 'q?' }], (a) => [{ completeState: { a } }]],
    });
    const s1 = driver.start(opts());
    await flush();
    s1.kill();
    await flush();
    expect(s1.events.at(-1)).toEqual({ kind: 'exit', code: null, signal: 'SIGTERM' });

    const s2 = driver.start(opts({ resume: true, prompt: 'yes' }));
    await flush();
    expect(s2.events.find((e) => e.kind === 'complete_state')).toMatchObject({
      result: { a: 'yes' },
    });
    expect(s2.events.find((e) => e.kind === 'spend')).toMatchObject({ totalUsd: 1 });
  });

  it('refuses complete_state while a question is pending, and a second one', async () => {
    const driver = new FakeClaudeDriver({
      turns: [
        [{ askUser: 'q?' }, { completeState: { x: 1 } }],
        [{ completeState: { x: 2 } }, { completeState: { x: 3 } }],
      ],
    });
    const s = driver.start(opts());
    await flush();
    s.sendInput('a');
    await flush();
    const outcomes = s.events.filter((e) => e.kind === 'complete_state');
    expect(outcomes).toEqual([{ kind: 'complete_state', result: { x: 2 } }]);
  });

  it('models a crash mid-turn', async () => {
    const driver = new FakeClaudeDriver({ turns: [[{ say: 'hi' }, { crash: { code: 1 } }]] });
    const s = driver.start(opts());
    await flush();
    expect(kinds(s.events)).toEqual(['claude_session_id', 'output', 'exit']);
    expect(driver.starts).toHaveLength(1);
  });
});
