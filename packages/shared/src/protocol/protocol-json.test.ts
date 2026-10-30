import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { canonicalRepo } from '../api/rest.js';
import {
  capabilityKey,
  capabilityKeys,
  CapabilitySchema,
  cliVersionAtLeast,
  type Capability,
} from '../machines/capabilities.js';
import { InventoryRepoSchema, isCanonicalRemote } from '../machines/inventory.js';
import { resolveToolPolicy, UnknownToolAliasError } from '../workflow/tools.js';
import {
  ClosePrArgsSchema,
  ClosePrResultSchema,
  InspectPrArgsSchema,
  InspectPrResultSchema,
  MergePrArgsSchema,
  MergePrResultSchema,
  OpenPrResultSchema,
} from './actions.js';
import {
  daemonAuthHeaderValue,
  DaemonToOrchestratorSchema,
  jsonByteLength,
  OrchestratorToDaemonSchema,
  SessionEventPayloadSchema,
} from './ws.js';

// MR-T03 (ADR-0026 §2): the TypeScript half of the two-sided checks on packages/shared/protocol-json.
// - vectors/*.json run here and in crates/conductor-protocol/tests/vectors.rs (FR-3);
// - roundtrip/*.json are the fixtures as the Rust types re-serialised them (written by
//   crates/conductor-protocol/tests/roundtrip.rs); the zod schemas must still accept them (FR-4).

const DIR = new URL('../../protocol-json/', import.meta.url);
const readJson = (rel: string): unknown => JSON.parse(readFileSync(new URL(rel, DIR), 'utf8'));

interface Vector<I, O> {
  function: string;
  cases: { input: I; expected?: O; error?: { unknown: string[] } }[];
}
const vector = <I, O>(name: string): Vector<I, O>['cases'] => {
  const v = readJson(`vectors/${name}.json`) as Vector<I, O>;
  expect(v.function).toBe(name);
  expect(v.cases.length).toBeGreaterThan(0);
  return v.cases;
};

describe('shared vectors (also run by conductor-protocol)', () => {
  it('has a test for every vector file', () => {
    const files = readdirSync(new URL('vectors/', DIR)).sort();
    expect(files).toEqual(
      [
        'canonicalRepo',
        'capabilityKey',
        'capabilityKeys',
        'cliVersionAtLeast',
        'daemonAuthHeaderValue',
        'isCanonicalRemote',
        'jsonByteLength',
        'resolveToolPolicy',
      ].map((n) => `${n}.json`),
    );
  });

  it('canonicalRepo', () => {
    for (const c of vector<string, string | null>('canonicalRepo')) {
      expect(canonicalRepo(c.input), JSON.stringify(c.input)).toBe(c.expected);
    }
  });

  it('isCanonicalRemote', () => {
    for (const c of vector<string, boolean>('isCanonicalRemote')) {
      expect(isCanonicalRemote(c.input), JSON.stringify(c.input)).toBe(c.expected);
    }
  });

  it('cliVersionAtLeast', () => {
    for (const c of vector<{ version: string | null; min: string }, boolean>('cliVersionAtLeast')) {
      expect(cliVersionAtLeast(c.input.version, c.input.min), JSON.stringify(c.input)).toBe(
        c.expected,
      );
    }
  });

  it('capabilityKey and capabilityKeys', () => {
    for (const c of vector<Capability, string>('capabilityKey')) {
      expect(capabilityKey(CapabilitySchema.parse(c.input))).toBe(c.expected);
    }
    for (const c of vector<Capability, string[]>('capabilityKeys')) {
      expect(capabilityKeys(CapabilitySchema.parse(c.input))).toEqual(c.expected);
    }
  });

  it('daemonAuthHeaderValue', () => {
    for (const c of vector<string, string>('daemonAuthHeaderValue')) {
      expect(daemonAuthHeaderValue(c.input)).toBe(c.expected);
    }
  });

  it('jsonByteLength', () => {
    for (const c of vector<unknown, number>('jsonByteLength')) {
      expect(jsonByteLength(c.input), JSON.stringify(c.input)).toBe(c.expected);
    }
  });

  it('resolveToolPolicy', () => {
    for (const c of vector<string[], ReturnType<typeof resolveToolPolicy>>('resolveToolPolicy')) {
      if (c.error === undefined) {
        expect(resolveToolPolicy(c.input), JSON.stringify(c.input)).toEqual(c.expected);
      } else {
        let thrown: unknown;
        try {
          resolveToolPolicy(c.input);
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(UnknownToolAliasError);
        expect((thrown as UnknownToolAliasError).names).toEqual(c.error.unknown);
      }
    }
  });
});

/** Every `schema` the manifest names → its zod schema. */
const SCHEMAS: Record<string, z.ZodType> = {
  DaemonToOrchestrator: DaemonToOrchestratorSchema,
  OrchestratorToDaemon: OrchestratorToDaemonSchema,
  SessionEventPayload: SessionEventPayloadSchema,
  Capability: CapabilitySchema,
  InventoryRepo: InventoryRepoSchema,
  OpenPrResult: OpenPrResultSchema,
  InspectPrArgs: InspectPrArgsSchema,
  InspectPrResult: InspectPrResultSchema,
  MergePrArgs: MergePrArgsSchema,
  MergePrResult: MergePrResultSchema,
  ClosePrArgs: ClosePrArgsSchema,
  ClosePrResult: ClosePrResultSchema,
};

interface ManifestEntry {
  file: string;
  schema: string | null;
  array: boolean;
}

describe('Rust round trip parses with zod', () => {
  const manifest = readJson('fixtures/manifest.json') as ManifestEntry[];
  const typed = manifest.filter((e) => e.schema !== null);

  it('covers every typed fixture', () => {
    expect(typed.length).toBeGreaterThan(80);
    for (const e of typed) {
      expect(existsSync(new URL(`roundtrip/${e.file}`, DIR)), e.file).toBe(true);
    }
  });

  it.each(typed)('$file', (e) => {
    const schema = SCHEMAS[e.schema!];
    expect(schema, `no zod schema mapped for ${e.schema}`).toBeDefined();
    const rust = readJson(`roundtrip/${e.file}`);
    const original = readJson(`fixtures/${e.file}`);
    const parse = (v: unknown) => schema!.parse(v);
    const parsed = e.array ? (rust as unknown[]).map(parse) : parse(rust);
    expect(parsed).toEqual(original);
  });
});
