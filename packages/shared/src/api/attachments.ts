import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from '../domain.js';

// Ticket attachments (06 §Attachments, 10-contracts §Attachments). Humans attach images, GIFs,
// videos and 3D models to a ticket for the agent; agents (a follow-up) attach what they captured for feedback.
// The bytes live in Postgres (`attachment_content`, TD-212). The type is always sniffed from the
// bytes (`sniffMime`), never taken from the client: SVG and HTML are never accepted, so a stored
// file can't run script when it is served. Text-based 3D formats (OBJ, ASCII STL) have no magic
// number, so for them the file name's extension picks the format and the bytes must match it.

export const ATTACHMENT_MIMES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'model/stl',
  'model/obj',
  'model/3mf',
  'model/gltf-binary',
  'model/step',
  'model/x-ply',
] as const;
export const AttachmentMimeSchema = z.enum(ATTACHMENT_MIMES);
export type AttachmentMime = z.infer<typeof AttachmentMimeSchema>;

/** Who attached it. */
export const AttachmentSourceSchema = z.enum(['human', 'agent']);
export type AttachmentSource = z.infer<typeof AttachmentSourceSchema>;

export const ATTACHMENT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_VIDEO_BYTES = 50 * 1024 * 1024;
/** How many attachments a ticket holds from each source (human uploads and agent captures). */
export const ATTACHMENTS_PER_TICKET_MAX = 20;
/** How many files the agents of a ticket may attach (counted apart from the human's). */
export const AGENT_ATTACHMENTS_PER_TICKET_MAX = 20;
export const ATTACHMENT_TICKET_MAX_BYTES = 200 * 1024 * 1024;
export const ATTACHMENT_NAME_MAX = 100;
/** A stored name: what `sanitizeAttachmentName` returns. */
export const ATTACHMENT_NAME_RE = /^[A-Za-z0-9._ -]{1,100}$/;
export const ATTACHMENT_CAPTION_MAX = 500;
/** The request header that carries the upload's file name (URL-encoded). */
export const ATTACHMENT_FILENAME_HEADER = 'x-conductor-filename';
/** The request header that carries an agent attachment's caption (URL-encoded). */
export const ATTACHMENT_CAPTION_HEADER = 'x-conductor-caption';

/**
 * 06 §Attachments (chat): a `user` chat chunk ends with one `${CHAT_ATTACHMENT_MARK} <name>` line per
 * file sent with the message; the web shows those lines as the files' thumbnails.
 */
export const CHAT_ATTACHMENT_MARK = '\u{1F4CE}';

/** The per-ticket count limit of attachments from `source`. */
export function attachmentCountMax(source: AttachmentSource): number {
  return source === 'agent' ? AGENT_ATTACHMENTS_PER_TICKET_MAX : ATTACHMENTS_PER_TICKET_MAX;
}

/** 3D model file extensions (lowercase, no dot) and the type each one names. */
export const ATTACHMENT_MODEL_EXTENSIONS: Readonly<Record<string, AttachmentMime>> = {
  stl: 'model/stl',
  obj: 'model/obj',
  '3mf': 'model/3mf',
  glb: 'model/gltf-binary',
  step: 'model/step',
  stp: 'model/step',
  ply: 'model/x-ply',
};

/**
 * The `accept` list of the web picker: the types, plus the model extensions (browsers often give
 * a 3D model no type, or an odd one such as `application/vnd.ms-pki.stl`).
 */
export const ATTACHMENT_ACCEPT = [
  ...ATTACHMENT_MIMES,
  ...Object.keys(ATTACHMENT_MODEL_EXTENSIONS).map((e) => `.${e}`),
].join(',');

/** What a refused type is told (client and server). */
export const ATTACHMENT_TYPES_MESSAGE =
  'only images (PNG, JPEG, GIF, WebP), videos (MP4, WebM) and 3D models (STL, OBJ, 3MF, GLB, STEP, PLY) can be attached';

export const ATTACHMENT_EXTENSIONS: Readonly<Record<AttachmentMime, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'model/stl': 'stl',
  'model/obj': 'obj',
  'model/3mf': '3mf',
  'model/gltf-binary': 'glb',
  'model/step': 'step',
  'model/x-ply': 'ply',
};

export const isVideoMime = (mime: string): boolean => mime.startsWith('video/');
export const isImageMime = (mime: string): boolean => mime.startsWith('image/');
export const isModelMime = (mime: string): boolean => mime.startsWith('model/');

/** The 3D model type a file name's extension names, or null. */
export function attachmentMimeFromName(name: string): AttachmentMime | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return ATTACHMENT_MODEL_EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** The size limit for one file of `mime`: images are small, videos and 3D models larger. */
export function attachmentMaxBytes(mime: AttachmentMime): number {
  return isImageMime(mime) ? ATTACHMENT_MAX_IMAGE_BYTES : ATTACHMENT_MAX_VIDEO_BYTES;
}

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** No NUL byte in the first 8 KB: a text file, not a binary one. */
function looksText(b: Uint8Array): boolean {
  const n = Math.min(b.length, 8192);
  for (let i = 0; i < n; i++) if (b[i] === 0) return false;
  return n > 0;
}

/** The first `max` bytes as text (latin-1 is enough to read ASCII keywords). */
const head = (b: Uint8Array, max = 8192): string =>
  String.fromCharCode(...b.subarray(0, Math.min(b.length, max)));

/** Leading UTF-8 BOM and whitespace skipped. */
const textStart = (b: Uint8Array): string =>
  head(b, 512)
    .replace(/^\xef\xbb\xbf/, '')
    .trimStart();

const OBJ_KEYWORD = /^(v|vt|vn|vp|f|o|g|l|p|s|mtllib|usemtl)(\s|$)/;

/** Whether the bytes are a file of the 3D model type `mime`. */
function isModel(b: Uint8Array, mime: AttachmentMime): boolean {
  switch (mime) {
    case 'model/stl': {
      if (b.length >= 84) {
        const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(80, true);
        if (b.length === 84 + 50 * n) return true;
      }
      return looksText(b) && /^solid(\s|$)/.test(textStart(b));
    }
    case 'model/obj': {
      if (!looksText(b)) return false;
      const line = head(b)
        .replace(/^\xef\xbb\xbf/, '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l !== '' && !l.startsWith('#'));
      return line !== undefined && OBJ_KEYWORD.test(line);
    }
    case 'model/3mf':
      return startsWith(b, [0x50, 0x4b, 0x03, 0x04]);
    case 'model/gltf-binary':
      return startsWith(b, ascii('glTF'));
    case 'model/step':
      return textStart(b).startsWith('ISO-10303-21;');
    case 'model/x-ply':
      return startsWith(b, ascii('ply\n')) || startsWith(b, ascii('ply\r\n'));
    default:
      return false;
  }
}

/**
 * The file's type from its bytes, or null when it isn't one of ATTACHMENT_MIMES. `name` (the
 * client's file name) only chooses which 3D model format to check the bytes against: a model is
 * accepted only when its bytes are that format.
 */
export function sniffMime(b: Uint8Array, name = ''): AttachmentMime | null {
  const named = attachmentMimeFromName(name);
  if (named !== null && isModel(b, named)) return named;
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(b, ascii('ftyp'), 4)) return 'video/mp4';
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  // Model formats with their own magic number need no name.
  if (isModel(b, 'model/gltf-binary')) return 'model/gltf-binary';
  if (isModel(b, 'model/x-ply')) return 'model/x-ply';
  return null;
}

/**
 * A safe stored name: the basename of `raw`, characters outside `[A-Za-z0-9._ -]` → `_`, no
 * leading dots, at most ATTACHMENT_NAME_MAX characters, with the extension of `mime`.
 */
export function sanitizeAttachmentName(raw: string, mime: AttachmentMime): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const ext = ATTACHMENT_EXTENSIONS[mime];
  const dot = base.lastIndexOf('.');
  let stem = (dot > 0 ? base.slice(0, dot) : base)
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  if (stem === '') stem = 'attachment';
  stem = stem.slice(0, ATTACHMENT_NAME_MAX - ext.length - 1).trimEnd();
  return `${stem}.${ext}`;
}

/** One attachment, as GET /api/tickets/:id and POST /api/attachments return it. */
export const AttachmentDtoSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  mime: AttachmentMimeSchema,
  size_bytes: z.number().int().positive(),
  source: AttachmentSourceSchema,
  caption: z.string().nullable(),
  /** The agent's session (agent attachments); null for a human's. */
  session_id: UuidSchema.nullable(),
  /** The workflow state an agent captured it in; null for a human's. */
  workflow_state: z.string().nullable(),
  created_at: IsoDateTimeSchema,
  /** Where the bytes are (`API_PATHS.attachmentContent`). */
  url: z.string(),
});
export type AttachmentDto = z.infer<typeof AttachmentDtoSchema>;

/** Client-side checks before an upload (the server re-checks from the bytes). null = ok. */
export function attachmentProblem(file: {
  name?: string;
  type: string;
  size: number;
}): string | null {
  const mime = attachmentMime(file);
  if (mime === null) return ATTACHMENT_TYPES_MESSAGE;
  const max = attachmentMaxBytes(mime);
  if (file.size > max) return `too large (at most ${Math.round(max / 1024 / 1024)} MB)`;
  if (file.size === 0) return 'the file is empty';
  return null;
}

/** A picked file's type: its own when it is one of ATTACHMENT_MIMES, else from its extension. */
export function attachmentMime(file: { name?: string; type: string }): AttachmentMime | null {
  const mime = AttachmentMimeSchema.safeParse(file.type);
  return mime.success ? mime.data : attachmentMimeFromName(file.name ?? '');
}
