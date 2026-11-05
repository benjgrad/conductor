import { describe, expect, it } from 'vitest';
import {
  AGENT_ATTACHMENTS_PER_TICKET_MAX,
  ATTACHMENTS_PER_TICKET_MAX,
  ATTACHMENT_MAX_IMAGE_BYTES,
  ATTACHMENT_MAX_VIDEO_BYTES,
  ATTACHMENT_NAME_RE,
  attachmentCountMax,
  attachmentMaxBytes,
  attachmentProblem,
  sanitizeAttachmentName,
  sniffMime,
} from './attachments.js';
import { M2_WS_FIXTURES } from '../protocol/fixtures.js';
import {
  DAEMON_FEATURES,
  DAEMON_FEATURE_AGENT_ATTACHMENTS,
  DAEMON_FEATURE_TICKET_ATTACHMENTS,
  parseOrchestratorMessage,
} from '../protocol/ws.js';
import { API_PATHS, CreateTicketRequestSchema, UpdateTicketRequestSchema } from './rest.js';

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(
    parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)),
  );

describe('sniffMime', () => {
  it.each([
    ['image/png', bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])],
    ['image/jpeg', bytes([0xff, 0xd8, 0xff, 0xe0])],
    ['image/gif', bytes('GIF89a', [1, 2])],
    ['image/gif', bytes('GIF87a')],
    ['image/webp', bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')],
    ['video/mp4', bytes([0, 0, 0, 0x20], 'ftypisom')],
    ['video/webm', bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f])],
  ])('%s', (mime, b) => expect(sniffMime(b)).toBe(mime));

  it.each([
    ['svg', bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['xml-prefixed svg', bytes('<?xml version="1.0"?><svg/>')],
    ['html', bytes('<!doctype html><script>alert(1)</script>')],
    ['empty', new Uint8Array()],
    ['truncated png', bytes([0x89, 0x50, 0x4e])],
    ['riff that is not webp', bytes('RIFF', [0, 0, 0, 0], 'WAVEfmt ')],
  ])('%s → null', (_n, b) => expect(sniffMime(b)).toBeNull());
});

describe('sanitizeAttachmentName', () => {
  it.each([
    ['screen shot.png', 'image/png', 'screen shot.png'],
    ['../../etc/passwd', 'image/png', 'passwd.png'],
    ['C:\\Users\\me\\a.jpeg', 'image/jpeg', 'a.jpg'],
    ['évidence<1>.gif', 'image/gif', '_vidence_1_.gif'],
    ['.hidden.png', 'image/png', 'hidden.png'],
    ['', 'video/mp4', 'attachment.mp4'],
    ['x.svg', 'image/png', 'x.png'],
  ] as const)('%s', (raw, mime, want) => {
    expect(sanitizeAttachmentName(raw, mime)).toBe(want);
    expect(ATTACHMENT_NAME_RE.test(want)).toBe(true);
  });

  it('caps the length and keeps the extension', () => {
    const name = sanitizeAttachmentName(`${'a'.repeat(300)}.webm`, 'video/webm');
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name.endsWith('.webm')).toBe(true);
  });
});

describe('limits', () => {
  it('per type', () => {
    expect(attachmentMaxBytes('image/png')).toBe(ATTACHMENT_MAX_IMAGE_BYTES);
    expect(attachmentMaxBytes('video/mp4')).toBe(ATTACHMENT_MAX_VIDEO_BYTES);
  });

  it('attachmentProblem (client-side)', () => {
    expect(attachmentProblem({ type: 'image/png', size: 10 })).toBeNull();
    expect(attachmentProblem({ type: 'image/svg+xml', size: 10 })).toMatch(/only PNG/);
    expect(attachmentProblem({ type: 'image/png', size: ATTACHMENT_MAX_IMAGE_BYTES + 1 })).toMatch(
      /too large/,
    );
    expect(
      attachmentProblem({ type: 'video/webm', size: ATTACHMENT_MAX_IMAGE_BYTES + 1 }),
    ).toBeNull();
    expect(attachmentProblem({ type: 'image/gif', size: 0 })).toMatch(/empty/);
  });
});

describe('REST and WS shapes', () => {
  it('paths', () => {
    expect(API_PATHS.attachmentContent('x')).toBe('/api/attachments/x/content');
    expect(API_PATHS.daemonAttachmentContent('x')).toBe('/api/daemon/attachments/x/content');
    expect(API_PATHS.daemonSessionAttachments('s')).toBe('/api/daemon/sessions/s/attachments');
  });

  it('each source has its own count limit; agent_attachments is a known feature', () => {
    expect(attachmentCountMax('human')).toBe(ATTACHMENTS_PER_TICKET_MAX);
    expect(attachmentCountMax('agent')).toBe(AGENT_ATTACHMENTS_PER_TICKET_MAX);
    expect(DAEMON_FEATURES).toContain(DAEMON_FEATURE_AGENT_ATTACHMENTS);
  });

  it('create and update requests take attachment ids', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(
      CreateTicketRequestSchema.parse({
        title: 't',
        body: '',
        repo: 'r',
        kind: 'work',
        attachment_ids: [id],
      }).attachment_ids,
    ).toEqual([id]);
    const at = '2026-11-04T00:00:00.000Z';
    expect(
      UpdateTicketRequestSchema.safeParse({ expected_updated_at: at, add_attachment_ids: [id] })
        .success,
    ).toBe(true);
    expect(
      UpdateTicketRequestSchema.safeParse({ expected_updated_at: at, add_attachment_ids: [] })
        .success,
    ).toBe(false);
  });

  it('start_session with attachments round-trips; the feature is known', () => {
    const f = M2_WS_FIXTURES.start_session_attachments;
    expect(parseOrchestratorMessage(JSON.stringify(f))).toEqual(f);
    expect(DAEMON_FEATURES).toContain(DAEMON_FEATURE_TICKET_ATTACHMENTS);
  });
});
