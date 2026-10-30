// MR-T03 (ADR-0026 §2): writes packages/shared/protocol-json/ from the zod schemas, so the Rust
// daemon's `crates/conductor-protocol` is generated from the same source of truth.
//
//   pnpm --filter @conductor/shared emit:protocol
//
// Runs on the built package (`tsc -b` first): Node strips this file's types, but shared's own
// sources need tsc. Writes `schemas/`, `fixtures/`, `constants.json` and `tool-policy.json`;
// `vectors/` (hand-written) and `roundtrip/` (written by `cargo nextest`) are never touched.
// scripts/ci.sh re-runs it and fails on any diff (the drift check).

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as shared from '@conductor/shared';
import * as fixtures from '../dist/protocol/fixtures.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'protocol-json');

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonSchema = { [k: string]: Json };

const pascal = (s: string) =>
  s
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');

// ---------------------------------------------------------------- named definitions
// Every schema registered here becomes a `definitions` entry with this name, so typify gives the
// Rust type the same name. The registry lives here, never in src (NFR-1).

const reg = z.registry<{ id: string }>();
const name = (schema: z.ZodType, id: string) => {
  if (!reg.has(schema)) reg.add(schema, { id });
};

name(shared.IsoDateTimeSchema, 'IsoDateTime');
name(shared.JsonObjectSchema, 'JsonObject');
name(shared.OutputStreamSchema, 'OutputStream');
name(shared.GitShaSchema, 'GitSha');
name(shared.PrUrlSchema, 'PrUrl');
name(shared.PrFilePathSchema, 'PrFilePath');
name(shared.PathGlobSchema, 'PathGlob');
name(shared.ApprovalIdSchema, 'ApprovalId');
name(shared.AbsolutePathSchema, 'AbsolutePath');
name(shared.CapabilityNameSchema, 'CapabilityName');
name(shared.WorkingCopyModeSchema, 'WorkingCopyMode');
name(shared.WorkingCopySchema, 'WorkingCopy');
name(shared.InventoryRepoSchema, 'InventoryRepo');
name(shared.CapabilitySchema, 'Capability');
name(shared.ConditionSchema, 'Condition');
name(shared.ConditionTypeSchema, 'ConditionType');
name(shared.ConditionResultSchema, 'ConditionResult');
name(shared.AgentTransitionOptionSchema, 'AgentTransitionOption');
name(shared.RepoInventoryEntrySchema, 'RepoInventoryEntry');
name(shared.TranscriptChunkSchema, 'TranscriptChunk');
name(shared.TranscriptErrorSchema, 'TranscriptError');
name(shared.PermissionBehaviorSchema, 'PermissionBehavior');
name(shared.PermissionScopeSchema, 'PermissionScope');
name(shared.PermissionToolSchema, 'PermissionTool');
name(shared.SessionEventPayloadSchema, 'SessionEventPayload');
for (const o of shared.SessionEventPayloadSchema.options) {
  name(o.shape.data, `${pascal(o.shape.kind.value)}EventData`);
}
for (const union of [shared.DaemonToOrchestratorSchema, shared.OrchestratorToDaemonSchema]) {
  for (const o of union.options) {
    const type = o.shape.type.value;
    name(o.shape.payload, `${pascal(type)}Payload`);
  }
}

/** The daemon-facing roots: one file each under `schemas/`. */
const ROOTS: Record<string, z.ZodType> = {
  DaemonToOrchestrator: shared.DaemonToOrchestratorSchema,
  OrchestratorToDaemon: shared.OrchestratorToDaemonSchema,
  SessionEventPayload: shared.SessionEventPayloadSchema,
  CompleteStateInput: shared.CompleteStateInputSchema,
  EnrollRequest: shared.EnrollRequestSchema,
  EnrollResponse: shared.EnrollResponseSchema,
  Capability: shared.CapabilitySchema,
  InventoryRepo: shared.InventoryRepoSchema,
  WorkingCopy: shared.WorkingCopySchema,
  Condition: shared.ConditionSchema,
  ConditionResult: shared.ConditionResultSchema,
  EvaluateConditionsArgs: shared.EvaluateConditionsArgsSchema,
  EvaluateConditionsResult: shared.EvaluateConditionsResultSchema,
  OpenPrArgs: shared.OpenPrArgsSchema,
  OpenPrResult: shared.OpenPrResultSchema,
  InspectPrArgs: shared.InspectPrArgsSchema,
  InspectPrResult: shared.InspectPrResultSchema,
  MergePrArgs: shared.MergePrArgsSchema,
  MergePrResult: shared.MergePrResultSchema,
  ClosePrArgs: shared.ClosePrArgsSchema,
  ClosePrResult: shared.ClosePrResultSchema,
  TranscriptChunk: shared.TranscriptChunkSchema,
  AgentTransitionOption: shared.AgentTransitionOptionSchema,
};

/** `z.json()` is a recursive lazy union; any JSON value is `{}` (serde_json::Value in Rust). */
const JSON_VALUE = 'JsonValue';

function emitSchema(rootName: string, schema: z.ZodType): JsonSchema {
  const out = z.toJSONSchema(schema, {
    // typify reads draft-07 (`definitions`), not 2020-12 (`$defs`).
    target: 'draft-7',
    // Input mode: a plain z.object gets no `additionalProperties: false` (zod strips unknown keys,
    // so serde must ignore them too); z.strictObject still does.
    io: 'input',
    metadata: reg,
    unrepresentable: 'throw',
    override: (ctx) => {
      if (ctx.zodSchema._zod.def.type === 'lazy') {
        for (const k of Object.keys(ctx.jsonSchema)) delete ctx.jsonSchema[k];
      }
    },
  }) as JsonSchema;
  // The lazy's definition gets zod's anonymous `__schemaN` name: give it a stable one.
  let text = JSON.stringify(out);
  const defs = (out.definitions ?? {}) as Record<string, Json>;
  for (const [k, v] of Object.entries(defs)) {
    if (!k.startsWith('__schema')) continue;
    if (JSON.stringify(v) !== '{}') throw new Error(`${rootName}: unnamed definition ${k}`);
    text = text.replaceAll(`"#/definitions/${k}"`, `"#/definitions/${JSON_VALUE}"`);
    text = text.replaceAll(`"${k}":`, `"${JSON_VALUE}":`);
  }
  return JSON.parse(text) as JsonSchema;
}

// ---------------------------------------------------------------- constants

const CONSTANTS = {
  PROTOCOL_VERSION: shared.PROTOCOL_VERSION,
  CLOSE_REPLACED: shared.CLOSE_REPLACED,
  CLOSE_REVOKED: shared.CLOSE_REVOKED,
  CLOSE_UNAUTHORIZED: shared.CLOSE_UNAUTHORIZED,
  CLOSE_PROTOCOL: shared.CLOSE_PROTOCOL,
  CLOSE_REASONS: shared.CLOSE_REASONS,
  DAEMON_AUTH_HEADER: shared.DAEMON_AUTH_HEADER,
  ALERT_FILES_MAX: shared.ALERT_FILES_MAX,
  STDERR_TAIL_LINES: shared.STDERR_TAIL_LINES,
  STDERR_TAIL_CHARS: shared.STDERR_TAIL_CHARS,
  NO_OUTCOME_OUTPUT_CHARS: shared.NO_OUTCOME_OUTPUT_CHARS,
  TRANSCRIPT_RESULT_CHARS: shared.TRANSCRIPT_RESULT_CHARS,
  TRANSCRIPT_MAX_BYTES: shared.TRANSCRIPT_MAX_BYTES,
  OUTPUT_TAIL_BYTES: shared.OUTPUT_TAIL_BYTES,
  TRANSITION_NAME_MAX: shared.TRANSITION_NAME_MAX,
  TRANSITION_REASON_MAX: shared.TRANSITION_REASON_MAX,
  DEFAULT_PERMISSION_TIMEOUT_MS: shared.DEFAULT_PERMISSION_TIMEOUT_MS,
  PERMISSION_INPUT_MAX_BYTES: shared.PERMISSION_INPUT_MAX_BYTES,
  PERMISSION_SUGGESTIONS_MAX: shared.PERMISSION_SUGGESTIONS_MAX,
  PERMISSION_SUGGESTIONS_MAX_BYTES: shared.PERMISSION_SUGGESTIONS_MAX_BYTES,
  PERMISSION_TOOL_MAX: shared.PERMISSION_TOOL_MAX,
  PERMISSION_MESSAGE_MAX: shared.PERMISSION_MESSAGE_MAX,
  PERMISSION_RULE_MAX: shared.PERMISSION_RULE_MAX,
  NO_CONVERSATION_REASON: shared.NO_CONVERSATION_REASON,
  COMMAND_REFUSAL_REASONS: shared.COMMAND_REFUSAL_REASONS,
  NO_PR_CHECKS_VALUE: shared.NO_PR_CHECKS_VALUE,
  AVAILABLE_CONDITION_TYPES: shared.AVAILABLE_CONDITION_TYPES,
  GH_MIN_VERSION: shared.GH_MIN_VERSION,
  DEFAULT_CONDUCTOR_PORT: shared.DEFAULT_CONDUCTOR_PORT,
  CONDUCTOR_PORT_ENV: shared.CONDUCTOR_PORT_ENV,
  /** The API_PATHS the daemon uses; a parameter is `:<name>`. */
  API_PATHS: {
    daemonWs: shared.API_PATHS.daemonWs,
    machinesEnroll: shared.API_PATHS.machinesEnroll,
    daemonDownload: shared.API_PATHS.daemonDownload(':file'),
  },
  /** RegExp sources (ECMAScript syntax). */
  GITHUB_PR_URL_RE: shared.GITHUB_PR_URL_RE.source,
  CANONICAL_REMOTE_RE: shared.CANONICAL_REMOTE_RE.source,
  CAPABILITY_NAME_RE: shared.CAPABILITY_NAME_RE.source,
};

const TOOL_POLICY = {
  base: shared.BASE_TOOL_POLICY,
  aliases: shared.TOOL_ALIASES,
};

// ---------------------------------------------------------------- fixtures

const DAEMON_TYPES = new Set<string>(shared.DAEMON_MESSAGE_TYPES);
const ORCHESTRATOR_TYPES = new Set<string>(shared.ORCHESTRATOR_MESSAGE_TYPES);

/** A WS message fixture → the direction's union, by its `type`. */
function bySide(value: unknown): string {
  const type = (value as { type?: unknown }).type;
  if (typeof type === 'string' && DAEMON_TYPES.has(type)) return 'DaemonToOrchestrator';
  if (typeof type === 'string' && ORCHESTRATOR_TYPES.has(type)) return 'OrchestratorToDaemon';
  throw new Error(`fixture with unknown message type ${String(type)}`);
}

const ACTION_FIXTURE_SCHEMAS: [RegExp, string][] = [
  [/^open_pr_result/, 'OpenPrResult'],
  [/^inspect_pr_args/, 'InspectPrArgs'],
  [/^inspect_pr_result/, 'InspectPrResult'],
  [/^merge_pr_args/, 'MergePrArgs'],
  [/^merge_pr_/, 'MergePrResult'],
  [/^close_pr_args/, 'ClosePrArgs'],
  [/^close_pr_result/, 'ClosePrResult'],
];

type Kind =
  | { kind: 'record'; schema: (key: string, value: unknown) => string }
  | { kind: 'single'; schema: string }
  | { kind: 'array'; schema: string }
  | { kind: 'data' };

/** Every export of protocol/fixtures.ts. A new export without an entry fails the emit. */
const FIXTURE_EXPORTS: Record<string, Kind> = {
  FIXTURE_IDS: { kind: 'data' },
  PERMISSION_FIXTURE_IDS: { kind: 'data' },
  M1B_PR_URL: { kind: 'data' },
  M2R_HEAD_SHA: { kind: 'data' },
  M2R_MOVED_SHA: { kind: 'data' },
  SESSION_EVENT_FIXTURES: { kind: 'record', schema: () => 'SessionEventPayload' },
  INVENTORY_REPO_FIXTURE: { kind: 'single', schema: 'InventoryRepo' },
  INVENTORY_REPO_CHECKOUT_FIXTURE: { kind: 'single', schema: 'InventoryRepo' },
  CAPABILITY_FIXTURES: { kind: 'array', schema: 'Capability' },
  SESSION_EVENT_MESSAGE_FIXTURES: { kind: 'record', schema: () => 'DaemonToOrchestrator' },
  DAEMON_FIXTURES: { kind: 'record', schema: () => 'DaemonToOrchestrator' },
  ORCHESTRATOR_FIXTURES: { kind: 'record', schema: () => 'OrchestratorToDaemon' },
  M1B_WS_FIXTURES: { kind: 'record', schema: (_k, v) => bySide(v) },
  M2_WS_FIXTURES: { kind: 'record', schema: (_k, v) => bySide(v) },
  M2R_WS_FIXTURES: { kind: 'record', schema: (_k, v) => bySide(v) },
  PERMISSION_WS_FIXTURES: { kind: 'record', schema: (_k, v) => bySide(v) },
  M2R_ACTION_FIXTURES: {
    kind: 'record',
    schema: (key) => {
      const hit = ACTION_FIXTURE_SCHEMAS.find(([re]) => re.test(key));
      if (!hit) throw new Error(`M2R_ACTION_FIXTURES.${key}: no schema`);
      return hit[1];
    },
  },
};

interface ManifestEntry {
  file: string;
  export: string;
  key: string | null;
  /** The `schemas/` root it parses as; null = plain data (ids, urls), not round-tripped. */
  schema: string | null;
  /** The file is an array of `schema`. */
  array: boolean;
}

// ---------------------------------------------------------------- write

const write = (rel: string, value: unknown) => {
  const path = join(OUT, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
};

for (const rel of ['schemas', 'fixtures', 'constants.json', 'tool-policy.json']) {
  rmSync(join(OUT, rel), { recursive: true, force: true });
}

const seenDefs = new Map<string, string>();
for (const [rootName, schema] of Object.entries(ROOTS)) {
  const out = emitSchema(rootName, schema);
  for (const [k, v] of Object.entries((out.definitions ?? {}) as Record<string, Json>)) {
    const text = JSON.stringify(v);
    const prev = seenDefs.get(k);
    if (prev !== undefined && prev !== text) {
      throw new Error(`definition ${k} differs between schema files (${rootName})`);
    }
    seenDefs.set(k, text);
  }
  write(`schemas/${rootName}.json`, out);
}

write('constants.json', CONSTANTS);
write('tool-policy.json', TOOL_POLICY);

const manifest: ManifestEntry[] = [];
const check = (schema: string, value: unknown, where: string) => {
  const root = ROOTS[schema];
  if (root === undefined) throw new Error(`${where}: unknown schema ${schema}`);
  const r = root.safeParse(value);
  if (!r.success) throw new Error(`${where} does not parse as ${schema}: ${r.error.message}`);
};
for (const exp of Object.keys(fixtures).sort()) {
  const kind = FIXTURE_EXPORTS[exp];
  if (kind === undefined) {
    throw new Error(`protocol/fixtures.ts exports ${exp}: map it in FIXTURE_EXPORTS`);
  }
  const value: unknown = (fixtures as Record<string, unknown>)[exp];
  if (kind.kind === 'record') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const schema = kind.schema(key, v);
      check(schema, v, `${exp}.${key}`);
      const file = `${exp}.${key}.json`;
      write(`fixtures/${file}`, v);
      manifest.push({ file, export: exp, key, schema, array: false });
    }
  } else {
    const file = `${exp}.json`;
    let schema: string | null = null;
    if (kind.kind === 'single') {
      schema = kind.schema;
      check(schema, value, exp);
    } else if (kind.kind === 'array') {
      schema = kind.schema;
      (value as unknown[]).forEach((v, i) => check(kind.schema, v, `${exp}[${i}]`));
    }
    write(`fixtures/${file}`, value);
    manifest.push({ file, export: exp, key: null, schema, array: kind.kind === 'array' });
  }
}
manifest.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
write('fixtures/manifest.json', manifest);

for (const exp of Object.keys(FIXTURE_EXPORTS)) {
  if (!(exp in fixtures)) throw new Error(`FIXTURE_EXPORTS.${exp} is not exported any more`);
}
console.log(
  `emit-protocol: ${Object.keys(ROOTS).length} schemas, ${manifest.length} fixture files → ${OUT}`,
);
