import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from '../domain.js';

// Ticket attachments (06 §Attachments, 10-contracts §Attachments). Humans attach images, GIFs,
// videos, 3D models and work files (HAR, JSON, text, logs, CSV, Markdown, PDF, ZIP) to a ticket
// for the agent; agents attach what they captured for feedback.
// The bytes live in Postgres (`attachment_content`, TD-212). The type is always sniffed from the
// bytes (`sniffMime`), never taken from the client: SVG and HTML are never accepted, so a stored
// file can't run script when it is served. Text-based 3D formats (OBJ, ASCII STL) have no magic
// number, so for them the file name's extension picks the format and the bytes must match
// it. The same goes for the text files (HAR, JSON, TXT, LOG, CSV, MD) and ZIP; text that is
// really HTML, SVG or XML is refused whatever it is named. Everything but images and videos is
// served as a download.

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
  'application/har+json',
  'application/json',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/pdf',
  'application/zip',
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

/** Work file extensions (lowercase, no dot) and the type each one names. */
export const ATTACHMENT_FILE_EXTENSIONS: Readonly<Record<string, AttachmentMime>> = {
  har: 'application/har+json',
  json: 'application/json',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  markdown: 'text/markdown',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

/** Every extension that names its type (3D models and work files). */
export const ATTACHMENT_NAMED_EXTENSIONS: Readonly<Record<string, AttachmentMime>> = {
  ...ATTACHMENT_MODEL_EXTENSIONS,
  ...ATTACHMENT_FILE_EXTENSIONS,
};

/**
 * The `accept` list of the web picker: the types, plus the named extensions (browsers often give
 * a 3D model or a HAR no type, or an odd one such as `application/vnd.ms-pki.stl`).
 */
export const ATTACHMENT_ACCEPT = [
  ...ATTACHMENT_MIMES,
  ...Object.keys(ATTACHMENT_NAMED_EXTENSIONS).map((e) => `.${e}`),
].join(',');

/** What a refused type is told (client and server). */
export const ATTACHMENT_TYPES_MESSAGE =
  'only images (PNG, JPEG, GIF, WebP), videos (MP4, WebM), 3D models (STL, OBJ, 3MF, GLB, STEP, PLY) and files (HAR, JSON, TXT, LOG, CSV, MD, PDF, ZIP) can be attached';

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
  'application/har+json': 'har',
  'application/json': 'json',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
};

export const isVideoMime = (mime: string): boolean => mime.startsWith('video/');
export const isImageMime = (mime: string): boolean => mime.startsWith('image/');
export const isModelMime = (mime: string): boolean => mime.startsWith('model/');
/** A work file (HAR, JSON, text, PDF, ZIP…): neither an image, a video nor a 3D model. */
export const isFileMime = (mime: string): boolean =>
  mime.startsWith('text/') || mime.startsWith('application/');
/** A text file: checked as UTF-8 text, served with a charset. */
export const isTextMime = (mime: string): boolean =>
  mime.startsWith('text/') || mime === 'application/json' || mime === 'application/har+json';

/** A file name's extension, lowercase without the dot ('' when it has none). */
function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** The 3D model or work file type a file name's extension names, or null. */
export function attachmentMimeFromName(name: string): AttachmentMime | null {
  return ATTACHMENT_NAMED_EXTENSIONS[extensionOf(name)] ?? null;
}

/** The size limit for one file of `mime`: images are small, videos and 3D models larger. */
export function attachmentMaxBytes(mime: AttachmentMime): number {
  return isImageMime(mime) ? ATTACHMENT_MAX_IMAGE_BYTES : ATTACHMENT_MAX_VIDEO_BYTES;
}

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** No NUL byte in the first `max` bytes: a text file, not a binary one. */
function looksText(b: Uint8Array, max = 8192): boolean {
  const n = Math.min(b.length, max);
  for (let i = 0; i < n; i++) if (b[i] === 0) return false;
  return n > 0;
}

/** Text that a browser would render as a document: refused whatever the file is named. */
const MARKUP_START = /^<(!doctype\s+html|html[\s>]|svg[\s>/]|\?xml)/i;

/**
 * The whole file as UTF-8 text, or null when it isn't text: a NUL byte anywhere, invalid UTF-8,
 * or HTML, SVG or XML at its start.
 */
function asText(b: Uint8Array): string | null {
  if (!looksText(b, b.length)) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return null;
  }
  // TextDecoder drops a leading BOM by default.
  return MARKUP_START.test(text.trimStart()) ? null : text;
}

/** Whether `text` is JSON (and, for a HAR, an object with an object `log`). */
function isJson(text: string, har: boolean): boolean {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return false;
  }
  if (!har) return true;
  const log = typeof v === 'object' && v !== null ? (v as { log?: unknown }).log : undefined;
  return typeof log === 'object' && log !== null && !Array.isArray(log);
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

/** Whether the bytes are a file of the type `mime` (a 3D model or a work file). */
function isNamedType(b: Uint8Array, mime: AttachmentMime): boolean {
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
    case 'application/pdf':
      return startsWith(b, ascii('%PDF-'));
    case 'application/zip':
      return startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]);
    case 'application/json':
    case 'application/har+json': {
      // A 50 MB HAR is parsed whole on the request thread: fine at this scale.
      const text = asText(b);
      return text !== null && isJson(text, mime === 'application/har+json');
    }
    case 'text/plain':
    case 'text/csv':
    case 'text/markdown':
      return asText(b) !== null;
    default:
      return false;
  }
}

/**
 * The file's type from its bytes, or null when it isn't one of ATTACHMENT_MIMES. `name` (the
 * client's file name) only chooses which 3D model or work file format to check the bytes
 * against: such a file is accepted only when its bytes are that format.
 */
export function sniffMime(b: Uint8Array, name = ''): AttachmentMime | null {
  const named = attachmentMimeFromName(name);
  if (named !== null && isNamedType(b, named)) return named;
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(b, ascii('ftyp'), 4)) return 'video/mp4';
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  // Model formats with their own magic number need no name.
  if (isNamedType(b, 'model/gltf-binary')) return 'model/gltf-binary';
  if (isNamedType(b, 'model/x-ply')) return 'model/x-ply';
  if (isNamedType(b, 'application/pdf')) return 'application/pdf';
  return null;
}

/**
 * A safe stored name: the basename of `raw`, characters outside `[A-Za-z0-9._ -]` → `_`, no
 * leading dots, at most ATTACHMENT_NAME_MAX characters, with an extension of `mime`: the raw
 * one when it names `mime` (`build.log` stays `.log`), else `mime`'s own.
 */
export function sanitizeAttachmentName(raw: string, mime: AttachmentMime): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const rawExt = extensionOf(base);
  const ext = ATTACHMENT_NAMED_EXTENSIONS[rawExt] === mime ? rawExt : ATTACHMENT_EXTENSIONS[mime];
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

/**
 * A picked file's type: the one its extension names when it has such an extension (browsers label
 * a `.har` `application/json` or nothing), else its own when it is one of ATTACHMENT_MIMES.
 */
export function attachmentMime(file: { name?: string; type: string }): AttachmentMime | null {
  const named = attachmentMimeFromName(file.name ?? '');
  if (named !== null) return named;
  const mime = AttachmentMimeSchema.safeParse(file.type);
  return mime.success ? mime.data : null;
}
