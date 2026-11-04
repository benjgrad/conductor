// @vitest-environment jsdom
// 06 §Attachments: the picker (checks, uploads, paste, remove), the create form linking the
// uploads, the queued ticket's gallery and the editor's add / remove. Mock API, jsdom Files.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CreateTicketRequest, UpdateTicketRequest } from '@conductor/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockApi } from '../api/mock.js';
import { App } from '../App.js';
import { AttachmentPicker, useAttachmentUploads } from './AttachmentPicker.js';
import { CreateTicketForm } from './CreateTicketForm.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const png = (name = 'shot.png') =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' });
const mp4 = () => new File([new Uint8Array(8)], 'repro.mp4', { type: 'video/mp4' });

function Picker({ api }: { api: ReturnType<typeof createMockApi> }) {
  const uploads = useAttachmentUploads(api);
  return (
    <div onPasteCapture={uploads.onPaste}>
      <textarea aria-label="Body" />
      <AttachmentPicker api={api} uploads={uploads} />
      <output aria-label="ids">{uploads.ids.join(',')}</output>
    </div>
  );
}

const fileInput = () => screen.getByLabelText<HTMLInputElement>('Attach files');
const pick = (...files: File[]) => fireEvent.change(fileInput(), { target: { files } });

describe('AttachmentPicker', () => {
  it('uploads images and videos; refuses SVG and over-size files without sending them', async () => {
    const api = createMockApi({ replyDelayMs: 0 });
    const sent: string[] = [];
    const upload = api.uploadAttachment.bind(api);
    api.uploadAttachment = (f) => {
      sent.push(f.name);
      return upload(f);
    };
    render(<Picker api={api} />);
    const svg = new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' });
    const huge = new File([new Uint8Array(1)], 'big.png', { type: 'image/png' });
    Object.defineProperty(huge, 'size', { value: 11 * 1024 * 1024 });
    pick(png(), mp4(), svg, huge);
    const list = within(screen.getByRole('list', { name: 'Attachments to add' }));
    await waitFor(() =>
      expect(screen.getByLabelText('ids').textContent?.split(',')).toHaveLength(2),
    );
    expect(sent).toEqual(['shot.png', 'repro.mp4']);
    expect(list.getByText(/only PNG, JPEG, GIF, WebP, MP4 and WebM/)).toBeTruthy();
    expect(list.getByText(/too large/)).toBeTruthy();
  });

  it('a pasted image is uploaded; Remove drops it and deletes the upload', async () => {
    const api = createMockApi({ replyDelayMs: 0 });
    const deleted: string[] = [];
    const del = api.deleteAttachment.bind(api);
    api.deleteAttachment = (id) => {
      deleted.push(id);
      return del(id);
    };
    render(<Picker api={api} />);
    fireEvent.paste(screen.getByLabelText('Body'), {
      clipboardData: { files: [png('pasted.png')] },
    });
    await waitFor(() => expect(screen.getByLabelText('ids').textContent).not.toBe(''));
    const id = screen.getByLabelText('ids').textContent;
    fireEvent.click(screen.getByRole('button', { name: 'Remove pasted.png' }));
    expect(screen.getByLabelText('ids').textContent).toBe('');
    await waitFor(() => expect(deleted).toEqual([id]));
  });

  it('pasted text is left alone', () => {
    const api = createMockApi({ replyDelayMs: 0 });
    render(<Picker api={api} />);
    fireEvent.paste(screen.getByLabelText('Body'), { clipboardData: { files: [] } });
    expect(screen.queryByRole('list', { name: 'Attachments to add' })).toBeNull();
  });
});

describe('CreateTicketForm with attachments', () => {
  it('sends the uploaded ids; the queued ticket shows them in its gallery', async () => {
    const api = createMockApi({ replyDelayMs: 0 });
    const sent: CreateTicketRequest[] = [];
    const create = api.createTicket.bind(api);
    api.createTicket = (req) => {
      sent.push(req);
      return create(req);
    };
    render(<CreateTicketForm api={api} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Match the mockup' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Work' }));
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Create ticket' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    pick(png('mockup.png'));
    await screen.findByText('mockup.png');
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.attachment_ids).toHaveLength(1);
    // The picker is cleared for the next ticket.
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Attachments to add' })).toBeNull(),
    );

    cleanup();
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Match the mockup' }));
    const panel = within(await screen.findByRole('complementary', { name: 'Ticket detail' }));
    const gallery = within(await panel.findByRole('region', { name: 'Attachments' }));
    fireEvent.click(gallery.getByRole('button', { name: 'Open mockup.png' }));
    const box = within(screen.getByRole('dialog', { name: 'mockup.png' }));
    expect(box.getByRole('img', { name: 'mockup.png' })).toBeTruthy();
    fireEvent.click(box.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'mockup.png' })).toBeNull();
  });
});

describe('TicketEditor attachments', () => {
  it('adds new uploads and removes existing ones in one PATCH; a video renders <video>', async () => {
    const api = createMockApi({ replyDelayMs: 0 });
    const first = await api.uploadAttachment(mp4());
    await api.createTicket({
      title: 'Queued with video',
      body: 'b',
      repo: 'github.com/acme/app',
      kind: 'work',
      attachment_ids: [first.id],
    });
    const patches: UpdateTicketRequest[] = [];
    const update = api.updateTicket.bind(api);
    api.updateTicket = (id, req) => {
      patches.push(req);
      return update(id, req);
    };
    const { container } = render(<App api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Queued with video' }));
    const panel = within(await screen.findByRole('complementary', { name: 'Ticket detail' }));
    await panel.findByRole('region', { name: 'Attachments' });
    expect(container.querySelector('video.attachment-thumb')).not.toBeNull();

    fireEvent.click(panel.getByRole('button', { name: 'Edit ticket' }));
    const form = within(panel.getByRole('form', { name: 'Edit ticket' }));
    fireEvent.click(form.getByRole('button', { name: 'Remove repro.mp4' }));
    pick(png('new.png'));
    await waitFor(() =>
      expect(form.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(false),
    );
    await form.findByText('new.png');
    fireEvent.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]!.remove_attachment_ids).toEqual([first.id]);
    expect(patches[0]!.add_attachment_ids).toHaveLength(1);
    const after = await api.getTicket(
      (await api.getBoard()).columns[0]!.cards.find((c) => c.title === 'Queued with video')!
        .ticket_id,
    );
    expect(after.attachments?.map((a) => a.name)).toEqual(['new.png']);
  });
});
