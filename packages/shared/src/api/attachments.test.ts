import { describe, expect, it } from 'vitest';
import {
  AGENT_ATTACHMENTS_PER_TICKET_MAX,
  ATTACHMENTS_PER_TICKET_MAX,
  ATTACHMENT_MAX_IMAGE_BYTES,
  ATTACHMENT_MAX_VIDEO_BYTES,
  ATTACHMENT_ACCEPT,
  ATTACHMENT_NAME_RE,
  ATTACHMENT_TYPES_MESSAGE,
  attachmentMimeFromName,
  attachmentCountMax,
  attachmentMaxBytes,
  attachmentProblem,
  sanitizeAttachmentName,
  sniffMime,
} from './attachments.js';
import {
  AnswerInputRequestSchema,
  ReopenSessionRequestSchema,
  SendMessageRequestSchema,
} from './rest.js';
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

describe('sniffMime: 3D models', () => {
  /** A binary STL with `n` triangles (80-byte header, count, 50 bytes per triangle). */
  const binaryStl = (n: number, header = 'binary stl') => {
    const b = new Uint8Array(84 + 50 * n);
    b.set(bytes(header));
    new DataView(b.buffer).setUint32(80, n, true);
    return b;
  };
  it.each([
    ['binary stl', binaryStl(1), 'a.stl', 'model/stl'],
    ['binary stl, header says solid', binaryStl(2, 'solid but binary'), 'A.STL', 'model/stl'],
    ['ascii stl', bytes('solid cube\nfacet normal 0 0 1\nendsolid\n'), 'cube.stl', 'model/stl'],
    ['ascii stl with BOM', bytes([0xef, 0xbb, 0xbf], 'solid x\n'), 'x.stl', 'model/stl'],
    ['obj', bytes('# made by hand\n\nv 0 0 0\nf 1 2 3\n'), 'a.obj', 'model/obj'],
    ['obj with mtllib', bytes('mtllib a.mtl\no cube\n'), 'a.obj', 'model/obj'],
    ['3mf', bytes([0x50, 0x4b, 0x03, 0x04, 0x14]), 'part.3mf', 'model/3mf'],
    ['glb, no name', bytes('glTF', [2, 0, 0, 0]), '', 'model/gltf-binary'],
    ['step', bytes('ISO-10303-21;\nHEADER;\n'), 'part.stp', 'model/step'],
    ['ply, no name', bytes('ply\nformat ascii 1.0\n'), '', 'model/x-ply'],
    ['ply crlf', bytes('ply\r\nformat ascii 1.0\r\n'), 'a.ply', 'model/x-ply'],
  ])('%s', (_n, b, name, mime) => expect(sniffMime(b, name)).toBe(mime));

  it.each([
    ['binary stl one byte long', new Uint8Array([...binaryStl(1), 0]), 'a.stl'],
    ['obj without its name', bytes('v 0 0 0\n'), ''],
    ['obj named .txt', bytes('v 0 0 0\n'), 'a.txt'],
    ['html named .obj', bytes('<!doctype html><script>alert(1)</script>'), 'x.obj'],
    ['html named .stl', bytes('<html><body>solid</body></html>'), 'x.stl'],
    ['svg named .stl', bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'x.stl'],
    ['zip without its name', bytes([0x50, 0x4b, 0x03, 0x04, 0x14]), 'a.zip'],
    ['step named .obj', bytes('ISO-10303-21;\n'), 'a.obj'],
    ['binary named .obj', bytes('v 0', [0, 1, 2]), 'a.obj'],
  ])('%s → null', (_n, b, name) => expect(sniffMime(b, name)).toBeNull());

  it('a media file is its media type whatever it is named', () => {
    expect(sniffMime(bytes([0xff, 0xd8, 0xff, 0xe0]), 'x.stl')).toBe('image/jpeg');
  });

  it('attachmentMimeFromName', () => {
    expect(attachmentMimeFromName('Part.STEP')).toBe('model/step');
    expect(attachmentMimeFromName('a.stp')).toBe('model/step');
    expect(attachmentMimeFromName('a.png')).toBeNull();
    expect(attachmentMimeFromName('stl')).toBeNull();
  });

  it('the picker accepts the model extensions', () => {
    expect(ATTACHMENT_ACCEPT.split(',')).toEqual(
      expect.arrayContaining(['image/png', '.stl', '.3mf']),
    );
  });
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
    ['part.STL', 'model/stl', 'part.stl'],
    ['bracket.stp', 'model/step', 'bracket.step'],
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
    expect(attachmentMaxBytes('model/stl')).toBe(ATTACHMENT_MAX_VIDEO_BYTES);
  });

  it('attachmentProblem (client-side)', () => {
    expect(attachmentProblem({ type: 'image/png', size: 10 })).toBeNull();
    expect(attachmentProblem({ type: 'image/svg+xml', size: 10 })).toBe(ATTACHMENT_TYPES_MESSAGE);
    // Browsers give 3D models no type or an odd one: the extension decides.
    expect(attachmentProblem({ name: 'part.stl', type: '', size: 10 })).toBeNull();
    expect(
      attachmentProblem({ name: 'part.stl', type: 'application/vnd.ms-pki.stl', size: 10 }),
    ).toBeNull();
    expect(attachmentProblem({ name: 'notes.txt', type: '', size: 10 })).toBe(
      ATTACHMENT_TYPES_MESSAGE,
    );
    expect(
      attachmentProblem({ name: 'big.obj', type: '', size: ATTACHMENT_MAX_VIDEO_BYTES + 1 }),
    ).toMatch(/too large/);
    expect(
      attachmentProblem({ name: 'big.obj', type: '', size: ATTACHMENT_MAX_IMAGE_BYTES + 1 }),
    ).toBeNull();
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

describe('chat attachments on a message, an answer or a reopen', () => {
  const id = '00000000-0000-4000-8000-0000000a7005';
  const input_request_id = '00000000-0000-4000-8000-0000000a7006';
  it('text may be empty only with attachment_ids', () => {
    expect(SendMessageRequestSchema.safeParse({ text: ' ', attachment_ids: [id] }).success).toBe(
      true,
    );
    expect(SendMessageRequestSchema.safeParse({ text: '  ' }).success).toBe(false);
    expect(SendMessageRequestSchema.safeParse({ text: 'hi' }).success).toBe(true);
    expect(ReopenSessionRequestSchema.safeParse({ text: '', attachment_ids: [id] }).success).toBe(
      true,
    );
    expect(ReopenSessionRequestSchema.safeParse({ text: '' }).success).toBe(false);
    expect(
      AnswerInputRequestSchema.safeParse({ input_request_id, answer: '', attachment_ids: [id] })
        .success,
    ).toBe(true);
    expect(AnswerInputRequestSchema.safeParse({ input_request_id, answer: '' }).success).toBe(
      false,
    );
  });
  it('at most the per-ticket count of files, as uuids', () => {
    const many = Array.from({ length: ATTACHMENTS_PER_TICKET_MAX + 1 }, () => id);
    expect(SendMessageRequestSchema.safeParse({ text: 'x', attachment_ids: many }).success).toBe(
      false,
    );
    expect(SendMessageRequestSchema.safeParse({ text: 'x', attachment_ids: ['x'] }).success).toBe(
      false,
    );
  });
});
