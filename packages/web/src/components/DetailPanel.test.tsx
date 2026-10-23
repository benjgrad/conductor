// @vitest-environment jsdom
import type { AnswerInputRequest, OutputChunk, SendMessageRequest } from '@conductor/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CancelSessionRequest } from '../api/client.js';
import { SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { App } from '../App.js';
import {
  AgentAvatar,
  agentIdentity,
  agentName,
  AGENT_NAMES,
  avatarTraits,
} from './agent-identity.js';
import { ContextView } from './ContextView.js';
import { OutputLog } from './OutputLog.js';

afterEach(cleanup);

async function setup(title: string) {
  const api = createMockApi({ replyDelayMs: 0 });
  const calls = {
    messages: [] as [string, SendMessageRequest][],
    answers: [] as [string, AnswerInputRequest][],
    cancels: [] as [string, CancelSessionRequest | undefined][],
  };
  const sendMessage = api.sendMessage.bind(api);
  const answer = api.answer.bind(api);
  const cancel = api.cancel.bind(api);
  api.sendMessage = (sid, req) => {
    calls.messages.push([sid, req]);
    return sendMessage(sid, req);
  };
  api.answer = (sid, req) => {
    calls.answers.push([sid, req]);
    return answer(sid, req);
  };
  api.cancel = (sid, req) => {
    calls.cancels.push([sid, req]);
    return cancel(sid, req);
  };
  render(<App api={api} />);
  fireEvent.click(await screen.findByRole('button', { name: title }));
  const el = await screen.findByRole('complementary', { name: 'Session detail' });
  const panel = within(el);
  await panel.findByRole('log');
  return { api, calls, panel };
}

const type = (box: HTMLElement, value: string) => fireEvent.change(box, { target: { value } });
const enter = (box: HTMLElement, opts: { shiftKey?: boolean } = {}) =>
  fireEvent.keyDown(box, { key: 'Enter', ...opts });

describe('session panel tabs', () => {
  it('opens on Messages and switches to Details by click and by arrow keys', async () => {
    const { panel } = await setup('Add pagination to /orders');
    const messages = panel.getByRole('tab', { name: 'Messages' });
    const details = panel.getByRole('tab', { name: 'Details' });
    expect(messages.getAttribute('aria-selected')).toBe('true');
    expect(panel.getByRole('tabpanel').contains(panel.getByRole('log'))).toBe(true);

    fireEvent.click(details);
    expect(details.getAttribute('aria-selected')).toBe('true');
    expect(panel.queryByRole('log')).toBeNull(); // hidden with its tab
    expect(panel.getByRole('region', { name: 'Agent' })).toBeTruthy();

    fireEvent.keyDown(details, { key: 'ArrowLeft' });
    expect(messages.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(messages);
    fireEvent.keyDown(messages, { key: 'ArrowRight' });
    expect(details.getAttribute('aria-selected')).toBe('true');
  });

  it('header shows the agent name; Details shows avatar, machine and session', async () => {
    const { panel } = await setup('Add pagination to /orders');
    const name = agentName(SEED_IDS.running.session);
    expect(panel.getByRole('heading', { level: 2 }).parentElement?.textContent).toContain(name);
    fireEvent.click(panel.getByRole('tab', { name: 'Details' }));
    const agent = within(panel.getByRole('region', { name: 'Agent' }));
    expect(agent.getByRole('img', { name: `${name}'s avatar` }).tagName.toLowerCase()).toBe('svg');
    expect(agent.getByText('Claude Code agent')).toBeTruthy();
    expect(await agent.findByText('bens-macbook-pro.local')).toBeTruthy();
    expect(agent.getByText(SEED_IDS.running.session)).toBeTruthy();
  });
});

describe('composer', () => {
  it('Enter sends a message to a running agent; Shift+Enter does not', async () => {
    const { calls, panel } = await setup('Add pagination to /orders');
    const box = panel.getByLabelText('Message');
    type(box, 'use cursor pagination');
    enter(box, { shiftKey: true });
    expect(calls.messages).toEqual([]);
    enter(box);
    await waitFor(() =>
      expect(calls.messages).toEqual([
        [SEED_IDS.running.session, { text: 'use cursor pagination' }],
      ]),
    );
    // The orchestrator echoes it as a `user` chunk: rendered as the human's turn.
    const mine = await panel.findByRole('group', { name: 'Your message' });
    expect(mine.textContent).toBe('Youuse cursor pagination');
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
    // The mock agent replies.
    expect(await panel.findByText(/take that into account/)).toBeTruthy();
  });

  it('keeps the text and shows the error inline when sending fails', async () => {
    const { api, panel } = await setup('Add pagination to /orders');
    api.sendMessage = () => Promise.reject(new Error('boom'));
    const box = panel.getByLabelText('Message');
    type(box, 'hello');
    enter(box);
    expect((await panel.findByRole('alert')).textContent).toBe('boom');
    expect((box as HTMLTextAreaElement).value).toBe('hello');
  });

  it('answers the open input request instead of messaging', async () => {
    const { calls, panel } = await setup('Add audit log table');
    const box = panel.getByLabelText('Answer');
    type(box, 'Postgres 16');
    enter(box);
    await waitFor(() => expect(calls.answers).toHaveLength(1));
    expect(calls.answers[0]).toEqual([
      SEED_IDS.askNewer.session,
      { input_request_id: SEED_IDS.askNewer.input, answer: 'Postgres 16' },
    ]);
    expect(calls.messages).toEqual([]);
  });

  it('is disabled with a reason when the session is finished', async () => {
    const { panel } = await setup('Rename user.fullname');
    const box = panel.getByLabelText<HTMLTextAreaElement>('Message');
    expect(box.disabled).toBe(true);
    expect(panel.getByText('Session finished')).toBeTruthy();
    expect(panel.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(true);
  });

  it('is disabled when the running step is a command, not an agent', async () => {
    const { panel } = await setup('Migrate settings page to new form lib');
    expect(panel.getByLabelText<HTMLTextAreaElement>('Message').disabled).toBe(true);
    expect(panel.getByText(/No agent in this step/)).toBeTruthy();
  });
});

type Panel = Awaited<ReturnType<typeof setup>>['panel'];

describe('slash commands', () => {
  const options = (panel: Panel) =>
    panel.getAllByRole('option').map((o) => o.querySelector('.slash-name')?.textContent);

  it('filters as you type and picks with the keyboard', async () => {
    const { panel } = await setup('Add pagination to /orders');
    const box = panel.getByLabelText('Message');
    type(box, '/');
    expect(options(panel)).toEqual(['/cancel', '/details', '/help', '/context', '/compact']);
    expect(panel.getByRole('option', { name: /\/context/ }).textContent).toContain(
      'sent to Claude',
    );
    type(box, '/c');
    expect(options(panel)).toEqual(['/cancel', '/context', '/compact']);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(panel.getByRole('option', { selected: true }).textContent).toContain('/context');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(panel.queryByRole('listbox')).toBeNull();
  });

  it('Enter on a Claude Code command sends it as a message', async () => {
    const { calls, panel } = await setup('Add pagination to /orders');
    const box = panel.getByLabelText('Message');
    type(box, '/con');
    enter(box);
    await waitFor(() =>
      expect(calls.messages).toEqual([[SEED_IDS.running.session, { text: '/context' }]]),
    );
  });

  it('an unknown /word typed by hand goes to Claude as typed', async () => {
    const { calls, panel } = await setup('Add pagination to /orders');
    const box = panel.getByLabelText('Message');
    type(box, '/todos now');
    enter(box);
    await waitFor(() =>
      expect(calls.messages).toEqual([[SEED_IDS.running.session, { text: '/todos now' }]]),
    );
  });

  it('/cancel asks for confirmation before cancelling', async () => {
    const { calls, panel } = await setup('Add pagination to /orders');
    const box = panel.getByLabelText('Message');
    type(box, '/cancel');
    enter(box);
    const confirm = within(panel.getByRole('group', { name: 'Confirm cancel' }));
    expect(calls.cancels).toEqual([]);
    fireEvent.click(confirm.getByRole('button', { name: 'Keep running' }));
    expect(panel.queryByRole('group', { name: 'Confirm cancel' })).toBeNull();

    type(box, '/cancel');
    enter(box);
    fireEvent.click(
      within(panel.getByRole('group', { name: 'Confirm cancel' })).getByRole('button', {
        name: 'Cancel session',
      }),
    );
    await waitFor(() =>
      expect(calls.cancels).toEqual([[SEED_IDS.running.session, { reason: 'cancelled from UI' }]]),
    );
    expect(calls.messages).toEqual([]);
  });

  it('/details switches to the Details tab; /help lists the commands', async () => {
    const { panel } = await setup('Add pagination to /orders');
    const box = panel.getByLabelText('Message');
    type(box, '/help');
    enter(box);
    const help = within(panel.getByRole('region', { name: 'Commands' }));
    expect(help.getByText('/compact')).toBeTruthy();
    type(box, '/det');
    fireEvent.keyDown(box, { key: 'Tab' });
    expect(panel.getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true');
  });

  it('/retry answers a non-agent request like the Retry quick action', async () => {
    const { calls, panel } = await setup('Fix flaky checkout test');
    const box = panel.getByLabelText('Answer');
    type(box, '/re');
    expect(panel.getByRole('option', { name: /\/retry/ })).toBeTruthy();
    fireEvent.click(panel.getByRole('option', { name: /\/retry/ }));
    await waitFor(() =>
      expect(calls.answers).toEqual([
        [SEED_IDS.askOlder.session, { input_request_id: SEED_IDS.askOlder.input, answer: 'retry' }],
      ]),
    );
  });
});

describe('Messages log', () => {
  let seq = 0;
  const chunk = (stream: OutputChunk['stream'], text: string): OutputChunk => ({
    session_id: SEED_IDS.running.session,
    seq: ++seq,
    stream,
    text,
    ts: '2026-10-23T12:00:00.000Z',
  });

  it('renders a user chunk as the human’s own message', () => {
    const { container } = render(
      <OutputLog
        output={[chunk('assistant', 'Working.'), chunk('user', 'please add tests')]}
        worktree={null}
        variant="chat"
      />,
    );
    const mine = container.querySelector('.user-msg');
    expect(mine?.querySelector('.user-label')?.textContent).toBe('You');
    expect(mine?.querySelector('.user-text')?.textContent).toBe('please add tests');
    expect(container.querySelectorAll('.msg')).toHaveLength(1);
  });

  it('shows "Jump to latest" when scrolled up more than a screen, with a new-entry count', () => {
    const out = [chunk('assistant', 'one'), chunk('assistant', 'two')];
    const { rerender } = render(<OutputLog output={out} worktree={null} variant="chat" />);
    const log = screen.getByRole('log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 3000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 500 });

    log.scrollTop = 2400; // 100px from the bottom: no pill
    fireEvent.scroll(log);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();

    log.scrollTop = 1000; // 1500px up = 3 screens
    fireEvent.scroll(log);
    expect(screen.getByRole('button', { name: /Jump to latest/ })).toBeTruthy();

    rerender(
      <OutputLog
        output={[...out, chunk('assistant', 'three'), chunk('assistant', 'four')]}
        worktree={null}
        variant="chat"
      />,
    );
    // Scrolled away: no auto-scroll, and the pill counts what arrived.
    expect(log.scrollTop).toBe(1000);
    expect(screen.getByRole('button', { name: /Jump to latest/ }).textContent).toContain('2 new');

    fireEvent.click(screen.getByRole('button', { name: /Jump to latest/ }));
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('the panel variant has no pill', () => {
    render(<OutputLog output={[chunk('assistant', 'x')]} worktree={null} />);
    const log = screen.getByRole('log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 3000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 500 });
    log.scrollTop = 0;
    fireEvent.scroll(log);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });
});

describe('agent identity', () => {
  const ids = Array.from(
    { length: 60 },
    (_, i) => `b2000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  );

  it('is deterministic per session id', () => {
    for (const id of ids) expect(agentIdentity(id)).toEqual(agentIdentity(id));
    expect(agentName(SEED_IDS.running.session)).toBe(agentName(SEED_IDS.running.session));
  });

  it('differs across ids', () => {
    expect(new Set(ids.map(agentName)).size).toBeGreaterThan(30);
    expect(new Set(ids.map((id) => JSON.stringify(avatarTraits(id)))).size).toBeGreaterThan(50);
    expect(new Set(ids.map((id) => avatarTraits(id).hair)).size).toBeGreaterThanOrEqual(6);
  });

  it('draws names from a curated list of 150+ unique first names', () => {
    expect(AGENT_NAMES.length).toBeGreaterThanOrEqual(150);
    expect(new Set(AGENT_NAMES).size).toBe(AGENT_NAMES.length);
  });

  it('renders the avatar as an svg at the requested size', () => {
    const { container } = render(<AgentAvatar sessionId={ids[0]!} size={20} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('width')).toBe('20');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.querySelectorAll('ellipse, circle, path').length).toBeGreaterThan(5);
  });

  it('shows the avatar and name on board cards with a session', async () => {
    render(<App api={createMockApi()} />);
    const title = await screen.findByText('Add pagination to /orders');
    const card = title.closest('article') as HTMLElement;
    expect(card.querySelector('svg.avatar')).toBeTruthy();
    expect(card.textContent).toContain(agentName(SEED_IDS.running.session));
    const queued = screen.getByText('Add /health').closest('article') as HTMLElement;
    expect(queued.querySelector('svg.avatar')).toBeNull();
  });
});

describe('Details context', () => {
  const context = {
    plan: {
      summary: 'Add **cursor** pagination',
      steps: ['read routes', 'add cursor param', 'update tests'],
      meta: { files: 3, reviewed: false, owner: { team: 'web' } },
    },
    open_pr: { pr_url: 'https://github.com/x/y/pull/7' },
  };

  it('renders strings as markdown, arrays as lists, objects as nested lists; no raw JSON', () => {
    const { container } = render(<ContextView context={context} />);
    expect(container.querySelector('.ctx-state h4')?.textContent).toBe('plan');
    expect(container.querySelector('.ctx-row strong')).toBeNull(); // short string stays plain
    expect(container.querySelectorAll('.ctx-list li')).toHaveLength(3);
    expect(container.querySelectorAll('.ctx-dl .ctx-dl .ctx-dl')).toHaveLength(1); // meta.owner
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://github.com/x/y/pull/7');
    // No JSON wall by default.
    expect(container.querySelector('pre')).toBeNull();
    expect(container.textContent).not.toMatch(/[{}"]/);

    fireEvent.click(screen.getByRole('button', { name: 'View raw JSON' }));
    expect(container.querySelector('pre.ctx-raw')?.textContent).toContain('"pr_url"');
  });

  it('renders multi-line strings as markdown and clamps long ones', () => {
    const long = Array.from({ length: 20 }, (_, i) => `- item **${i}**`).join('\n');
    const { container } = render(<ContextView context={{ s: { notes: long } }} />);
    expect(container.querySelector('.ctx-text.clamped')).toBeTruthy();
    expect(container.querySelectorAll('.ctx-text li')).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(container.querySelector('.ctx-text.clamped')).toBeNull();
  });

  it('says so when there is no context', () => {
    render(<ContextView context={{}} />);
    expect(screen.getByText('No context yet.')).toBeTruthy();
  });

  it('lives in the Details tab of the panel', async () => {
    const { panel } = await setup('Bump node to 22 in CI');
    act(() => {
      fireEvent.click(panel.getByRole('tab', { name: 'Details' }));
    });
    const ctx = within(panel.getByRole('region', { name: 'Context' }));
    expect(ctx.getByRole('link').textContent).toBe(
      'https://github.com/benjgrad/fixture-app/pull/7',
    );
    expect(ctx.queryByText(/\{/)).toBeNull();
  });
});
