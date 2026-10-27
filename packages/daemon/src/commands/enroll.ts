import { arch, platform } from 'node:os';
import { parseArgs } from 'node:util';
import { API_PATHS, EnrollRequestSchema, EnrollResponseSchema } from '@conductor/shared';
import { daemonVersion, machineFacts, rootDirFrom, type MachineFacts } from '../config.js';
import {
  checkWritable,
  credentialPath,
  isSecureOrLoopback,
  writeCredential,
} from '../credential.js';

// `conductor-daemon enroll --url <https url> --token <token> [--force]` (M2-T04; ADR-0013
// §Enrollment, ADR-0017 §Daemon distribution): trade a one-time enrollment token for the machine
// id and credential, saved to `<root>/machine.json`. Checks the root before the request so a
// refused run doesn't spend the token. Never prints the credential or the token.

export const ENROLL_USAGE =
  'usage: conductor-daemon enroll --url <https url> --token <token> [--force]';

const ENROLL_TIMEOUT_MS = 15_000;

export interface EnrollDeps {
  env: Record<string, string | undefined>;
  facts: MachineFacts;
  fetch: typeof globalThis.fetch;
  out: (line: string) => void;
  err: (line: string) => void;
}

function defaultDeps(): EnrollDeps {
  return {
    env: process.env,
    facts: machineFacts(),
    fetch: globalThis.fetch,
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`[conductor-daemon] ${l}\n`),
  };
}

/**
 * The orchestrator URL to store (origin + path, no trailing slash), or an error. https only;
 * plain http only to a loopback host (dev and tests).
 */
export function enrollUrl(raw: string): { url: string } | { error: string } {
  if (!URL.canParse(raw)) return { error: `--url ${raw} is not a URL` };
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol) || !isSecureOrLoopback(u)) {
    return { error: `--url must be https:// (got ${u.protocol}//${u.host})` };
  }
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

/** The `code` of a JSON error body, if there is one. */
async function errorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { code?: unknown };
    return typeof body.code === 'string' ? body.code : null;
  } catch {
    return null;
  }
}

function causeOf(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timed out';
    const cause = (e as Error & { cause?: { code?: unknown; message?: unknown } }).cause;
    if (typeof cause?.code === 'string') return cause.code;
    if (typeof cause?.message === 'string') return cause.message;
    return e.message;
  }
  return String(e);
}

/** Run `enroll`; returns the exit code (0 ok, 1 failed, 2 usage). */
export async function enroll(argv: string[], deps: Partial<EnrollDeps> = {}): Promise<number> {
  const d = { ...defaultDeps(), ...deps };
  let values: { url?: string; token?: string; force?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        url: { type: 'string' },
        token: { type: 'string' },
        force: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    d.err(e instanceof Error ? e.message : String(e));
    d.err(ENROLL_USAGE);
    return 2;
  }
  if (!values.url || !values.token) {
    d.err(`missing ${!values.url ? '--url' : '--token'}`);
    d.err(ENROLL_USAGE);
    return 2;
  }
  const target = enrollUrl(values.url);
  if ('error' in target) {
    d.err(target.error);
    return 2;
  }
  const force = values.force ?? false;
  const root = rootDirFrom(d.env, d.facts);
  try {
    checkWritable(root, { force });
  } catch (e) {
    d.err(`cannot enroll: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const request = EnrollRequestSchema.safeParse({
    token: values.token,
    hostname: d.facts.hostname,
    os: platform(),
    arch: arch(),
    daemon_version: daemonVersion(d.env),
  });
  if (!request.success) {
    const fields = [...new Set(request.error.issues.map((i) => String(i.path[0] ?? '')))];
    if (fields.includes('token')) {
      d.err('--token is not a valid enrollment token (empty or longer than 512 characters)');
      d.err(ENROLL_USAGE);
      return 2;
    }
    d.err(
      `cannot enroll: this machine's ${fields.join(', ')} cannot be sent (invalid or too long)`,
    );
    return 1;
  }
  const body = request.data;
  const endpoint = new URL(API_PATHS.machinesEnroll, target.url);
  let res: Response;
  try {
    res = await d.fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ENROLL_TIMEOUT_MS),
      // Never follow a redirect: it would re-POST the one-time token to wherever it points.
      redirect: 'manual',
    });
  } catch (e) {
    d.err(`cannot reach ${target.url}: ${causeOf(e)}`);
    return 1;
  }

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    let where = 'another location';
    if (location !== null && URL.canParse(location, endpoint.href))
      where = new URL(location, endpoint).host;
    d.err(
      `enrollment failed: the server redirected to ${where} ` +
        '(conductor never follows redirects during enrollment)',
    );
    return 1;
  }
  if (res.status === 401) {
    d.err(
      'enrollment token is expired, already used or unknown: create a new one with Add a machine',
    );
    return 1;
  }
  if (res.status === 429) {
    const after = res.headers.get('retry-after');
    d.err(`too many enrollment attempts; try again${after ? ` in ${after} s` : ' later'}`);
    return 1;
  }
  if (res.status !== 201 && res.status !== 200) {
    const code = await errorCode(res);
    d.err(`enrollment failed: server returned ${res.status}${code ? ` (${code})` : ''}`);
    return 1;
  }

  let parsed;
  try {
    parsed = EnrollResponseSchema.parse(await res.json());
  } catch {
    d.err('enrollment failed: the server sent an unexpected response');
    return 1;
  }
  try {
    writeCredential(
      root,
      { url: target.url, machine_id: parsed.machine_id, credential: parsed.credential },
      { force },
    );
  } catch (e) {
    d.err(
      `enrolled as ${parsed.machine_id}, but the credential could not be saved: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }
  d.out(`enrolled as ${parsed.machine_id}; credential saved to ${credentialPath(root)}`);
  return 0;
}
