import { DAEMON_FEATURE_TRIAGE, type JsonObject } from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import type { Queryable } from '../../src/contracts.js';
import { triageTools, withTriageFeature } from '../../src/engine/triage-feature.js';

// ADR-0043: a triage start on a daemon without the `triage` alias gets `review` instead (both are
// edit-free). Pure, with a fake query for the machine's features: no database is under test.

function machines(features: Record<string, string[]>): Queryable {
  return {
    query: (_text: string, values?: unknown[]) =>
      Promise.resolve({
        rows:
          features[String(values?.[0])] !== undefined
            ? [{ features: features[String(values?.[0])] }]
            : [],
      }) as never,
  };
}

describe('ADR-0043 the triage alias and older daemons', () => {
  it('maps triage to review only without the feature', () => {
    expect(triageTools(['triage'], [])).toEqual(['review']);
    expect(triageTools(['triage', 'review'], ['pages'])).toEqual(['review']);
    expect(triageTools(['triage'], [DAEMON_FEATURE_TRIAGE])).toEqual(['triage']);
    expect(triageTools(['edit', 'bash'], [])).toEqual(['edit', 'bash']);
  });

  it('rewrites the start payload per machine', async () => {
    const q = machines({ old: ['pages'], new: [DAEMON_FEATURE_TRIAGE] });
    const payload: JsonObject = { prompt: 'Triage it.', tools: ['triage'], review: true };
    expect(await withTriageFeature(q, payload, 'machine:old')).toEqual({
      prompt: 'Triage it.',
      tools: ['review'],
      review: true,
    });
    expect(await withTriageFeature(q, payload, 'machine:new')).toBe(payload);
    expect(await withTriageFeature(q, payload, 'machine:gone')).toMatchObject({
      tools: ['review'],
    });
    const worker = { prompt: 'x', tools: ['edit'] };
    expect(await withTriageFeature(q, worker, 'machine:old')).toBe(worker);
  });
});
