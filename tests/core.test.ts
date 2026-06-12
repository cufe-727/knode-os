import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig, resolveSecret, saveConfig } from '../src/config.js';
import { initDataDir } from '../src/fs/datadir.js';
import { safePath, walkFiles } from '../src/fs/files.js';
import { chunkText, estimateTokens } from '../src/ingest/chunker.js';
import { LocalHashEmbeddingProvider } from '../src/ingest/embeddings.js';
import { extractWikilinks, slugify } from '../src/graph/extract.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('config', () => {
  it('merges saved config over defaults', () => {
    const dir = path.join(tmp, 'cfg');
    fs.mkdirSync(dir, { recursive: true });
    const cfg = defaultConfig();
    cfg.server.port = 1234;
    saveConfig(dir, cfg);
    const loaded = loadConfig(dir);
    expect(loaded.server.port).toBe(1234);
    expect(loaded.embedding.dimensions).toBe(384);
  });

  it('resolves env: secrets', () => {
    process.env.KNODE_TEST_KEY = 'abc';
    expect(resolveSecret('env:KNODE_TEST_KEY')).toBe('abc');
    expect(resolveSecret('plain')).toBe('plain');
  });
});

describe('datadir', () => {
  it('creates the raw/wiki layout idempotently', () => {
    const dir = path.join(tmp, 'data');
    const first = initDataDir(dir);
    expect(first.created).toContain('raw/docs/');
    expect(first.created).toContain('wiki/index.md');
    const second = initDataDir(dir);
    expect(second.created).toHaveLength(0);
  });
});

describe('safePath', () => {
  it('rejects traversal', () => {
    expect(() => safePath(tmp, '../etc/passwd')).toThrow(/escapes/);
    expect(() => safePath(tmp, 'a/../../b')).toThrow(/escapes/);
    expect(safePath(tmp, 'wiki/index.md')).toBe(path.join(tmp, 'wiki/index.md'));
  });
});

describe('chunker', () => {
  it('splits markdown into chunks under the size limit', async () => {
    const text = Array.from({ length: 40 }, (_, i) => `## Section ${i}\n\n${'word '.repeat(60)}`).join('\n\n');
    const chunks = await chunkText('doc.md', text, { chunkSize: 500, chunkOverlap: 50 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(600);
  });

  it('estimates CJK tokens more densely than ASCII', () => {
    expect(estimateTokens('中文中文中文')).toBeGreaterThan(estimateTokens('aaaaaa'));
  });
});

describe('local embedding', () => {
  it('is deterministic, normalized, and ranks related text higher', async () => {
    const e = new LocalHashEmbeddingProvider(256);
    const [a1, a2, b] = await e.embed(['postgres vector database', 'postgres vector index', 'cooking pasta recipes']);
    const [a1b] = await e.embed(['postgres vector database']);
    expect(a1).toEqual(a1b);
    const norm = Math.sqrt(a1.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
    expect(cos(a1, a2)).toBeGreaterThan(cos(a1, b));
  });
});

describe('graph extraction', () => {
  it('extracts wikilinks including aliases and headings', () => {
    const links = extractWikilinks('see [[PGlite]] and [[Electric SQL|electric]] plus [[Page#Section]] and [[PGlite]] again');
    expect(links).toEqual(['PGlite', 'Electric SQL', 'Page']);
  });

  it('slugifies names including CJK', () => {
    expect(slugify('Electric SQL')).toBe('electric-sql');
    expect(slugify('知识图谱')).toBe('知识图谱');
    expect(slugify('  PGlite!! ')).toBe('pglite');
  });
});

describe('walkFiles', () => {
  it('lists files recursively with posix paths', () => {
    const dir = path.join(tmp, 'walk');
    fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a/b/c.md'), 'x');
    const files = walkFiles(tmp, 'walk');
    expect(files).toEqual(['walk/a/b/c.md']);
  });
});
