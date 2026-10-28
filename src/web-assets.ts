import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Where the web UI's files are: the folder `serve` answers the browser from,
 * and marked's browser bundle beside it. The study export (src/web-render.ts)
 * runs the same files on the server.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

export function findWebDir(): string | null {
  for (const candidate of [
    path.resolve(here, '../web'), // src/ or dist/ → package root
    path.resolve(here, '../../web'),
    path.resolve(process.cwd(), 'web'),
  ]) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

export function findMarkedUmd(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('marked'); // .../marked/lib/marked.cjs
    for (const name of ['marked.umd.js', 'marked.cjs']) {
      const p = path.join(path.dirname(entry), name);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* not installed */
  }
  return null;
}
