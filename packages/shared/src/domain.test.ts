import { describe, expect, it } from 'vitest';
import {
  AccountScopeSchema,
  AuthModeSchema,
  LOCAL_ACCOUNT_ID,
  LOCAL_USER_ID,
  localScope,
  UuidSchema,
} from './domain.js';

describe('account scope', () => {
  it('localScope is the local account with the given actor', () => {
    for (const actor of [
      { kind: 'system' as const },
      { kind: 'user' as const, user_id: 'u1' },
      { kind: 'machine' as const, machine_id: 'm1' },
    ]) {
      const scope = localScope(actor);
      expect(AccountScopeSchema.parse(scope)).toEqual({ account_id: LOCAL_ACCOUNT_ID, actor });
    }
  });

  it('refuses an unknown actor kind and a non-uuid account', () => {
    expect(
      AccountScopeSchema.safeParse({ account_id: LOCAL_ACCOUNT_ID, actor: { kind: 'admin' } })
        .success,
    ).toBe(false);
    expect(
      AccountScopeSchema.safeParse({ account_id: 'local', actor: { kind: 'system' } }).success,
    ).toBe(false);
  });

  it('the local ids are RFC 9562-valid uuids', () => {
    expect(LOCAL_ACCOUNT_ID).toBe('00000000-0000-4000-8000-000000000001');
    expect(LOCAL_USER_ID).toBe('00000000-0000-4000-8000-000000000002');
    expect(UuidSchema.safeParse(LOCAL_ACCOUNT_ID).success).toBe(true);
    expect(UuidSchema.safeParse(LOCAL_USER_ID).success).toBe(true);
  });

  it('AuthMode is local or password', () => {
    expect(AuthModeSchema.options).toEqual(['local', 'password']);
  });
});
