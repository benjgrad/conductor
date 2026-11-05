import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from '../domain.js';

// Ticket attachments (06 §Attachments, 10-contracts §Attachments). Humans attach images, GIFs and
// videos to a ticket for the agent; agents (a follow-up) attach what they captured for feedback.
// The bytes live in Postgres (`attachment_content`, TD-212). The type is always sniffed from the
// bytes (`sniffMime`), never taken from the client: SVG and HTML are never accepted, so a stored
// file can't run script when it is served.

export const ATTACHMENT_MIMES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
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

/** The per-ticket count limit of attachments from `source`. */
export function attachmentCountMax(source: AttachmentSource): number {
  return source === 'agent' ? AGENT_ATTACHMENTS_PER_TICKET_MAX : ATTACHMENTS_PER_TICKET_MAX;
}
/** The `accept` list of the web picker. */
export const ATTACHMENT_ACCEPT = ATTACHMENT_MIMES.join(',');

export const ATTACHMENT_EXTENSIONS: Readonly<Record<AttachmentMime, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

export const isVideoMime = (mime: string): boolean => mime.startsWith('video/');

/** The size limit for one file of `mime`. */
export function attachmentMaxBytes(mime: AttachmentMime): number {
  return isVideoMime(mime) ? ATTACHMENT_MAX_VIDEO_BYTES : ATTACHMENT_MAX_IMAGE_BYTES;
}

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** The file's type from its first bytes, or null when it isn't one of ATTACHMENT_MIMES. */
export function sniffMime(b: Uint8Array): AttachmentMime | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(b, ascii('ftyp'), 4)) return 'video/mp4';
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
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
export function attachmentProblem(file: { type: string; size: number }): string | null {
  const mime = AttachmentMimeSchema.safeParse(file.type);
  if (!mime.success) return 'only PNG, JPEG, GIF, WebP, MP4 and WebM files can be attached';
  const max = attachmentMaxBytes(mime.data);
  if (file.size > max) return `too large (at most ${Math.round(max / 1024 / 1024)} MB)`;
  if (file.size === 0) return 'the file is empty';
  return null;
}
