import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_PATHS, EnrollRequestSchema } from '@conductor/shared';
import { daemonVersion } from '../config.js';
import { loadCredential } from '../credential.js';
import { assertOwnerOnly, mkdirPrivate } from '../platform/index.js';
import { enroll, enrollUrl } from './enroll.js';

const onWin32 = process.platform === 'win32';

/** 0600 file / 0700 dir on POSIX; an owner-only DACL on win32 (ADR-0024 §3). */
function expectPrivate(path: string, kind: 'file' | 'dir'): void {
  if (onWin32) assertOwnerOnly(path, { kind });
  else expect(statSync(path).mode & 0o777).toBe(kind === 'file' ? 0o600 : 0o700);
}

// M2-T04 acceptance: `enroll` against a stub HTTP server.

const CREDENTIAL = 'cred-0123456789abcdef-secret';
const TOKEN = 'tok-one-time-abcdef';

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

let tmp: string;
let server: Server;
let base: string;
let handler: Handler;
let requests: { method: string; url: string; body: string }[];
let out: string[];
let err: string[];

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'conductor-enroll-'));
  mkdirPrivate(tmp); // win32: mkdtemp under %TEMP% inherits; a private root needs a private parent
  requests = [];
  out = [];
  err = [];
  handler = (_req, _body, res) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ machine_id: 'm-123', credential: CREDENTIAL }));
  };
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
});

function run(
  args: string[],
  root = join(tmp, 'root'),
  env: Record<string, string | undefined> = {},
  stdin?: string,
) {
  return enroll(args, {
    env: { CONDUCTOR_ROOT: root, ...env },
    readStdin: () =>
      stdin === undefined
        ? Promise.reject(new Error('no stdin in this test'))
        : Promise.resolve(stdin),
    facts: { cpuTotal: 4, memTotalMb: 8192, hostname: 'test-host', home: tmp },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
}

function noSecrets(): void {
  const all = [...out, ...err].join('\n');
  expect(all).not.toContain(CREDENTIAL);
  expect(all).not.toContain(TOKEN);
}

describe('conductor-daemon enroll', () => {
  it('posts the token and writes machine.json 0600 in a 0700 root', async () => {
    const root = join(tmp, 'root');
    expect(
      await run(['--url', `${base}/`, '--token', TOKEN], root, { CONDUCTOR_BUILD_SHA: 'abc' }),
    ).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toBe(API_PATHS.machinesEnroll);
    const body = EnrollRequestSchema.parse(JSON.parse(requests[0]!.body));
    expect(body).toMatchObject({
      token: TOKEN,
      hostname: 'test-host',
      daemon_version: `${daemonVersion({})}+abc`,
    });

    const file = join(root, 'machine.json');
    expectPrivate(file, 'file');
    expectPrivate(root, 'dir');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      url: base,
      machine_id: 'm-123',
      credential: CREDENTIAL,
    });
    expect(loadCredential(root)).toEqual({
      url: base,
      machine_id: 'm-123',
      credential: CREDENTIAL,
    });
    expect(out.join('\n')).toContain('enrolled as m-123');
    noSecrets();
  });

  it('a 401 leaves no file and says the token is expired or used', async () => {
    handler = (_req, _body, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'unauthorized', message: 'nope' }));
    };
    const root = join(tmp, 'root');
    expect(await run(['--url', base, '--token', TOKEN], root)).toBe(1);
    expect(existsSync(join(root, 'machine.json'))).toBe(false);
    expect(err.join('\n')).toMatch(/expired, already used or unknown/);
    noSecrets();
  });

  it('refuses an existing file without --force (no request sent) and replaces it with --force', async () => {
    const root = join(tmp, 'root');
    expect(await run(['--url', base, '--token', TOKEN], root)).toBe(0);
    const file = join(root, 'machine.json');
    const before = readFileSync(file, 'utf8');
    handler = (_req, _body, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ machine_id: 'm-456', credential: `${CREDENTIAL}-2` }));
    };

    expect(await run(['--url', base, '--token', TOKEN], root)).toBe(1);
    expect(requests).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(err.join('\n')).toMatch(/already exists.*--force/);

    expect(await run(['--url', base, '--token', TOKEN, '--force'], root)).toBe(0);
    expect(requests).toHaveLength(2);
    expect(loadCredential(root)?.machine_id).toBe('m-456');
    expectPrivate(file, 'file');
    noSecrets();
  });

  it('refuses a symlinked root without sending a request', async () => {
    const real = join(tmp, 'real');
    mkdirSync(real, { mode: 0o700 });
    const root = join(tmp, 'root');
    symlinkSync(real, root);
    expect(await run(['--url', base, '--token', TOKEN], root)).toBe(1);
    expect(requests).toHaveLength(0);
    expect(existsSync(join(real, 'machine.json'))).toBe(false);
    expect(err.join('\n')).toMatch(/symlink/);
  });

  it('refuses a symlinked machine.json even with --force', async () => {
    const root = join(tmp, 'root');
    mkdirPrivate(root);
    const target = join(tmp, 'elsewhere.json');
    writeFileSync(target, '{}');
    symlinkSync(target, join(root, 'machine.json'));
    expect(await run(['--url', base, '--token', TOKEN, '--force'], root)).toBe(1);
    expect(requests).toHaveLength(0);
    expect(readFileSync(target, 'utf8')).toBe('{}');
  });

  it('a 429 says to retry later', async () => {
    handler = (_req, _body, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '42' });
      res.end(JSON.stringify({ code: 'rate_limited', message: 'slow down' }));
    };
    expect(await run(['--url', base, '--token', TOKEN])).toBe(1);
    expect(err.join('\n')).toMatch(/too many enrollment attempts; try again in 42 s/);
    expect(existsSync(join(tmp, 'root', 'machine.json'))).toBe(false);
  });

  it('a network failure says the server cannot be reached', async () => {
    const closed = base;
    await new Promise<void>((r) => server.close(() => r()));
    server = createServer(); // afterEach closes something
    server.listen(0, '127.0.0.1');
    expect(await run(['--url', closed, '--token', TOKEN])).toBe(1);
    expect(err.join('\n')).toMatch(new RegExp(`cannot reach ${closed}: ECONNREFUSED`));
    noSecrets();
  });

  it('another status names it and its error code', async () => {
    handler = (_req, _body, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'internal', message: 'boom' }));
    };
    expect(await run(['--url', base, '--token', TOKEN])).toBe(1);
    expect(err.join('\n')).toMatch(/server returned 500 \(internal\)/);
  });

  it('never follows a redirect: the target gets no request and no file is written', async () => {
    const targetHits: string[] = [];
    const target = createServer((req, res) => {
      targetHits.push(`${req.method} ${req.url}`);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ machine_id: 'm-evil', credential: 'evil-cred' }));
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    const targetHost = `127.0.0.1:${(target.address() as AddressInfo).port}`;
    try {
      handler = (_req, _body, res) => {
        res.writeHead(307, { location: `http://${targetHost}${API_PATHS.machinesEnroll}` });
        res.end();
      };
      const root = join(tmp, 'root');
      expect(await run(['--url', base, '--token', TOKEN], root)).toBe(1);
      expect(targetHits).toEqual([]);
      expect(requests).toHaveLength(1);
      expect(existsSync(join(root, 'machine.json'))).toBe(false);
      expect(err.join('\n')).toContain(
        `enrollment failed: the server redirected to ${targetHost} ` +
          '(conductor never follows redirects during enrollment)',
      );
      noSecrets();
    } finally {
      await new Promise<void>((r) => target.close(() => r()));
    }
  });

  it('an empty or over-long --token is a usage error naming the flag', async () => {
    expect(await run(['--url', base, '--token', 'x'.repeat(513)])).toBe(2);
    expect(await run(['--url', base, '--token='])).toBe(2);
    expect(requests).toHaveLength(0);
    const msg = err.join('\n');
    expect(msg).toContain('--token is not a valid enrollment token');
    expect(msg).not.toMatch(/ZodError|\bat .*\.ts:\d+/);
  });

  it('refuses plain http to a non-loopback host and missing options', async () => {
    expect(await run(['--url', 'http://conductor.example.com', '--token', TOKEN])).toBe(2);
    expect(await run(['--url', base])).toBe(2);
    expect(await run(['--url', base, '--token', TOKEN, '--bogus'])).toBe(2);
    expect(requests).toHaveLength(0);
    expect(err.join('\n')).toMatch(/must be https/);
    expect(err.join('\n')).toMatch(/usage: conductor-daemon enroll/);
  });
});

describe('enroll token sources (TD-117)', () => {
  const sentToken = () => (JSON.parse(requests[0]?.body ?? '{}') as { token?: string }).token;
  const psWarning = () => err.filter((l) => l.includes('visible to other users (ps)'));

  it('takes the token from CONDUCTOR_ENROLL_TOKEN and removes it from the environment', async () => {
    const env: Record<string, string | undefined> = {
      CONDUCTOR_ROOT: join(tmp, 'root'),
      CONDUCTOR_ENROLL_TOKEN: TOKEN,
    };
    const code = await enroll(['--url', base], {
      env,
      facts: { cpuTotal: 4, memTotalMb: 8192, hostname: 'test-host', home: tmp },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect(code, err.join('\n')).toBe(0);
    expect(sentToken()).toBe(TOKEN);
    expect('CONDUCTOR_ENROLL_TOKEN' in env).toBe(false);
    expect(psWarning()).toEqual([]);
    expect(loadCredential(join(tmp, 'root'))?.machine_id).toBe('m-123');
    noSecrets();
  });

  it('--token wins over the environment, which is still removed', async () => {
    const env: Record<string, string | undefined> = {
      CONDUCTOR_ROOT: join(tmp, 'root'),
      CONDUCTOR_ENROLL_TOKEN: 'env-token-unused',
    };
    const code = await enroll(['--url', base, '--token', TOKEN], {
      env,
      facts: { cpuTotal: 4, memTotalMb: 8192, hostname: 'test-host', home: tmp },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect(code).toBe(0);
    expect(sentToken()).toBe(TOKEN);
    expect('CONDUCTOR_ENROLL_TOKEN' in env).toBe(false);
    // Still works, with a warning that never repeats the token.
    expect(psWarning()).toHaveLength(1);
    expect(psWarning()[0]).toContain('CONDUCTOR_ENROLL_TOKEN=<token>');
    noSecrets();
  });

  it('--token - reads the first line of stdin', async () => {
    expect(await run(['--url', base, '--token', '-'], undefined, {}, `${TOKEN}\r\nrest\n`)).toBe(0);
    expect(sentToken()).toBe(TOKEN);
    expect(psWarning()).toEqual([]);
    noSecrets();
  });

  it('an empty or over-long token from stdin or the environment is the same usage error', async () => {
    expect(await run(['--url', base, '--token', '-'], undefined, {}, '\n')).toBe(2);
    expect(await run(['--url', base, '--token', '-'], undefined, {}, 'x'.repeat(513))).toBe(2);
    expect(await run(['--url', base], undefined, { CONDUCTOR_ENROLL_TOKEN: 'x'.repeat(513) })).toBe(
      2,
    );
    expect(requests).toHaveLength(0);
    expect(err.filter((l) => l.includes('--token is not a valid enrollment token'))).toHaveLength(
      3,
    );
  });

  it('no token anywhere is a usage error naming both sources', async () => {
    expect(await run(['--url', base], undefined, { CONDUCTOR_ENROLL_TOKEN: '' })).toBe(2);
    expect(requests).toHaveLength(0);
    expect(err.join('\n')).toContain('missing --token (or CONDUCTOR_ENROLL_TOKEN)');
    expect(err.join('\n')).toMatch(/usage: conductor-daemon enroll/);
  });
});

describe('enrollUrl', () => {
  it('keeps https and loopback http, without a trailing slash', () => {
    expect(enrollUrl('https://conductor.example.com/')).toEqual({
      url: 'https://conductor.example.com',
    });
    expect(enrollUrl('http://localhost:8080')).toEqual({ url: 'http://localhost:8080' });
    expect(enrollUrl('http://[::1]:8080/')).toEqual({ url: 'http://[::1]:8080' });
    expect(enrollUrl('ftp://x')).toHaveProperty('error');
    expect(enrollUrl('not a url')).toHaveProperty('error');
  });
});
