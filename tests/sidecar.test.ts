import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { readSidecarPart, readSourceSummary, updateSidecarPart, writeSourceSummary } from '../src/fs/sidecar.js';
import { claimsForEntities } from '../src/graph/query.js';
import { prepareDocs } from '../src/ingest/prepare.js';
import { sync } from '../src/ingest/sync.js';
import { readLedger } from '../src/lineage/ledger.js';
import { forgetSource } from '../src/lineage/purge.js';
import { rebuild } from '../src/lineage/rebuild.js';
import { findLiveScope } from '../src/lineage/scope.js';
import { flushUsageToSidecars, recordChunkHits } from '../src/stats/heat.js';

/**
 * Sidecar directories: one `.sidecar/<key>/` per source, split by lifecycle,
 * moved to the attic as a whole when the source is removed, replayable by
 * `rebuild --history`; plus the prepare step's change detection and trace
 * episodes living in the same tree.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-sidecar-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const REPORT = `---
title: 宁德时代研报
entities:
  - { name: 宁德时代, type: organization, aliases: ["300750"] }
claims:
  - { subject: 宁德时代, type: earnings, statement: 2026Q2 净利润 120 亿元, status: fact, startDate: "2026-08-10" }
---
# 宁德时代研报

宁德时代与 [[比亚迪]] 在 [[动力电池]] 市场竞争，动力电池出货量全球第一。
`;

const TRACE = [
  JSON.stringify({ type: 'user', sessionId: 's1', timestamp: '2026-09-01T00:00:00Z', message: { role: 'user', content: '查一下宁德时代' } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }, { type: 'tool_use', name: 'knode_search', input: { query: '宁德时代' } }] } }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: '3 hits' }] } }),
].join('\n');

describe('sidecar directories', () => {
  const dataDir = path.join(tmp, 'parts');
  let ctx: AppContext;

  afterAll(async () => {
    await ctx?.store.close();
  });

  it("splits a source's derived state into files that are written independently", async () => {
    initDataDir(dataDir);
    write(dataDir, 'raw/docs/a.md', REPORT);
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });

    const key = 'raw/docs/a.md';
    const dir = path.join(dataDir, '.sidecar', 'raw', 'docs', 'a.md');
    expect(fs.readdirSync(dir).sort()).toEqual(['meta.json', 'tier0.json']);
    expect(fs.existsSync(path.join(dataDir, 'cooked'))).toBe(false);
    const meta = readSidecarPart(dataDir, key, 'meta')!;
    expect(meta).toMatchObject({ version: 2, rawPath: key, sourceType: 'md', normalizer: 1 });
    // the text file is not copied; its indexed view (frontmatter normalized in memory) is only hashed
    expect(meta.contentSha256).not.toBe(meta.sourceSha256);
    expect(fs.existsSync(path.join(dir, 'content.md'))).toBe(false);
    expect(meta.chunks.length).toBeGreaterThan(0);
    expect(readSidecarPart(dataDir, key, 'tier0')).toMatchObject({ contentSha: meta.contentSha256, wikilinks: ['比亚迪', '动力电池'] });

    updateSidecarPart(dataDir, key, 'tier1', () => ({
      status: 'done',
      entities: [{ name: '曾毓群', type: 'person' }],
      relations: [],
      claims: [],
      model: 'test-model',
      contentSha: meta.contentSha256,
      extractedAt: new Date().toISOString(),
    }));
    const tier1Before = fs.readFileSync(path.join(dir, 'tier1.json'), 'utf8');
    const metaBefore = fs.readFileSync(path.join(dir, 'meta.json'), 'utf8');

    // the hourly usage flush touches usage.json and nothing else
    const [chunk] = await ctx.store.query<{ id: string; document_id: string }>(
      `SELECT c.id, c.document_id FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = $1 LIMIT 1`,
      [key],
    );
    await recordChunkHits(ctx.store, [{ chunkId: chunk.id, documentId: chunk.document_id }]);
    expect(await flushUsageToSidecars(ctx.store)).toBe(1);
    const usage = readSidecarPart(dataDir, key, 'usage')!;
    expect(usage.accessCount).toBeGreaterThanOrEqual(1);
    expect(usage.chunkHits[chunk.id]?.count).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'tier1.json'), 'utf8')).toBe(tier1Before);
    expect(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).toBe(metaBefore);

    // no sidecar → no write, no orphan directory
    expect(updateSidecarPart(dataDir, 'raw/docs/nope.md', 'usage', () => usage)).toBeNull();
    expect(fs.existsSync(path.join(dataDir, '.sidecar', 'raw', 'docs', 'nope.md'))).toBe(false);

    // cached LLM views round-trip, even when the body itself opens with a fence
    const body = '---\nnot: frontmatter\n---\n\nA summary that opens with a fence-like line.';
    writeSourceSummary(dataDir, key, { contentSha: meta.contentSha256, model: 'm', generatedAt: '2026-09-13T04:05:24.000Z', body });
    expect(readSourceSummary(dataDir, key)).toEqual({ contentSha: meta.contentSha256, model: 'm', generatedAt: '2026-09-13T04:05:24.000Z', body });
  });

  it("keeps a removed source's sidecar in the attic and replays it with rebuild --history", async () => {
    const dir = path.join(tmp, 'attic');
    initDataDir(dir);
    write(dir, 'raw/docs/a.md', REPORT);
    const c = await createContext(dir);
    try {
      await sync(c, { llmGraph: false });
      const key = 'raw/docs/a.md';
      const meta = readSidecarPart(dir, key, 'meta')!;
      updateSidecarPart(dir, key, 'tier1', () => ({
        status: 'done',
        entities: [{ name: '宁德时代', type: 'organization' }],
        relations: [],
        claims: [{ subject: '宁德时代', type: 'capacity', statement: '产能规划超过 1TWh', status: 'suspected' }],
        model: 'test-model',
        contentSha: meta.contentSha256,
        extractedAt: new Date().toISOString(),
      }));
      await sync(c, { llmGraph: false });
      expect(await findLiveScope(c.store, 'tier1', key)).not.toBeNull();
      await sleep(20);
      const t1 = new Date().toISOString();
      await sleep(20);

      const scope = (await findLiveScope(c.store, 'doc', key))!;
      fs.rmSync(path.join(dir, key));
      await sync(c, { llmGraph: false });
      const attic = path.join(dir, 'ledger', 'attic', scope.id);
      expect(fs.readdirSync(attic).sort()).toEqual(['meta.json', 'tier0.json', 'tier1.json']);
      expect(fs.existsSync(path.join(dir, '.sidecar', 'raw', 'docs', 'a.md'))).toBe(false);
      // children (the tier-1 replay) are disposed first and never atticked; the document's own dispose carries the attic id
      expect(readLedger(dir).find((e) => e.ev === 'dispose' && e.scope.kind === 'doc' && e.scope.key === key)).toMatchObject({ attic: scope.id });

      const report = await rebuild(c, { history: true });
      expect(report.historyReplayed).toBe(1);
      expect(JSON.stringify(await claimsForEntities(c.store, ['宁德时代'], 12, { asOf: t1 }))).toContain('1TWh');
      expect(await claimsForEntities(c.store, ['宁德时代'], 12)).toHaveLength(0);

      await forgetSource(c, key);
      expect(fs.existsSync(attic)).toBe(false);
    } finally {
      await c.store.close();
    }
  });

  it('re-prepares only when the bytes, the conversion or the normalizer changed', async () => {
    const dir = path.join(tmp, 'prepare');
    initDataDir(dir);
    write(dir, 'raw/docs/n.md', '# Note\n\nbody\n');
    const metaPath = path.join(dir, '.sidecar', 'raw', 'docs', 'n.md', 'meta.json');

    expect((await prepareDocs(dir)).stats).toMatchObject({ prepared: 1, unchanged: 0 });
    const bytes = fs.readFileSync(metaPath, 'utf8');
    expect((await prepareDocs(dir)).stats).toMatchObject({ prepared: 0, unchanged: 1 });
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, 'raw/docs/n.md'), later, later);
    expect((await prepareDocs(dir)).stats).toMatchObject({ prepared: 0, unchanged: 1 });
    expect(fs.readFileSync(metaPath, 'utf8')).toBe(bytes);

    const sha = readSidecarPart(dir, 'raw/docs/n.md', 'meta')!.contentSha256;
    fs.appendFileSync(path.join(dir, 'raw/docs/n.md'), 'more\n');
    expect((await prepareDocs(dir)).stats).toMatchObject({ prepared: 1, unchanged: 0 });
    const sha2 = readSidecarPart(dir, 'raw/docs/n.md', 'meta')!.contentSha256;
    expect(sha2).not.toBe(sha);

    // a normalizer bump re-prepares every text source; unchanged output keeps its hash
    expect((await prepareDocs(dir, { normalizerVersion: 99 })).stats).toMatchObject({ prepared: 1 });
    expect(readSidecarPart(dir, 'raw/docs/n.md', 'meta')).toMatchObject({ normalizer: 99, contentSha256: sha2 });

    // moved along with its file (what /api/mv does): only rawPath is rewritten
    fs.renameSync(path.join(dir, 'raw/docs/n.md'), path.join(dir, 'raw/docs/m.md'));
    fs.renameSync(path.join(dir, '.sidecar', 'raw', 'docs', 'n.md'), path.join(dir, '.sidecar', 'raw', 'docs', 'm.md'));
    expect((await prepareDocs(dir, { normalizerVersion: 99 })).stats).toMatchObject({ prepared: 0, unchanged: 1 });
    expect(readSidecarPart(dir, 'raw/docs/m.md', 'meta')).toMatchObject({ rawPath: 'raw/docs/m.md', contentSha256: sha2 });
  });

  it('reaches the same result whatever the conversion concurrency is', async () => {
    const dir = path.join(tmp, 'prepare-parallel');
    initDataDir(dir);
    for (let n = 0; n < 6; n++) write(dir, `raw/docs/p${n}.md`, `# Note ${n}\n\nbody ${n}\n`);

    const serial = await prepareDocs(dir);
    expect(serial.stats).toMatchObject({ prepared: 6, unchanged: 0, errors: 0 });

    // a second pass finds everything unchanged whether or not it fans out, and
    // reports the same wanted set in the same order
    const parallel = await prepareDocs(dir, { concurrency: 4 });
    expect(parallel.stats).toMatchObject({ prepared: 0, unchanged: 6, errors: 0 });
    expect([...parallel.wanted.entries()].sort()).toEqual([...serial.wanted.entries()].sort());
    expect(parallel.failed.size).toBe(0);
  });

  it('prepares trace episodes in the sidecar tree, keyed by the transcript, and drops them when switched off', async () => {
    const dir = path.join(tmp, 'episodes');
    initDataDir(dir);
    const config = loadConfig(dir);
    config.trace.episodes = true;
    saveConfig(dir, config);
    write(dir, 'raw/traces/claude/p/s.jsonl', TRACE);
    const c = await createContext(dir);
    try {
      await sync(c, { llmGraph: false });
      const key = 'raw/traces/claude/p/s.jsonl';
      const docs = await c.store.query<{ path: string; root: string }>(`SELECT path, root FROM documents WHERE root = 'traces'`);
      expect(docs).toEqual([{ path: key, root: 'traces' }]);
      const [chunk] = await c.store.query<{ content: string }>(
        `SELECT c.content FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = $1 ORDER BY c.seq LIMIT 1`,
        [key],
      );
      expect(chunk.content).toContain('查一下宁德时代');
      const sidecar = path.join(dir, '.sidecar', 'raw', 'traces', 'claude', 'p', 's.jsonl');
      expect(fs.readdirSync(sidecar).sort()).toEqual(['content.md', 'meta.json']);
      expect(fs.existsSync(path.join(dir, 'cooked'))).toBe(false);

      c.config.trace.episodes = false;
      await sync(c, { llmGraph: false });
      expect(await findLiveScope(c.store, 'doc', key)).toBeNull();
      expect(fs.existsSync(sidecar)).toBe(false);
      expect(readLedger(dir).find((e) => e.ev === 'dispose' && e.scope.key === key)).toMatchObject({ attic: null });
    } finally {
      await c.store.close();
    }
  });

  it('never indexes a transcript as a document while episodes are off', async () => {
    const dir = path.join(tmp, 'no-episodes');
    initDataDir(dir);
    write(dir, 'raw/traces/claude/p/s.jsonl', TRACE);
    const c = await createContext(dir);
    try {
      await sync(c, { llmGraph: false });
      expect(await c.store.query(`SELECT path FROM documents WHERE path LIKE 'raw/traces/%'`)).toEqual([]);
      expect(fs.existsSync(path.join(dir, '.sidecar', 'raw', 'traces'))).toBe(false);
    } finally {
      await c.store.close();
    }
  });
});
