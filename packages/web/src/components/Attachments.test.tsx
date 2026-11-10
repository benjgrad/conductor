// @vitest-environment jsdom
// 06 §Attachments: the picker (checks, uploads, paste, remove), the create form linking the
// uploads, the queued ticket's gallery and the editor's add / remove. Mock API, jsdom Files.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AttachmentDto, CreateTicketRequest, UpdateTicketRequest } from '@conductor/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockApi } from '../api/mock.js';
import { App } from '../App.js';
import { AgentAttachments, AttachmentGallery } from './AttachmentGallery.js';
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
    // A clipboard with text only (no `files` at all) must not throw either.
    fireEvent.paste(screen.getByLabelText('Body'), {
      clipboardData: { getData: () => 'hello', types: ['text/plain'] },
    });
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
    render(<CreateTicketForm api={api} onClose={() => undefined} />);
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
    const dialog = screen.getByRole('dialog', { name: 'mockup.png' });
    const box = within(dialog);
    const img = box.getByRole('img', { name: 'mockup.png' });
    const close = box.getByRole('button', { name: 'Close' });
    // Close is in the header, before the media, and the media has its own shrinking box: a tall
    // image can't push Close off screen (under the iOS status bar).
    expect(close.closest('header')).toBeTruthy();
    expect(img.parentElement?.className).toBe('attachment-lightbox-media');
    expect(close.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(close);
    expect(screen.queryByRole('dialog', { name: 'mockup.png' })).toBeNull();
    // Escape and a tap on the backdrop close it too; a tap on the image doesn't.
    fireEvent.click(gallery.getByRole('button', { name: 'Open mockup.png' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'mockup.png' })).toBeNull();
    fireEvent.click(gallery.getByRole('button', { name: 'Open mockup.png' }));
    fireEvent.click(screen.getByRole('img', { name: 'mockup.png' }));
    expect(screen.getByRole('dialog', { name: 'mockup.png' })).toBeTruthy();
    fireEvent.click(screen.getByRole('dialog', { name: 'mockup.png' }));
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

function att(
  id: string,
  mime: AttachmentDto['mime'],
  at: string,
  state: string | null = null,
): AttachmentDto {
  return {
    id,
    name: `${id}.${mime.split('/')[1]}`,
    mime,
    size_bytes: 1,
    source: 'agent',
    caption: null,
    session_id: null,
    workflow_state: state,
    created_at: at,
    url: `/api/attachments/${id}/content`,
  };
}

describe('AttachmentGallery lightbox: previous / next and zoom', () => {
  const items = [
    att('a', 'image/png', '2026-11-01T00:00:00.000Z'),
    att('b', 'image/png', '2026-11-01T00:00:01.000Z'),
    att('c', 'video/mp4', '2026-11-01T00:00:02.000Z'),
  ];
  const dialog = () => screen.getByRole('dialog');

  it('steps with the arrow keys and the Previous / Next buttons, wrapping around', () => {
    render(<AttachmentGallery api={createMockApi({ replyDelayMs: 0 })} attachments={items} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open a.png' }));
    expect(dialog().getAttribute('aria-label')).toBe('a.png');
    expect(within(dialog()).getByLabelText('Position').textContent).toBe('1 / 3');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(dialog().getAttribute('aria-label')).toBe('b.png');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Next' }));
    expect(dialog().getAttribute('aria-label')).toBe('c.mp4');
    // A video has no zoom.
    expect(dialog().querySelector('video')).not.toBeNull();
    expect(within(dialog()).queryByRole('button', { name: 'Zoom in' })).toBeNull();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Next' }));
    expect(dialog().getAttribute('aria-label')).toBe('a.png');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(dialog().getAttribute('aria-label')).toBe('c.mp4');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Previous' }));
    expect(dialog().getAttribute('aria-label')).toBe('b.png');
  });

  it('zooms with the buttons, the keys and a click on the image; moving on resets it', () => {
    render(<AttachmentGallery api={createMockApi({ replyDelayMs: 0 })} attachments={items} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open a.png' }));
    const img = () => within(dialog()).getByRole('img', { name: 'a.png' });
    expect(img().style.transform).toContain('scale(1)');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Zoom in' }));
    expect(img().style.transform).toContain('scale(1.5)');
    expect(within(dialog()).getByRole('button', { name: 'Reset zoom' }).textContent).toBe('150%');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Reset zoom' }));
    expect(img().style.transform).toContain('scale(1)');
    fireEvent.keyDown(window, { key: '+' });
    expect(img().style.transform).toContain('scale(1.5)');
    fireEvent.keyDown(window, { key: '0' });
    expect(img().style.transform).toContain('scale(1)');
    // A click toggles the zoom and leaves the lightbox open.
    fireEvent.click(img());
    expect(img().style.transform).toContain('scale(2.5)');
    fireEvent.click(img());
    expect(img().style.transform).toContain('scale(1)');
    fireEvent.click(img());
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Next' }));
    const b = within(dialog()).getByRole('img', { name: 'b.png' });
    expect(b.style.transform).toContain('scale(1)');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a single item has no Previous / Next and no position', () => {
    render(
      <AttachmentGallery api={createMockApi({ replyDelayMs: 0 })} attachments={[items[0]!]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open a.png' }));
    expect(within(dialog()).queryByRole('button', { name: 'Next' })).toBeNull();
    expect(within(dialog()).queryByRole('button', { name: 'Previous' })).toBeNull();
    expect(within(dialog()).queryByLabelText('Position')).toBeNull();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(dialog().getAttribute('aria-label')).toBe('a.png');
  });

  it("the agent's attachments step across their state groups, in the order shown", () => {
    const grouped = [
      att('plan1', 'image/png', '2026-11-01T00:00:00.000Z', 'planning'),
      att('impl1', 'image/png', '2026-11-01T00:00:01.000Z', 'implementing'),
      att('impl2', 'image/png', '2026-11-01T00:00:02.000Z', 'implementing'),
    ];
    render(<AgentAttachments api={createMockApi({ replyDelayMs: 0 })} attachments={grouped} />);
    // The latest group (implementing) is shown first.
    fireEvent.click(screen.getByRole('button', { name: 'Open impl2.png' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(within(dialog()).getByLabelText('Position').textContent).toBe('2 / 3');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(dialog().getAttribute('aria-label')).toBe('plan1.png');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(dialog().getAttribute('aria-label')).toBe('impl1.png');
  });
});
