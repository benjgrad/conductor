import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from '../domain.js';
import { EmailSchema } from './auth.js';

// Admin DTOs (M2-T01, ADR-0017 §Invites, sign-up, resets, the admin). Every /api/admin/* route
// is admin-only (403 `forbidden` otherwise); admins still see no other account's data.

export const INVITE_DEFAULT_DAYS = 7;
export const INVITE_MAX_DAYS = 30;
/** Reset links are valid for one hour. */
export const RESET_LINK_TTL_MS = 60 * 60_000;

/**
 * POST /api/admin/invites → 201 InviteCreated. `email` pins the sign-up email; `days` defaults to
 * INVITE_DEFAULT_DAYS on the server; `admin` makes the new user an instance admin.
 */
export const CreateInviteRequestSchema = z.object({
  email: EmailSchema.optional(),
  days: z.number().int().min(1).max(INVITE_MAX_DAYS).optional(),
  admin: z.boolean().optional(),
});
export type CreateInviteRequest = z.infer<typeof CreateInviteRequestSchema>;

/** The created invite: `url` (`<public url>/signup?invite=<token>`) is the only time the token is shown. */
export const InviteCreatedSchema = z.object({
  id: UuidSchema,
  url: z.url(),
  expires_at: IsoDateTimeSchema,
});
export type InviteCreated = z.infer<typeof InviteCreatedSchema>;

/** GET /api/admin/invites → InviteRow[] (newest first). DELETE /api/admin/invites/:id revokes. */
export const InviteRowSchema = z.object({
  id: UuidSchema,
  email: z.string().nullable(),
  is_admin: z.boolean(),
  created_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
  used_at: IsoDateTimeSchema.nullable(),
  revoked_at: IsoDateTimeSchema.nullable(),
});
export type InviteRow = z.infer<typeof InviteRowSchema>;
export const InviteListResponseSchema = z.array(InviteRowSchema);

/** GET /api/admin/users → AdminUserRow[]. `locked`: the email is locked by `login_throttle` now. */
export const AdminUserRowSchema = z.object({
  id: UuidSchema,
  email: z.string(),
  display_name: z.string(),
  is_admin: z.boolean(),
  disabled_at: IsoDateTimeSchema.nullable(),
  created_at: IsoDateTimeSchema,
  locked: z.boolean(),
});
export type AdminUserRow = z.infer<typeof AdminUserRowSchema>;
export const AdminUserListResponseSchema = z.array(AdminUserRowSchema);

/** POST /api/admin/users/:id/reset-link → 201: `<public url>/reset?token=<token>`, shown once. */
export const ResetLinkCreatedSchema = z.object({
  url: z.url(),
  expires_at: IsoDateTimeSchema,
});
export type ResetLinkCreated = z.infer<typeof ResetLinkCreatedSchema>;
