import { describe, expect, it } from 'vitest';
import {
  AdminUserRowSchema,
  CreateInviteRequestSchema,
  InviteCreatedSchema,
  InviteRowSchema,
  ResetLinkCreatedSchema,
} from './admin.js';
import {
  ADMIN_USER_ROW_FIXTURES,
  CREATE_INVITE_REQUEST_FIXTURE,
  INVITE_CREATED_FIXTURE,
  INVITE_ROW_FIXTURES,
  RESET_LINK_CREATED_FIXTURE,
} from './fixtures.js';

const roundTrip = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

describe('admin DTOs', () => {
  it('every admin fixture parses', () => {
    expect(CreateInviteRequestSchema.parse(CREATE_INVITE_REQUEST_FIXTURE)).toEqual(
      CREATE_INVITE_REQUEST_FIXTURE,
    );
    expect(InviteCreatedSchema.parse(INVITE_CREATED_FIXTURE)).toEqual(INVITE_CREATED_FIXTURE);
    for (const row of Object.values(INVITE_ROW_FIXTURES)) {
      expect(InviteRowSchema.parse(row)).toEqual(row);
    }
    for (const row of Object.values(ADMIN_USER_ROW_FIXTURES)) {
      expect(AdminUserRowSchema.parse(row)).toEqual(row);
    }
    expect(ResetLinkCreatedSchema.parse(RESET_LINK_CREATED_FIXTURE)).toEqual(
      RESET_LINK_CREATED_FIXTURE,
    );
  });

  it('token-bearing DTOs round-trip through JSON', () => {
    expect(InviteCreatedSchema.parse(roundTrip(INVITE_CREATED_FIXTURE))).toEqual(
      INVITE_CREATED_FIXTURE,
    );
    expect(ResetLinkCreatedSchema.parse(roundTrip(RESET_LINK_CREATED_FIXTURE))).toEqual(
      RESET_LINK_CREATED_FIXTURE,
    );
  });

  it('CreateInviteRequest: everything optional, days 1..30', () => {
    expect(CreateInviteRequestSchema.parse({})).toEqual({});
    expect(CreateInviteRequestSchema.safeParse({ days: 0 }).success).toBe(false);
    expect(CreateInviteRequestSchema.safeParse({ days: 31 }).success).toBe(false);
    expect(CreateInviteRequestSchema.safeParse({ days: 1.5 }).success).toBe(false);
    expect(CreateInviteRequestSchema.parse({ email: ' Dana@Example.com ' }).email).toBe(
      'dana@example.com',
    );
  });
});
