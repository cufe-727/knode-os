import fs from 'node:fs';
import path from 'node:path';
import { safePath } from './files.js';

/**
 * Caches for LLM-generated wiki pages that have no owning document sidecar
 * (concept clusters). Stored under cooked/<page path>.knode.json, keyed by the
 * page's inputs fingerprint, so a rebuild or a regeneration with unchanged
 * inputs never re-pays the model.
 */

export interface PageCache {
  inputsSha: string;
  model: string;
  body: string;
  generatedAt: string;
}

function cachePath(dataDir: string, pagePath: string): string {
  return safePath(dataDir, `cooked/${pagePath}.knode.json`);
}

export function readPageCache(dataDir: string, pagePath: string): PageCache | null {
  const abs = cachePath(dataDir, pagePath);
  if (!fs.existsSync(abs)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8')) as PageCache;
    return parsed && typeof parsed.body === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function writePageCache(dataDir: string, pagePath: string, cache: PageCache): void {
  const abs = cachePath(dataDir, pagePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n');
  fs.renameSync(tmp, abs);
}

export function removePageCache(dataDir: string, pagePath: string): void {
  fs.rmSync(cachePath(dataDir, pagePath), { force: true });
}
