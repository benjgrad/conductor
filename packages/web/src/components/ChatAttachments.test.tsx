// @vitest-environment jsdom
// 06 §Attachments (chat): the composer's paperclip uploads images and sends their ids with the
// message, an image alone included; the chat bubble shows them as thumbnails; the Details tab
// lists the ticket's files. Through DetailPanel on the mock API.
import type { SendMessageRequest, SessionDetail } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { DetailPanel } from './DetailPanel.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const png = (name = 'shot.png') =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' });

async function open(sessionId: string, patch?: (d: SessionDetail) => SessionDetail) {
  const api = createMockApi({ replyDelayMs: 60_000 });
  if (patch) {
    const get = api.getSession.bind(api);
    api.getSession = async (id) => patch(await get(id));
  }
  const sent: SendMessageRequest[] = [];
  const sendMessage = api.sendMessage.bind(api);
  api.sendMessage = (id, req) => {
    sent.push(req);
    return sendMessage(id, req);
  };
  let release: (() => void) | null = null;
  const upload = api.uploadAttachment.bind(api);
  const held = { on: false };
  api.uploadAttachment = async (f) => {
    if (held.on) await new Promise<void>((r) => (release = r));
    return upload(f);
  };
  render(<DetailPanel api={api} sessionId={sessionId} version="1" onClose={() => undefined} />);
  const panel = within(await screen.findByRole('complementary', { name: 'Session detail' }));
  await panel.findByRole('log');
  return { api, panel, sent, held, release: () => release?.() };
}

const attach = (...files: File[]) =>
  fireEvent.change(screen.getByLabelText('Attach files to the message'), { target: { files } });
const send = () => screen.getByRole('button', { name: 'Send' });

describe('chat attachments', () => {
  it('an image alone can be sent; its ids go with the message and it shows in the bubble', async () => {
    const { panel, sent } = await open(SEED_IDS.running.session);
    expect(send()).toHaveProperty('disabled', true);
    attach(png('like this.png'));
    const list = within(await screen.findByRole('list', { name: 'Attachments to send' }));
    await waitFor(() => expect(send()).toHaveProperty('disabled', false));
    expect(list.getByText('like this.png')).toBeTruthy();
    fireEvent.click(send());
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.text).toBe('');
    expect(sent[0]!.attachment_ids).toHaveLength(1);
    // Sent: the strip clears; the bubble shows the file, not the 📎 line.
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Attachments to send' })).toBeNull(),
    );
    const bubble = within((await panel.findAllByRole('group', { name: 'Your message' })).at(-1)!);
    expect(await bubble.findByRole('button', { name: 'Open like this.png' })).toBeTruthy();
    expect(bubble.queryByText(/\u{1F4CE}/u)).toBeNull();
  });

  it('Send waits for an upload in progress; a /command with files is refused', async () => {
    const { sent, held, release } = await open(SEED_IDS.running.session);
    held.on = true;
    attach(png());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hello' } });
    await screen.findByText('uploading…');
    expect(send()).toHaveProperty('disabled', true);
    release();
    await waitFor(() => expect(send()).toHaveProperty('disabled', false));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '/compact now' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    fireEvent.click(send());
    expect(await screen.findByText('Remove the attachments to run /compact')).toBeTruthy();
    expect(sent).toHaveLength(0);
  });

  it('no paperclip while the composer is off', async () => {
    // Conductor opening the PR (the actions phase): the composer is off. (ADR-0044: the checks
    // and review phases take messages.)
    await open(SEED_IDS.checking.session, (d) => ({
      ...d,
      card: { ...d.card, checking: { ...d.card.checking!, phase: 'actions' } },
    }));
    expect(screen.queryByRole('button', { name: 'Attach images, videos or 3D models' })).toBeNull();
  });

  it('the Details tab lists the files sent in the chat', async () => {
    const { panel, sent } = await open(SEED_IDS.running.session);
    attach(png('detail.png'));
    await waitFor(() => expect(send()).toHaveProperty('disabled', false));
    fireEvent.click(send());
    await waitFor(() => expect(sent).toHaveLength(1));
    fireEvent.click(panel.getByRole('tab', { name: 'Details' }));
    const section = await panel.findByRole('region', { name: 'Added in chat' });
    expect(within(section).getByText('detail.png')).toBeTruthy();
  });
});
