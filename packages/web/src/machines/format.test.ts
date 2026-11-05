import { MACHINE_DETAIL_FIXTURE, type MachineDetail } from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import {
  cannotTakeReasons,
  countdown,
  formatRequirement,
  ghTooOld,
  ghTooOldText,
  GIT_IDENTITY_MISSING_TEXT,
  machineProblems,
  problemsLabel,
  routingNeeds,
  routingRule,
  serviceCommand,
  shortRepo,
} from './format.js';

const withGh = (version: string | null): MachineDetail['capabilities'] => ({
  ...MACHINE_DETAIL_FIXTURE.capabilities,
  cli: [{ name: 'gh', version, authed: true, repo: null }],
});

describe('machines format (M2-T11)', () => {
  it('flags a gh below GH_MIN_VERSION only', () => {
    expect(ghTooOld(withGh('2.14.0'))).toBe('2.14.0');
    expect(ghTooOld(withGh('2.39.9'))).toBe('2.39.9');
    expect(ghTooOld(withGh('2.40.0'))).toBeNull();
    expect(ghTooOld(withGh('2.103.3'))).toBeNull();
    expect(ghTooOld(withGh(null))).toBeNull();
    expect(ghTooOld({ ...MACHINE_DETAIL_FIXTURE.capabilities, cli: [] })).toBeNull();
    expect(ghTooOldText('2.14.0')).toBe('gh 2.14.0 is too old for pull requests (needs ≥ 2.40.0)');
  });

  it('UXR-48: lists the problems, gh first, and counts them', () => {
    const current = { capabilities: withGh('2.62.0') };
    const old = { capabilities: withGh('2.14.0') };
    expect(machineProblems({ git_identity_missing: false }, current)).toEqual([]);
    expect(machineProblems({}, undefined)).toEqual([]);
    expect(machineProblems({ git_identity_missing: false }, old)).toEqual([
      { key: 'gh-too-old', summary: 'gh too old', text: ghTooOldText('2.14.0') },
    ]);
    expect(machineProblems({ git_identity_missing: true }).map((p) => p.text)).toEqual([
      GIT_IDENTITY_MISSING_TEXT,
    ]);
    expect(machineProblems({ git_identity_missing: true }, old).map((p) => p.key)).toEqual([
      'gh-too-old',
      'git-identity',
    ]);
    expect(problemsLabel(1)).toBe('1 problem');
    expect(problemsLabel(2)).toBe('2 problems');
  });

  it('adds --service to both install command forms', () => {
    expect(serviceCommand('curl -fsSL https://c.example/install.sh | sh -s -- --token abc')).toBe(
      'curl -fsSL https://c.example/install.sh | sh -s -- --token abc --service',
    );
    expect(
      serviceCommand('curl -fsSL https://c.example/install.sh | CONDUCTOR_ENROLL_TOKEN=abc sh'),
    ).toBe(
      'curl -fsSL https://c.example/install.sh | CONDUCTOR_ENROLL_TOKEN=abc sh -s -- --service',
    );
  });

  it('has no --service variant for any other command shape', () => {
    expect(serviceCommand('curl -fsSL https://c.example/install.sh | sh -s')).toBeNull();
    expect(serviceCommand('curl -fsSL https://c.example/install.sh | bash')).toBeNull();
    expect(
      serviceCommand('curl -fsSL https://c.example/install.sh | bash -s -- --token a'),
    ).toBeNull();
  });

  it('formats capability keys and repos as people read them', () => {
    expect(formatRequirement('cli:az:authed')).toBe('az (signed in)');
    expect(formatRequirement('cli:gh')).toBe('gh');
    expect(formatRequirement('mcp:jira')).toBe('jira MCP server');
    expect(formatRequirement('skill:review@github.com/o/app')).toBe('skill review');
    expect(formatRequirement('agent:planner')).toBe('agent planner');
    expect(formatRequirement('claude')).toBe('claude');
    expect(shortRepo('github.com/org/app')).toBe('org/app');
    expect(shortRepo('gitlab.com/org/app')).toBe('gitlab.com/org/app');
    expect(
      routingNeeds({ missing_repo: 'github.com/org/app', missing_capabilities: ['cli:az'] }),
    ).toEqual(['org/app', 'az']);
  });

  it('repo-rule reasons (ADR-0013 amendment 2026-10-30)', () => {
    expect(routingRule({ missing_capabilities: [] })).toBeNull();
    expect(routingRule({ missing_capabilities: [], exclusive_to: ['A', 'B', 'C'] })).toBe(
      'only A, B and C take this repo',
    );
    expect(routingRule({ missing_capabilities: [], excluded_by_rule: true })).toBe(
      "left out by the machines' repo rules",
    );
    expect(
      cannotTakeReasons({
        ticket_id: 'a1000000-0000-4000-8000-0000000000a1',
        title: 't',
        missing_repo: 'github.com/work/app',
        missing_capabilities: [],
        excluded_by_rule: true,
        exclusive_to: ['Work laptop'],
      }),
    ).toEqual([
      'only Work laptop takes this repo',
      "not in this machine's repo rules",
      'needs work/app',
    ]);
  });

  it('counts down in mm:ss, never below zero', () => {
    expect(countdown(30 * 60_000)).toBe('30:00');
    expect(countdown(61_500)).toBe('01:02');
    expect(countdown(-5)).toBe('00:00');
  });
});
