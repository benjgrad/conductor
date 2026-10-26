import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V2_DRAFT_DEF } from '../workflow/fixtures.js';
import {
  CapabilityRequirementSchema,
  CapabilitySchema,
  capabilityKey,
  capabilityKeys,
  missingCapabilities,
  type Capability,
} from '../machines/capabilities.js';
import {
  InventoryRepoSchema,
  WorkingCopySchema,
  isCanonicalRemote,
} from '../machines/inventory.js';
import { requiredCapabilities } from '../machines/required.js';
import {
  CAPABILITY_FIXTURES,
  DAEMON_FIXTURES,
  INVENTORY_REPO_FIXTURE,
  M2_WS_FIXTURES,
  ORCHESTRATOR_FIXTURES,
} from './fixtures.js';
import {
  CLOSE_PROTOCOL,
  CLOSE_REASONS,
  CLOSE_REPLACED,
  CLOSE_REVOKED,
  CLOSE_UNAUTHORIZED,
  DAEMON_AUTH_HEADER,
  DAEMON_MESSAGE_TYPES,
  DaemonToOrchestratorSchema,
  EnvelopeSchema,
  PROTOCOL_VERSION,
  RegisterPayloadSchema,
  daemonAuthHeaderValue,
  parseDaemonAuthHeader,
  parseDaemonMessage,
  parseOrchestratorMessage,
} from './ws.js';

const wire = (v: unknown) => JSON.stringify(v);

describe('protocol v2 fixtures (M2-T02)', () => {
  it('lists inventory and alert as daemon messages, repo_inventory kept', () => {
    expect(DAEMON_MESSAGE_TYPES).toEqual(
      expect.arrayContaining(['inventory', 'alert', 'repo_inventory']),
    );
  });

  it.each([
    ['inventory', DAEMON_FIXTURES.inventory],
    ['alert', DAEMON_FIXTURES.alert],
    ['register_v2', M2_WS_FIXTURES.register_v2],
    ['register_v1', M2_WS_FIXTURES.register_v1],
    ['inventory_empty', M2_WS_FIXTURES.inventory_empty],
    ['alert_with_session', M2_WS_FIXTURES.alert_with_session],
  ])('daemon %s round-trips', (_name, fixture) => {
    const parsed = parseDaemonMessage(wire(fixture));
    expect(parsed).toEqual(fixture);
    expect(EnvelopeSchema.safeParse(fixture).success).toBe(true);
  });

  it('start_session with a working copy round-trips', () => {
    const f = M2_WS_FIXTURES.start_session_working_copy;
    expect(parseOrchestratorMessage(wire(f))).toEqual(f);
    expect(f.payload.working_copy).toEqual({
      repo_path: INVENTORY_REPO_FIXTURE.path,
      mode: 'reference',
    });
    // M1 start_session (no working copy) still parses.
    expect(parseOrchestratorMessage(wire(ORCHESTRATOR_FIXTURES.start_session))).toEqual(
      ORCHESTRATOR_FIXTURES.start_session,
    );
  });

  it('a relative working_copy.repo_path is refused', () => {
    const f = M2_WS_FIXTURES.start_session_working_copy;
    const bad = {
      ...f,
      payload: { ...f.payload, working_copy: { repo_path: 'code/app', mode: 'checkout' } },
    };
    expect(() => parseOrchestratorMessage(bad)).toThrow();
    expect(WorkingCopySchema.safeParse({ repo_path: '/a/b', mode: 'other' }).success).toBe(false);
  });
});

describe('register v2', () => {
  it('a v1 register (enrollment_token null, no protocol_version) still parses', () => {
    const p = RegisterPayloadSchema.parse(M2_WS_FIXTURES.register_v1.payload);
    expect(p.enrollment_token).toBeNull();
    expect(p.protocol_version).toBeUndefined();
  });

  it('a v2 register has no enrollment token and protocol_version 2', () => {
    const p = RegisterPayloadSchema.parse(M2_WS_FIXTURES.register_v2.payload);
    expect(PROTOCOL_VERSION).toBe(2);
    expect(p.protocol_version).toBe(PROTOCOL_VERSION);
    expect(p).not.toHaveProperty('enrollment_token');
    expect(p.daemon_version).toBe('0.2.0+3b18e51');
  });

  it('refuses a non-integer protocol_version', () => {
    const payload = { ...M2_WS_FIXTURES.register_v2.payload, protocol_version: 1.5 };
    expect(RegisterPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

describe('alert', () => {
  const base = M2_WS_FIXTURES.alert_with_session;

  it('requires seq (durable) and at least one file', () => {
    expect(DaemonToOrchestratorSchema.safeParse({ ...base, seq: null }).success).toBe(false);
    expect(
      DaemonToOrchestratorSchema.safeParse({ ...base, payload: { ...base.payload, files: [] } })
        .success,
    ).toBe(false);
  });

  it('refuses another kind or a relative repo path', () => {
    for (const payload of [
      { ...base.payload, kind: 'disk_full' },
      { ...base.payload, repo: 'code/scratch' },
    ]) {
      expect(DaemonToOrchestratorSchema.safeParse({ ...base, payload }).success).toBe(false);
    }
  });
});

describe('auth header and close codes', () => {
  it('the bearer header round-trips; anything else is null', () => {
    expect(DAEMON_AUTH_HEADER).toBe('authorization');
    expect(parseDaemonAuthHeader(daemonAuthHeaderValue('cred_abc.123'))).toBe('cred_abc.123');
    for (const v of [undefined, '', 'Bearer', 'Bearer ', 'Basic eDp5', 'bearer x', 'Bearer a b']) {
      expect(parseDaemonAuthHeader(v)).toBeNull();
    }
  });

  it('close codes are distinct private-use codes, each with a reason', () => {
    const codes = [CLOSE_REPLACED, CLOSE_REVOKED, CLOSE_UNAUTHORIZED, CLOSE_PROTOCOL];
    expect(codes).toEqual([4000, 4001, 4003, 4005]);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) {
      expect(c >= 4000 && c <= 4999).toBe(true);
      expect(CLOSE_REASONS[c as keyof typeof CLOSE_REASONS].length).toBeGreaterThan(0);
      // A WS close reason must fit in 123 bytes.
      expect(Buffer.byteLength(CLOSE_REASONS[c as keyof typeof CLOSE_REASONS])).toBeLessThanOrEqual(
        123,
      );
    }
  });
});

describe('InventoryRepoSchema', () => {
  const ok = INVENTORY_REPO_FIXTURE;

  it('accepts canonical remotes and null', () => {
    for (const remote of [
      'github.com/org/app',
      'gitlab.com/g/sub/app',
      'git.example.co/o/r_1',
      null,
    ]) {
      expect(InventoryRepoSchema.safeParse({ ...ok, remote }).success).toBe(true);
    }
  });

  it('refuses a remote outside the canonical grammar', () => {
    for (const remote of [
      'https://github.com/o/r',
      'git@github.com:o/r.git',
      'ext::sh -c x',
      '../x',
      '/tmp/x',
      'file:///x',
      'github.com/o/r.git',
      'github.com/o',
      'github.com/o/../r',
      'github.com:22/o/r',
      '',
    ]) {
      expect(InventoryRepoSchema.safeParse({ ...ok, remote }).success, remote).toBe(false);
      expect(isCanonicalRemote(remote)).toBe(false);
    }
  });

  it('refuses a relative or non-normal path', () => {
    for (const path of ['code/app', './app', '~/code/app', '/a/../b', '/a/./b', '', '/a\0b']) {
      expect(InventoryRepoSchema.safeParse({ ...ok, path }).success, path).toBe(false);
    }
  });

  it('checks default_branch, head_commit and mode', () => {
    for (const bad of [
      { default_branch: '' },
      { default_branch: '-x' },
      { default_branch: 'a b' },
      { default_branch: 'a..b' },
      { head_commit: 'abc' },
      { head_commit: 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678' },
      { mode: 'clone' },
    ]) {
      expect(InventoryRepoSchema.safeParse({ ...ok, ...bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
    expect(InventoryRepoSchema.safeParse({ ...ok, head_commit: 'a'.repeat(64) }).success).toBe(
      true,
    );
  });
});

describe('capabilities', () => {
  it('capabilityKey is stable for each kind', () => {
    const table: [Capability, string][] = [
      [{ kind: 'cli', name: 'gh', version: '2.62.0', authed: true }, 'cli:gh:authed'],
      [{ kind: 'cli', name: 'gh', version: '2.70.0', authed: true }, 'cli:gh:authed'],
      [{ kind: 'cli', name: 'az', version: null, authed: false }, 'cli:az'],
      [{ kind: 'mcp', name: 'slack' }, 'mcp:slack'],
      [{ kind: 'skill', name: 'review' }, 'skill:review'],
      [
        { kind: 'skill', name: 'review', repo: 'github.com/o/app' },
        'skill:review@github.com/o/app',
      ],
      [{ kind: 'agent', name: 'planner' }, 'agent:planner'],
      [
        { kind: 'agent', name: 'planner', repo: 'github.com/o/app' },
        'agent:planner@github.com/o/app',
      ],
      [{ kind: 'claude', version: '2.1.308' }, 'claude'],
      [{ kind: 'claude', version: '3.0.0' }, 'claude'],
    ];
    for (const [c, key] of table) {
      expect(CapabilitySchema.parse(c)).toEqual(c);
      expect(capabilityKey(c)).toBe(key);
      expect(CapabilityRequirementSchema.safeParse(key).success).toBe(true);
    }
  });

  it('every fixture parses; an authed cli also satisfies the bare cli key', () => {
    for (const c of CAPABILITY_FIXTURES) expect(CapabilitySchema.parse(c)).toEqual(c);
    expect(capabilityKeys({ kind: 'cli', name: 'gh', version: null, authed: true })).toEqual([
      'cli:gh',
      'cli:gh:authed',
    ]);
    expect(capabilityKeys({ kind: 'cli', name: 'az', version: null, authed: false })).toEqual([
      'cli:az',
    ]);
  });

  it('missingCapabilities lists what the machine lacks, once, in order', () => {
    expect(
      missingCapabilities(CAPABILITY_FIXTURES, [
        'cli:gh:authed',
        'cli:az:authed',
        'cli:git',
        'claude',
        'mcp:jira',
        'cli:az:authed',
      ]),
    ).toEqual(['cli:az:authed', 'mcp:jira']);
    expect(missingCapabilities([], ['claude'])).toEqual(['claude']);
  });

  it('refuses unknown kinds, blank names and a non-canonical repo scope', () => {
    for (const bad of [
      { kind: 'gpu', name: 'x' },
      { kind: 'mcp', name: '' },
      { kind: 'mcp', name: 'a b' },
      { kind: 'skill', name: 'x', repo: 'https://github.com/o/r' },
      { kind: 'cli', name: 'gh', version: '1', authed: 'yes' },
    ]) {
      expect(CapabilitySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    for (const bad of ['', 'gpu:x', 'cli:', 'claude:2']) {
      expect(CapabilityRequirementSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('requiredCapabilities is a stub until M2-T06', () => {
    expect(requiredCapabilities(CONDUCTOR_V2_DRAFT_DEF, 'work')).toEqual([]);
  });
});
