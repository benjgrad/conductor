import { describe, expect, it } from 'vitest';
import {
  MACHINE_LOST_EVENT_FIXTURES,
  MACHINE_LOST_MARK_FIXTURE,
  SNAPSHOT_FIXTURE,
} from './fixtures.js';
import {
  APPLY_IGNORE_REASONS,
  EngineEventSchema,
  MACHINE_LOST_CONTEXT_KEY,
  MACHINE_LOST_KIND,
  MACHINE_LOST_KILL_REASON,
  MACHINE_LOST_REASONS,
  MachineLostMarkSchema,
  machineLostContinueTitle,
  machineLostQuestion,
} from './types.js';

// M2-T02 contracts for a lost machine (U-068). The engine behaviour is M2-T06's.

describe('machine.lost contract', () => {
  it('is an engine event; every reason has a fixture that parses', () => {
    expect(EngineEventSchema.options.map((o) => o.shape.type.value)).toContain('machine.lost');
    expect(Object.keys(MACHINE_LOST_EVENT_FIXTURES).sort()).toEqual(
      [...MACHINE_LOST_REASONS].sort(),
    );
    for (const ev of Object.values(MACHINE_LOST_EVENT_FIXTURES)) {
      expect(EngineEventSchema.parse(ev)).toEqual(ev);
      expect(ev.machine_id).toBe(SNAPSHOT_FIXTURE.machine_id);
    }
  });

  it('refuses an unknown reason or a missing machine', () => {
    expect(
      EngineEventSchema.safeParse({ type: 'machine.lost', machine_id: 'm', reason: 'sleepy' })
        .success,
    ).toBe(false);
    expect(EngineEventSchema.safeParse({ type: 'machine.lost', reason: 'revoked' }).success).toBe(
      false,
    );
  });

  it('question and continue texts name the machine', () => {
    expect(machineLostQuestion("Ben's MacBook", 'lease_expired')).toBe(
      "Ben's MacBook stopped responding",
    );
    expect(machineLostQuestion('mbp-ben', 'revoked')).toBe('mbp-ben was revoked');
    expect(machineLostQuestion('mbp-ben', 'pinned_machine_offline')).toBe(
      'mbp-ben has been offline for 15 minutes',
    );
    expect(machineLostContinueTitle('mbp-ben')).toBe('Continue on mbp-ben');
  });

  it('the kind is new (added to the enum by M2-T03), the kill reason and pin key are fixed', () => {
    expect(MACHINE_LOST_KIND).toBe('machine_lost');
    expect(MACHINE_LOST_KILL_REASON).toBe('machine_lost');
    expect(MACHINE_LOST_CONTEXT_KEY).toBe('__machine_lost');
    expect(MACHINE_LOST_CONTEXT_KEY.startsWith('__')).toBe(true);
  });

  it('the context mark parses; machine_mismatch is an ignore reason', () => {
    expect(MachineLostMarkSchema.parse(MACHINE_LOST_MARK_FIXTURE)).toEqual(
      MACHINE_LOST_MARK_FIXTURE,
    );
    expect(
      MachineLostMarkSchema.safeParse({ ...MACHINE_LOST_MARK_FIXTURE, reason: 'x' }).success,
    ).toBe(false);
    expect(APPLY_IGNORE_REASONS).toContain('machine_mismatch');
  });
});
