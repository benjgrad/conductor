import type { InviteRow } from '@conductor/shared';

/** An ISO time as the admin page shows it: local date and time, minutes precision. */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatExpiry(iso: string): string {
  return `on ${formatTime(iso)}`;
}

export type InviteStatus = 'open' | 'used' | 'revoked' | 'expired';

export function inviteStatus(row: InviteRow, now: Date = new Date()): InviteStatus {
  if (row.revoked_at !== null) return 'revoked';
  if (row.used_at !== null) return 'used';
  if (Date.parse(row.expires_at) <= now.getTime()) return 'expired';
  return 'open';
}
