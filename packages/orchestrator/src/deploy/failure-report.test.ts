import { describe, expect, it } from 'vitest';
import {
  DEPLOY_LOG_TAIL_LINES,
  DeployFailureReportSchema,
  attemptsInBody,
  deployAttemptSection,
  deployFailureNotification,
  deployPushKey,
  deployRef,
  deployTicketBody,
  deployTicketTitle,
} from './failure-report.js';

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const PREV = '0123456789abcdef0123456789abcdef01234567';

const report = (over: Record<string, unknown> = {}) =>
  DeployFailureReportSchema.parse({
    sha: SHA,
    subject: 'feat: something',
    step: 'building the orchestrator image',
    outcome: 'rolled_back',
    running: PREV,
    run_url: 'https://github.com/benjgrad/conductor/actions/runs/1',
    repo: 'github.com/benjgrad/conductor',
    log_tail: 'one\ntwo\n',
    attempted_at: '2026-11-11T10:00:00Z',
    ...over,
  });

describe('DeployFailureReportSchema', () => {
  it('accepts a report and defaults the optional fields', () => {
    const r = DeployFailureReportSchema.parse({
      sha: SHA,
      step: 'smoke',
      outcome: 'did_not_run',
      repo: 'github.com/benjgrad/conductor',
      attempted_at: '2026-11-11T10:00:00+00:00',
    });
    expect(r).toMatchObject({ subject: '', running: null, run_url: '', log_tail: '' });
  });

  it.each([
    ['a short sha', { sha: 'abcdef1' }],
    ['an empty step', { step: '  ' }],
    ['an unknown outcome', { outcome: 'exploded' }],
    ['no time', { attempted_at: 'yesterday' }],
  ])('rejects %s', (_name, over) => {
    expect(DeployFailureReportSchema.safeParse({ ...report(), ...over }).success).toBe(false);
  });

  it('keeps only the last 50 lines of the log', () => {
    const log = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
    const lines = report({ log_tail: log }).log_tail.split('\n');
    expect(lines).toHaveLength(DEPLOY_LOG_TAIL_LINES);
    expect(lines[0]).toBe('line 30');
    expect(lines.at(-1)).toBe('line 79');
  });
});

describe('keys', () => {
  it('ties the ticket to the sha and each push to an attempt', () => {
    expect(deployRef(SHA)).toBe(`deploy:${SHA}`);
    expect(deployPushKey(SHA, 2)).toBe(`deploy:${SHA}:2`);
  });
});

describe('the ticket', () => {
  it('is titled Deploy of <short sha> failed: <step>', () => {
    expect(deployTicketTitle(report())).toBe(
      'Deploy of abcdef1 failed: building the orchestrator image',
    );
    expect(deployTicketTitle(report({ step: 'x'.repeat(200) })).length).toBeLessThan(110);
  });

  it('names the sha, the outcome and the log tail', () => {
    const body = deployTicketBody(report());
    expect(body).toContain('## Goal');
    expect(body).toContain(SHA);
    expect(body).toContain('Production rolled back to 0123456');
    expect(body).toContain('```text\none\ntwo\n```');
  });

  it('says what production does now for each outcome', () => {
    expect(deployTicketBody(report({ outcome: 'rollback_failed' }))).toContain(
      'conductor may be down',
    );
    expect(deployTicketBody(report({ outcome: 'did_not_run' }))).toContain('still on 0123456');
  });

  it('fences a log that has a fence of its own', () => {
    expect(deployTicketBody(report({ log_tail: '```\nx' }))).toContain('````text\n```\nx\n````');
  });

  it('counts the attempts a body records', () => {
    const body = deployTicketBody(report());
    expect(attemptsInBody(body)).toBe(1);
    const two = body + deployAttemptSection(report(), 2);
    expect(two).toContain('## Attempt 2 (2026-11-11T10:00:00Z)');
    expect(attemptsInBody(two)).toBe(2);
  });
});

describe('the push', () => {
  it('opens the ticket and replaces the sha’s earlier notification', () => {
    expect(deployFailureNotification('t-1', report())).toEqual({
      title: 'Deploy of abcdef1 failed: building the orchestrator image',
      body: 'Production rolled back to 0123456 and passes its smoke test; nothing new shipped.',
      url: '/#/?ticket=t-1',
      tag: `deploy:${SHA}`,
    });
  });
});
