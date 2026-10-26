import { describe, expect, it } from 'vitest';
import { AccountScopeSchema, AuthModeSchema, LOCAL_ACCOUNT_ID, localScope } from './domain.js';

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

  it('AuthMode is local or password', () => {
    expect(AuthModeSchema.options).toEqual(['local', 'password']);
  });
});
