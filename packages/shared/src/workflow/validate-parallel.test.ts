import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { requiredCapabilitiesOf } from './capabilities.js';
import { AVAILABLE_WORKFLOW_FEATURES, WorkflowDefinitionSchema } from './schema.js';
import { validateWorkflow, type WorkflowValidationError } from './validate.js';

// ADR-0040 (R10): `requires.parallel` parses, rule 28 judges its shape, and rule 14 refuses it
// ("not available yet", feature `parallel`) until the engine runs it.

const BASE = ['states', 'implementing', 'on', 'ship_it'];
const AT = [...BASE, 'requires', 'parallel'];

const WINDOWS = { type: 'cmd', name: 'Windows tests', cmd: 'pnpm test', needs: ['os:windows'] };

type Def = { states: Record<string, { on?: Record<string, unknown> }> };
/** The live `conductor` v6, which validates with no options (conductor.v6.test.ts). */
const V6 = JSON.parse(
  readFileSync(
    new URL('../../../../docs/design/workflows/conductor.v6.json', import.meta.url),
    'utf8',
  ),
) as Def;

/** conductor v6 with a `ship_it` transition out of `implementing` carrying `requires`. */
function withRequires(requires: Record<string, unknown>): Def {
  const input = structuredClone(V6);
  const impl = input.states.implementing!;
  impl.on = {
    ...impl.on,
    ship_it: {
      goto: 'waiting_external',
      requires,
      on_unmet: { goto: 'implementing', retries: 1, else: 'needs_input' },
    },
  };
  return input;
}

const CHECKS = [{ name: 'Tests pass', cmd: 'pnpm test' }];
const REVIEW = { items: ['New code has tests'] };

const valid = () =>
  withRequires({
    checks: CHECKS,
    review: REVIEW,
    parallel: [[{ type: 'checks' }], [{ type: 'review' }], [WINDOWS]],
  });

function errorsOf(input: unknown, rule: number): WorkflowValidationError[] {
  const r = validateWorkflow(input, { allowUnavailable: true });
  return r.ok ? [] : r.errors.filter((e) => e.rule === rule);
}

describe('requires.parallel (ADR-0040)', () => {
  it('is not available yet', () => {
    expect(AVAILABLE_WORKFLOW_FEATURES).not.toContain('parallel');
  });

  it('checks ∥ review ∥ a Windows cmd validates with allowUnavailable', () => {
    const r = validateWorkflow(valid(), { allowUnavailable: true });
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it('rule 14 refuses it without allowUnavailable, at requires.parallel only', () => {
    const r = validateWorkflow(valid());
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.errors).toEqual([
      { rule: 14, path: AT, message: 'parallel legs are not available yet' },
    ]);
  });

  it('a lane runs its legs in order: two legs in one lane validate', () => {
    const input = withRequires({
      checks: CHECKS,
      parallel: [[{ type: 'checks' }, { ...WINDOWS, name: 'After checks' }], [WINDOWS]],
    });
    expect(errorsOf(input, 28)).toEqual([]);
    expect(validateWorkflow(input, { allowUnavailable: true }).ok).toBe(true);
  });

  it('rule 13: cmd legs alone count as a requirement', () => {
    const input = withRequires({
      parallel: [[WINDOWS], [{ ...WINDOWS, name: 'Linux tests', needs: ['os:linux'] }]],
    });
    expect(errorsOf(input, 13)).toEqual([]);
    expect(validateWorkflow(input, { allowUnavailable: true }).ok).toBe(true);
  });

  describe('rule 28', () => {
    it('a checks leg needs requires.checks; a review leg needs requires.review', () => {
      const input = withRequires({ parallel: [[{ type: 'checks' }], [{ type: 'review' }]] });
      expect(errorsOf(input, 28)).toEqual([
        { rule: 28, path: [...AT, 0, 0], message: 'a checks leg needs requires.checks' },
        { rule: 28, path: [...AT, 1, 0], message: 'a review leg needs requires.review' },
      ]);
    });

    it('checks and review legs appear at most once', () => {
      const input = withRequires({
        checks: CHECKS,
        review: REVIEW,
        parallel: [
          [{ type: 'checks' }, { type: 'review' }],
          [{ type: 'checks' }, { type: 'review' }],
        ],
      });
      expect(errorsOf(input, 28)).toEqual([
        { rule: 28, path: [...AT, 1, 0], message: 'the checks leg is listed twice' },
        { rule: 28, path: [...AT, 1, 1], message: 'the review leg is listed twice' },
      ]);
    });

    it('declared checks and review must be run by a leg', () => {
      const input = withRequires({
        checks: CHECKS,
        review: REVIEW,
        parallel: [[WINDOWS], [{ ...WINDOWS, name: 'Other' }]],
      });
      expect(errorsOf(input, 28).map((e) => [e.path, e.message])).toEqual([
        [AT, 'requires.checks is declared but no leg runs it (add a {"type": "checks"} leg)'],
        [AT, 'requires.review is declared but no leg runs it (add a {"type": "review"} leg)'],
      ]);
    });

    it('cmd leg names are unique, differ from check names, and commands are not blank', () => {
      const input = withRequires({
        checks: CHECKS,
        parallel: [
          [{ type: 'checks' }, { ...WINDOWS, name: 'Tests pass' }],
          [WINDOWS, WINDOWS],
          [{ ...WINDOWS, name: 'Blank', cmd: '   ' }],
        ],
      });
      expect(errorsOf(input, 28)).toEqual([
        {
          rule: 28,
          path: [...AT, 0, 1, 'name'],
          message: 'leg "Tests pass" has the name of a check',
        },
        { rule: 28, path: [...AT, 1, 1, 'name'], message: 'leg "Windows tests" is listed twice' },
        { rule: 28, path: [...AT, 2, 0, 'cmd'], message: 'leg "Blank" has an empty command' },
      ]);
    });
  });

  it('rule 27: $base in a cmd leg needs the workflow bases', () => {
    const input = withRequires({
      parallel: [[{ ...WINDOWS, cmd: 'git diff $base' }], [{ ...WINDOWS, name: 'Other' }]],
    });
    expect(errorsOf(input, 27).map((e) => e.path)).toEqual([[...AT, 0, 0, 'cmd']]);
  });

  it('the schema bounds lanes and legs', () => {
    const one = withRequires({ parallel: [[WINDOWS]] });
    expect(errorsOf(one, 1).map((e) => e.path)).toEqual([AT]);
    const five = withRequires({
      parallel: [[WINDOWS], [WINDOWS], [WINDOWS], [WINDOWS], [WINDOWS]],
    });
    expect(errorsOf(five, 1).map((e) => e.path)).toEqual([AT]);
    const empty = withRequires({ parallel: [[], [WINDOWS]] });
    expect(errorsOf(empty, 1).map((e) => e.path)).toEqual([[...AT, 0]]);
  });

  it('needs accepts capability keys and os:<platform>, nothing else', () => {
    for (const needs of [['os:windows'], ['os:darwin', 'cli:gh:authed'], ['mcp:slack']]) {
      const input = withRequires({
        parallel: [
          [{ ...WINDOWS, needs }],
          [{ type: 'cmd', name: 'b', cmd: 'x', needs: ['os:linux'] }],
        ],
      });
      expect(errorsOf(input, 1)).toEqual([]);
    }
    for (const bad of ['os:beos', 'foo', 'os:']) {
      const input = withRequires({ parallel: [[{ ...WINDOWS, needs: [bad] }], [WINDOWS]] });
      expect(errorsOf(input, 1).map((e) => e.path.slice(0, AT.length + 3))).toEqual([
        [...AT, 0, 0, 'needs'],
      ]);
    }
  });

  it('leg needs route the leg, never the ticket (requiredCapabilitiesOf ignores them)', () => {
    const def = WorkflowDefinitionSchema.parse(
      withRequires({
        parallel: [
          [{ ...WINDOWS, needs: ['os:windows', 'cli:az:authed'] }],
          [{ ...WINDOWS, name: 'b' }],
        ],
      }),
    );
    const base = WorkflowDefinitionSchema.parse(V6);
    expect(requiredCapabilitiesOf(def, null)).toEqual(requiredCapabilitiesOf(base, null));
    expect(requiredCapabilitiesOf(def, null)).not.toContain('cli:az:authed');
  });
});
