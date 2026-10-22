import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// M1-T07: the orchestrator serves the built web app (01 §Deployment: "a static React app served
// by the orchestrator"). The API (T08) owns `/api/*` and the gateway (T11) the `/ws/*` upgrades;
// every other GET/HEAD is a file from `packages/web/dist` (vite build), and a path with no file
// extension that matches no file gets `index.html` (client-side routes). Anything else is left
// to the API server (its JSON 404).

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

/** Whether `dir` holds a built web app (an `index.html`). */
export function hasWebApp(dir: string): boolean {
  return isFile(join(dir, 'index.html'));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The file under `root` for a request path, or null (outside root, or not a file). */
export function resolveWebFile(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const base = resolve(root);
  const file = resolve(base, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  const rel = relative(base, file);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  if (rel === '') return join(base, 'index.html');
  if (isFile(file)) return file;
  // A client-side route (no extension): the app shell.
  if (extname(file) === '') return join(base, 'index.html');
  return null;
}

/**
 * Serve `dir` on `server` in front of its existing request listeners (Fastify's). Call once,
 * after the API server is created and before it listens.
 */
export function serveWebApp(server: Server, dir: string): void {
  const root = resolve(dir);
  const inner = server.listeners('request') as RequestListener[];
  server.removeAllListeners('request');
  const delegate: RequestListener = (req, res) => {
    for (const l of inner) l.call(server, req, res);
  };
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const own =
      (method === 'GET' || method === 'HEAD') &&
      pathname !== '/api' &&
      !pathname.startsWith('/api/') &&
      !pathname.startsWith('/ws/');
    const file = own ? resolveWebFile(root, pathname) : null;
    if (file === null || !isFile(file)) {
      delegate(req, res);
      return;
    }
    const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const size = statSync(file).size;
    res.writeHead(200, {
      'content-type': type,
      'content-length': size,
      // Vite fingerprints everything under assets/; the shell must always be revalidated.
      'cache-control': file.includes(`${sep}assets${sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  });
}
