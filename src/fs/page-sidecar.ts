import fs from 'node:fs';
import path from 'node:path';
import { safePath } from './files.js';
import { sidecarRelFor } from './layout.js';
import { cacheString, readMarkdownCache, writeMarkdownCache } from './sidecar.js';

/**
 * Caches for LLM-generated wiki pages that have no owning document sidecar
 * (concept clusters). Stored as `.sidecar/<page path>/render.md`, keyed by the
 * page's inputs fingerprint, so a rebuild or a regeneration with unchanged
 * inputs never re-pays the model.
 */

export interface PageCache {
  inputsSha: string;
  model: string;
  body: string;
  generatedAt: string;
}

const RENDER_FILE = 'render.md';

function cachePath(dataDir: string, pagePath: string): string {
  return safePath(dataDir, `${sidecarRelFor(pagePath)}/${RENDER_FILE}`);
}

export function readPageCache(dataDir: string, pagePath: string): PageCache | null {
  const cache = readMarkdownCache(cachePath(dataDir, pagePath));
  if (!cache) return null;
  const inputsSha = cacheString(cache.frontmatter.inputsSha);
  const model = cacheString(cache.frontmatter.model);
  const generatedAt = cacheString(cache.frontmatter.generatedAt);
  if (inputsSha === null || model === null || generatedAt === null) return null;
  return { inputsSha, model, generatedAt, body: cache.body };
}

export function writePageCache(dataDir: string, pagePath: string, cache: PageCache): void {
  writeMarkdownCache(cachePath(dataDir, pagePath), { inputsSha: cache.inputsSha, model: cache.model, generatedAt: cache.generatedAt }, cache.body);
}

export function removePageCache(dataDir: string, pagePath: string): void {
  const abs = cachePath(dataDir, pagePath);
  fs.rmSync(abs, { force: true });
  try {
    fs.rmdirSync(path.dirname(abs));
  } catch {
    /* not empty or already gone */
  }
}
