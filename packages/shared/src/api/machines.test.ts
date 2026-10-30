import { describe, expect, it } from 'vitest';
import {
  ENROLL_REQUEST_FIXTURE,
  ENROLL_RESPONSE_FIXTURE,
  ENROLLMENT_TOKEN_CREATED_FIXTURE,
  MACHINE_DETAIL_FIXTURE,
  MACHINE_ROW_FIXTURES,
  RENAME_MACHINE_REQUEST_FIXTURE,
  UPDATE_MACHINE_REQUEST_FIXTURE,
} from './fixtures.js';
import {
  EnrollmentTokenCreatedSchema,
  EnrollRequestSchema,
  EnrollResponseSchema,
  MachineDetailSchema,
  MACHINE_CANNOT_TAKE_MAX,
  MachineRowSchema,
  RenameMachineRequestSchema,
  UpdateMachineRequestSchema,
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

  it('UpdateMachineRequest: rules and/or name, at least one; patterns validated', () => {
    expect(UpdateMachineRequestSchema.parse(UPDATE_MACHINE_REQUEST_FIXTURE)).toEqual(
      UPDATE_MACHINE_REQUEST_FIXTURE,
    );
    expect(UpdateMachineRequestSchema.parse(RENAME_MACHINE_REQUEST_FIXTURE)).toEqual(
      RENAME_MACHINE_REQUEST_FIXTURE,
    );
    expect(UpdateMachineRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateMachineRequestSchema.safeParse({ repo_allow: ['*'] }).success).toBe(false);
    expect(UpdateMachineRequestSchema.safeParse({ repo_exclusive: null }).success).toBe(false);
    expect(UpdateMachineRequestSchema.parse({ repo_exclusive: ['GitHub.com/a/*'] })).toEqual({
      repo_exclusive: ['github.com/a/*'],
    });
  });

  it('a MachineRow from an older server (no repo rules) parses as null / []', () => {
    const { repo_allow: _a, repo_exclusive: _x, ...older } = MACHINE_ROW_FIXTURES.online;
    void _a;
    void _x;
    expect(MachineRowSchema.parse(older)).toMatchObject({ repo_allow: null, repo_exclusive: [] });
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

  it('refuses an empty rename and an unknown repo mode', () => {
    expect(RenameMachineRequestSchema.safeParse({ name: '   ' }).success).toBe(false);
    const bad = {
      ...MACHINE_DETAIL_FIXTURE,
      repos: [{ ...MACHINE_DETAIL_FIXTURE.repos[0], mode: 'clone' }],
    };
    expect(MachineDetailSchema.safeParse(bad).success).toBe(false);
  });

  it('cannot_take (M2-T16a) is additive: absent reads as [], capped at 50', () => {
    const { cannot_take: _c, ...older } = MACHINE_DETAIL_FIXTURE;
    void _c;
    expect(MachineDetailSchema.parse(older).cannot_take).toEqual([]);
    const entry = MACHINE_DETAIL_FIXTURE.cannot_take[0]!;
    const many = {
      ...MACHINE_DETAIL_FIXTURE,
      cannot_take: Array(MACHINE_CANNOT_TAKE_MAX + 1).fill(entry),
    };
    expect(MachineDetailSchema.safeParse(many).success).toBe(false);
    expect(
      MachineDetailSchema.parse({
        ...MACHINE_DETAIL_FIXTURE,
        cannot_take: [{ ...entry, missing_repo: 'github.com/o/r' }],
      }).cannot_take[0]!.missing_repo,
    ).toBe('github.com/o/r');
  });
});
