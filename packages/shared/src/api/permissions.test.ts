import { describe, expect, it } from 'vitest';
import { PERMISSION_INPUT_MAX_BYTES, PERMISSION_MESSAGE_MAX } from '../protocol/ws.js';
import {
  BOARD_CARD_FIXTURE,
  BOARD_CARD_NEEDS_PERMISSION_FIXTURE,
  M2R_CARD_FIXTURES,
  PERMISSION_DECISION_REQUEST_FIXTURES,
  PERMISSION_REQUEST_DTO_FIXTURES,
} from './fixtures.js';
import {
  API_PATHS,
  ApiErrorSchema,
  BoardCardSchema,
  PERMISSION_SUMMARY_MAX,
  PermissionDecisionRequestSchema,
  PermissionRequestDtoSchema,
  PermissionRequestListResponseSchema,
  apiPathTemplates,
  permissionSummary,
  type PermissionRequestDto,
} from './rest.js';

// M2-T29 (ADR-0023): REST DTOs for permission prompts (10-contracts §Permission prompts).

const roundTrip = <T>(schema: { parse: (v: unknown) => T }, v: unknown) =>
  schema.parse(JSON.parse(JSON.stringify(v)));

describe('permission REST paths', () => {
  it('lists the two routes', () => {
    const byKey = Object.fromEntries(apiPathTemplates().map((t) => [t.key, t.path]));
    expect(byKey).toMatchObject({
      sessionPermissionRequests: '/api/sessions/:id/permission-requests',
      permissionDecision: '/api/permission-requests/:id/decision',
    });
    expect(API_PATHS.permissionDecision('abc')).toBe('/api/permission-requests/abc/decision');
  });

  it('409 permission_not_pending is an ApiError code', () => {
    const body = { error: { code: 'permission_not_pending', message: 'already decided' } };
    expect(ApiErrorSchema.parse(body)).toEqual(body);
  });
});

describe('PermissionRequestDto', () => {
  it.each(Object.entries(PERMISSION_REQUEST_DTO_FIXTURES))('%s round-trips', (_k, dto) => {
    expect(roundTrip(PermissionRequestDtoSchema, dto)).toEqual(dto);
  });

  it('the list response round-trips', () => {
    const list = { requests: Object.values(PERMISSION_REQUEST_DTO_FIXTURES) };
    expect(roundTrip(PermissionRequestListResponseSchema, list)).toEqual(list);
  });

  it('suggestions default to []; an unknown expired_reason reads as null', () => {
    const noSuggestions: Partial<PermissionRequestDto> = {
      ...PERMISSION_REQUEST_DTO_FIXTURES.pending,
    };
    delete noSuggestions.suggestions;
    expect(PermissionRequestDtoSchema.parse(noSuggestions).suggestions).toEqual([]);
    const future = { ...PERMISSION_REQUEST_DTO_FIXTURES.expired, expired_reason: 'moon_phase' };
    expect(PermissionRequestDtoSchema.parse(future).expired_reason).toBeNull();
  });

  it('rejects an oversize input, a bad status and a bad decision', () => {
    const pending = PERMISSION_REQUEST_DTO_FIXTURES.pending;
    const big = { command: 'x'.repeat(PERMISSION_INPUT_MAX_BYTES) };
    expect(PermissionRequestDtoSchema.safeParse({ ...pending, input: big }).success).toBe(false);
    expect(PermissionRequestDtoSchema.safeParse({ ...pending, status: 'held' }).success).toBe(
      false,
    );
    const allowed = PERMISSION_REQUEST_DTO_FIXTURES.allowed_always;
    for (const bad of [{ behavior: 'maybe' }, { scope: 'forever' }]) {
      const dto = { ...allowed, decision: { ...allowed.decision, ...bad } };
      expect(PermissionRequestDtoSchema.safeParse(dto).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('PermissionDecisionRequest', () => {
  it.each(Object.entries(PERMISSION_DECISION_REQUEST_FIXTURES))('%s parses', (_k, body) => {
    expect(roundTrip(PermissionDecisionRequestSchema, body)).toEqual(body);
  });

  it('rejects a bad behavior or scope, and deny + always', () => {
    for (const bad of [
      { behavior: 'ask', scope: 'once' },
      { behavior: 'allow', scope: 'forever' },
      { behavior: 'allow' },
      { scope: 'once' },
      { behavior: 'deny', scope: 'always' },
    ]) {
      expect(PermissionDecisionRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  it('trims the note; rejects a blank or oversize one', () => {
    const deny = { behavior: 'deny', scope: 'once' } as const;
    expect(PermissionDecisionRequestSchema.parse({ ...deny, message: '  no  ' }).message).toBe(
      'no',
    );
    expect(PermissionDecisionRequestSchema.safeParse({ ...deny, message: '   ' }).success).toBe(
      false,
    );
    const long = 'x'.repeat(PERMISSION_MESSAGE_MAX + 1);
    expect(PermissionDecisionRequestSchema.safeParse({ ...deny, message: long }).success).toBe(
      false,
    );
  });
});

describe('BoardCard needs_permission (sub-status)', () => {
  it('round-trips; status and column stay running / the state', () => {
    const card = roundTrip(BoardCardSchema, BOARD_CARD_NEEDS_PERMISSION_FIXTURE);
    expect(card).toEqual(BOARD_CARD_NEEDS_PERMISSION_FIXTURE);
    expect(card.status).toBe('running');
    expect(card.column).toBe('implementing');
  });

  it('older cards (no sub_status, no permission) still parse unchanged', () => {
    for (const c of [BOARD_CARD_FIXTURE, ...Object.values(M2R_CARD_FIXTURES)]) {
      const parsed = roundTrip(BoardCardSchema, c);
      expect(parsed).toEqual(c);
      expect(parsed.sub_status).toBeUndefined();
      expect(parsed.permission).toBeUndefined();
    }
  });

  it('an unknown sub_status from a newer server reads as null', () => {
    const card = BoardCardSchema.parse({ ...BOARD_CARD_FIXTURE, sub_status: 'needs_coffee' });
    expect(card.sub_status).toBeNull();
  });

  it('pending_count is at least 1', () => {
    const f = BOARD_CARD_NEEDS_PERMISSION_FIXTURE;
    const bad = { ...f, permission: { ...f.permission, pending_count: 0 } };
    expect(BoardCardSchema.safeParse(bad).success).toBe(false);
  });
});

describe('permissionSummary', () => {
  it('prefers command, then file_path, path, url, pattern', () => {
    expect(permissionSummary({ command: 'pnpm i', description: 'install' })).toBe('pnpm i');
    expect(permissionSummary({ file_path: '/etc/hosts', content: 'x' })).toBe('/etc/hosts');
    expect(permissionSummary({ url: 'https://example.com', prompt: 'p' })).toBe(
      'https://example.com',
    );
    expect(permissionSummary({ pattern: '**/*.ts' })).toBe('**/*.ts');
  });

  it('falls back to the JSON; an empty field does not count', () => {
    expect(permissionSummary({ command: '', a: 1 })).toBe('{"command":"","a":1}');
  });

  it('cuts to PERMISSION_SUMMARY_MAX characters with an ellipsis', () => {
    const s = permissionSummary({ command: 'y'.repeat(2000) });
    expect(s).toHaveLength(PERMISSION_SUMMARY_MAX);
    expect(s.endsWith('…')).toBe(true);
    expect(permissionSummary({ command: 'y'.repeat(PERMISSION_SUMMARY_MAX) })).toHaveLength(
      PERMISSION_SUMMARY_MAX,
    );
  });
});
