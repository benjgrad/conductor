import { describe, expect, it } from 'vitest';
import {
  ENROLL_REQUEST_FIXTURE,
  ENROLL_RESPONSE_FIXTURE,
  ENROLLMENT_TOKEN_CREATED_FIXTURE,
  MACHINE_DETAIL_FIXTURE,
  MACHINE_ROW_FIXTURES,
  MACHINE_ROW_UPDATE_FAILED_FIXTURE,
  RENAME_MACHINE_REQUEST_FIXTURE,
} from './fixtures.js';
import {
  EnrollmentTokenCreatedSchema,
  EnrollRequestSchema,
  EnrollResponseSchema,
  MachineDetailSchema,
  MachineRowSchema,
  RenameMachineRequestSchema,
  type MachineRow,
} from './machines.js';
import { MachineDtoSchema } from './rest.js';

const roundTrip = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

describe('machines DTOs', () => {
  it('every machines fixture parses', () => {
    expect(EnrollRequestSchema.parse(ENROLL_REQUEST_FIXTURE)).toEqual(ENROLL_REQUEST_FIXTURE);
    expect(EnrollResponseSchema.parse(ENROLL_RESPONSE_FIXTURE)).toEqual(ENROLL_RESPONSE_FIXTURE);
    expect(EnrollmentTokenCreatedSchema.parse(ENROLLMENT_TOKEN_CREATED_FIXTURE)).toEqual(
      ENROLLMENT_TOKEN_CREATED_FIXTURE,
    );
    for (const row of Object.values(MACHINE_ROW_FIXTURES)) {
      expect(MachineRowSchema.parse(row)).toEqual(row);
    }
    expect(MachineDetailSchema.parse(MACHINE_DETAIL_FIXTURE)).toEqual(MACHINE_DETAIL_FIXTURE);
    expect(RenameMachineRequestSchema.parse(RENAME_MACHINE_REQUEST_FIXTURE)).toEqual(
      RENAME_MACHINE_REQUEST_FIXTURE,
    );
  });

  it('token-bearing DTOs round-trip through JSON', () => {
    expect(EnrollResponseSchema.parse(roundTrip(ENROLL_RESPONSE_FIXTURE))).toEqual(
      ENROLL_RESPONSE_FIXTURE,
    );
    expect(EnrollmentTokenCreatedSchema.parse(roundTrip(ENROLLMENT_TOKEN_CREATED_FIXTURE))).toEqual(
      ENROLLMENT_TOKEN_CREATED_FIXTURE,
    );
  });

  it('the enrollment command is the full install line with the token', () => {
    const { command, token } = ENROLLMENT_TOKEN_CREATED_FIXTURE;
    expect(command).toMatch(/^curl -fsSL https:\/\/\S+\/install\.sh \| sh -s -- --token /);
    expect(command.endsWith(` --token ${token}`)).toBe(true);
  });

  it('a MachineRow is still an M1 MachineDto', () => {
    expect(MachineDtoSchema.safeParse(MACHINE_ROW_FIXTURES.online).success).toBe(true);
  });

  describe('update alerts on a MachineRow (ADR-0021, M2-T18b)', () => {
    it('a row with an update_failed alert parses; rows without one still do', () => {
      expect(MachineRowSchema.parse(MACHINE_ROW_UPDATE_FAILED_FIXTURE)).toEqual(
        MACHINE_ROW_UPDATE_FAILED_FIXTURE,
      );
      expect(MachineRowSchema.parse(MACHINE_ROW_FIXTURES.online).alerts).toBeUndefined();
      expect(MachineDtoSchema.safeParse(MACHINE_ROW_UPDATE_FAILED_FIXTURE).success).toBe(true);
    });

    it('a MachineDetail is still a MachineRow (the web mock parses one as a row)', () => {
      const row: MachineRow = MACHINE_DETAIL_FIXTURE;
      expect(MachineRowSchema.parse(row).alerts).toEqual(MACHINE_DETAIL_FIXTURE.alerts);
    });

    it('refuses an unknown stage, a long error or a null list', () => {
      const [alert] = MACHINE_ROW_UPDATE_FAILED_FIXTURE.alerts!;
      for (const bad of [
        { alerts: [{ ...alert, stage: 'bogus' }] },
        { alerts: [{ ...alert, error: 'x'.repeat(501) }] },
        { alerts: [{ ...alert, version: '../x' }] },
        { alerts: null },
      ]) {
        expect(
          MachineRowSchema.safeParse({ ...MACHINE_ROW_UPDATE_FAILED_FIXTURE, ...bad }).success,
          JSON.stringify(bad).slice(0, 80),
        ).toBe(false);
      }
    });
  });

  it('refuses an empty rename and an unknown repo mode', () => {
    expect(RenameMachineRequestSchema.safeParse({ name: '   ' }).success).toBe(false);
    const bad = {
      ...MACHINE_DETAIL_FIXTURE,
      repos: [{ ...MACHINE_DETAIL_FIXTURE.repos[0], mode: 'clone' }],
    };
    expect(MachineDetailSchema.safeParse(bad).success).toBe(false);
  });
});
