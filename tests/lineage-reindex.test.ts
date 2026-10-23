import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEGMENTER_VERSION } from '../src/constants.js';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { readSidecarPart, updateSidecarPart, writeSourceSummary } from '../src/fs/sidecar.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { prepareDocs } from '../src/ingest/prepare.js';
import { sync } from '../src/ingest/sync.js';
import { readLedger } from '../src/lineage/ledger.js';
import { archivedPath, disposeScope, findLiveScope } from '../src/lineage/scope.js';
import { search } from '../src/search/search.js';
import { BackendTx } from '../src/store/backend.js';
import { Store, TX_ATTEMPTS } from '../src/store/db.js';
import { regeneratePage } from '../src/wiki/pages.js';

/**
 * Re-indexing a changed document (src/lineage/scope.ts applyScope) and what a
 * failed one leaves behind. On 2026-10-17 re-indexes that lost a Postgres
 * deadlock against concurrent tier-1 writes left documents with no live scope
 * but their old chunks and embeddings, and once the files were removed no
 * sync ever touched them again; the sweep after that deleted their sidecars,
 * paid extraction included.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-reindex-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const report = (title: string, company: string, statement: string) => `---
title: ${title}
entities:
  - { name: ${company}, type: organization }
claims:
  - { subject: ${company}, type: earnings, statement: ${statement}, status: fact, startDate: "2026-08-10" }
---
# ${title}

${company} 与 [[动力电池]] 行业的最新进展：${statement}。
`;

async function count(store: Store, sql: string, params: unknown[] = []): Promise<number> {
  const [row] = await store.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params);
  return row.n;
}

async function chunkIds(store: Store, key: string): Promise<string[]> {
  const rows = await store.query<{ id: string }>(
    `SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = $1 ORDER BY c.id`,
    [key],
  );
  return rows.map((r) => r.id);
}

async function embedded(store: Store, ids: string[]): Promise<number> {
  return ids.length === 0 ? 0 : count(store, `embeddings WHERE chunk_id = ANY($1::text[])`, [ids]);
}

async function pageStatus(store: Store, pagePath: string): Promise<string | undefined> {
  return (await store.query<{ status: string }>(`SELECT status FROM pages WHERE path = $1`, [pagePath]))[0]?.status;
}

/** A source-summary page for `key`, rendered from a cached summary (no model call), that requires the document. */
async function summaryPage(ctx: AppContext, key: string): Promise<string> {
  const meta = readSidecarPart(ctx.dataDir, key, 'meta')!;
  writeSourceSummary(ctx.dataDir, key, { contentSha: meta.contentSha256, model: 'test-model', generatedAt: new Date().toISOString(), body: `Summary of ${key}.` });
  const pagePath = `wiki/sources/${path.posix.basename(key, '.md')}.md`;
  expect(await regeneratePage(ctx, pagePath, 'source_summary', { hint: { documentPath: key } })).toBe('regenerated');
  expect(await pageStatus(ctx.store, pagePath)).toBe('active');
  return pagePath;
}

/** A finished tier-1 extraction of the document's current content, as the tier-1 pass writes it. */
function paidExtraction(dataDir: string, key: string, extractedAt = new Date().toISOString()): void {
  const meta = readSidecarPart(dataDir, key, 'meta')!;
  updateSidecarPart(dataDir, key, 'tier1', () => ({
    status: 'done',
    entities: [{ name: '曾毓群', type: 'person', description: '董事长' }],
    relations: [],
    claims: [],
    model: 'test-model',
    contentSha: meta.contentSha256,
    extractedAt,
    segmenter: SEGMENTER_VERSION,
  }));
}

/**
 * Fail statements matching `match` inside transactions with Postgres's
 * deadlock error, `times` times over — PGlite has one connection and never
 * deadlocks by itself.
 */
function injectDeadlocks(store: Store, match: RegExp, times: number): { thrown: number; restore: () => void } {
  const db = store.db;
  const transaction = db.transaction;
  const fault = { thrown: 0, restore: () => void (db.transaction = transaction) };
  db.transaction = <T,>(fn: (tx: BackendTx) => Promise<T>): Promise<T> =>
    transaction.call(db, (tx: BackendTx) =>
      fn({
        query: async <R,>(sql: string, params?: unknown[]) => {
          if (fault.thrown < times && match.test(sql)) {
            fault.thrown++;
            throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
          }
          return tx.query<R>(sql, params);
        },
        exec: (sql: string) => tx.exec(sql),
      }),
    ) as Promise<T>;
  return fault;
}

class CountingEmbedder implements EmbeddingProvider {
  texts = 0;
  constructor(private readonly inner: EmbeddingProvider) {}
  get model() { return this.inner.model; }
  get dimensions() { return this.inner.dimensions; }
  async embed(texts: string[]): Promise<number[][]> {
    this.texts += texts.length;
    return this.inner.embed(texts);
  }
}

describe('re-indexing a changed document', () => {
  const dataDir = path.join(tmp, 'ws');
  let ctx: AppContext;
  let store: Store;

  beforeAll(async () => {
    initDataDir(dataDir);
    ctx = await createContext(dataDir);
    // the reports here are a few lines each: no size threshold, or they would get no summary page
    ctx.config.extraction.summaryMinChars = 0;
    store = ctx.store;
  });
  afterAll(async () => {
    await ctx?.store.close();
  });

  it('runs a re-index that lost a deadlock again, and counts it once', async () => {
    const key = 'raw/docs/a.md';
    const v1 = report('宁德时代研报', '宁德时代', '2026Q2 净利润 120 亿元');
    const v2 = `${v1}\n补充：产能持续扩张。\n`;
    write(dataDir, key, v1);
    await sync(ctx, { llmGraph: false });
    const before = (await findLiveScope(store, 'doc', key))!;

    write(dataDir, key, v2);
    const fault = injectDeadlocks(store, /INSERT INTO chunks/, 1);
    const s = await sync(ctx, { llmGraph: false }).finally(fault.restore);
    expect(fault.thrown).toBe(1);
    expect(s).toMatchObject({ errors: 0, applied: 1 });

    // one replace: the old version disposed once, the new one applied once
    const after = (await findLiveScope(store, 'doc', key))!;
    expect(after.id).not.toBe(before.id);
    expect(await count(store, `scopes WHERE kind = 'doc' AND key = $1`, [key])).toBe(2);
    const events = readLedger(dataDir).filter((e) => (e.ev === 'apply' || e.ev === 'dispose') && e.scope.kind === 'doc' && e.scope.key === key);
    expect(events.map((e) => e.ev)).toEqual(['apply', 'dispose', 'apply']);
    // the rolled-back attempt took no ledger numbers with it
    expect(readLedger(dataDir).map((e) => e.seq)).toEqual(readLedger(dataDir).map((_, i) => i + 1));

    // the same change without a fault reports the same numbers
    write(dataDir, key, v1);
    await sync(ctx, { llmGraph: false });
    write(dataDir, key, v2);
    const clean = await sync(ctx, { llmGraph: false });
    expect({ chunks: s.chunks, entities: s.entities, relations: s.relations }).toEqual({ chunks: clean.chunks, entities: clean.entities, relations: clean.relations });
  });

  it('keeps the previous version live when a re-index keeps failing, and disposes it with its file', async () => {
    const key = 'raw/docs/b.md';
    write(dataDir, key, report('比亚迪快讯', '比亚迪', '刀片电池装机量增长'));
    await sync(ctx, { llmGraph: false });
    const pagePath = await summaryPage(ctx, key);
    const old = (await findLiveScope(store, 'doc', key))!;
    const chunks = await chunkIds(store, key);
    expect(chunks.length).toBeGreaterThan(0);

    write(dataDir, key, report('比亚迪快讯', '比亚迪', '刀片电池装机量增长，海外销量翻倍'));
    const fault = injectDeadlocks(store, /INSERT INTO chunks/, Infinity);
    const s = await sync(ctx, { llmGraph: false }).finally(fault.restore);
    expect(s.errors).toBe(1);

    // nothing half done: the old version is still the live one, projection and evidence included
    expect((await findLiveScope(store, 'doc', key))?.id).toBe(old.id);
    expect(fault.thrown).toBe(TX_ATTEMPTS);
    expect(await chunkIds(store, key)).toEqual(chunks);
    expect(await embedded(store, chunks)).toBe(chunks.length);
    expect(await count(store, `evidence WHERE scope_id = $1 AND tx_to IS NULL`, [old.id])).toBeGreaterThan(0);
    const [row] = await store.query<{ status: string; error: string | null }>(`SELECT status, error FROM documents WHERE path = $1`, [key]);
    expect(row.status).toBe('indexed');
    expect(row.error).toContain('deadlock detected');
    expect((await search(store, ctx.embedder, '比亚迪 刀片电池', { k: 5, track: false })).map((h) => h.path)).toContain(key);
    expect(await pageStatus(store, pagePath)).toBe('active');

    // the file goes: disposed like any removed source
    fs.rmSync(path.join(dataDir, key));
    const r = await sync(ctx, { llmGraph: false });
    expect(r.disposed).toBe(1);
    expect(await chunkIds(store, key)).toEqual([]);
    expect(await embedded(store, chunks)).toBe(0);
    expect(await pageStatus(store, pagePath)).toBe('archived');
    expect(fs.existsSync(path.join(dataDir, pagePath))).toBe(false);
  });

  it('drops the projection an earlier failed re-index left once its file is gone, and keeps the paid extraction', async () => {
    const key = 'raw/docs/c.md';
    write(dataDir, key, report('赣锋锂业点评', '赣锋锂业', '锂盐产能释放'));
    await sync(ctx, { llmGraph: false });
    const pagePath = await summaryPage(ctx, key);
    const last = (await findLiveScope(store, 'doc', key))!;
    const chunks = await chunkIds(store, key);

    // what a failed re-index left while a replace was two transactions: the
    // old version disposed as 'replaced' (keeping its projection for the new
    // one), the new version rolled back, the row marked 'error'
    await disposeScope(store, last.id, { actor: 'sync', reason: 'replaced', keepProjection: true });
    await store.query(`UPDATE documents SET status = 'error', error = 'deadlock detected' WHERE path = $1`, [key]);
    expect(await findLiveScope(store, 'doc', key)).toBeNull();
    expect(await chunkIds(store, key)).toEqual(chunks);
    expect(await embedded(store, chunks)).toBe(chunks.length);
    // a tier-1 extraction finished for it meanwhile: written to the sidecar, with no live scope to apply it to
    paidExtraction(dataDir, key);

    fs.rmSync(path.join(dataDir, key));
    const s = await sync(ctx, { llmGraph: false });
    expect(s).toMatchObject({ removed: 1, disposed: 0, errors: 0 });

    // the projection is gone and the row tombstoned, as a dispose would have left them
    expect(await chunkIds(store, key)).toEqual([]);
    expect(await embedded(store, chunks)).toBe(0);
    const [row] = await store.query<{ status: string; scope_id: string | null }>(`SELECT status, scope_id FROM documents WHERE path = $1`, [key]);
    expect(row).toMatchObject({ status: 'disposed', scope_id: null });
    // the page that required the document is archived
    expect(await pageStatus(store, pagePath)).toBe('archived');
    expect(fs.existsSync(path.join(dataDir, pagePath))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, archivedPath(pagePath)))).toBe(true);
    // the sidecar went to the attic under the document's last scope, paid extraction and all
    expect(fs.existsSync(path.join(dataDir, '.sidecar', key))).toBe(false);
    const attic = path.join(dataDir, 'ledger', 'attic', last.id);
    expect(fs.readdirSync(attic)).toEqual(expect.arrayContaining(['meta.json', 'tier1.json']));
    expect(JSON.parse(fs.readFileSync(path.join(attic, 'tier1.json'), 'utf8'))).toMatchObject({ status: 'done', model: 'test-model' });
    // and the removal is on record with its attic entry, which is what rebuild --history replays from
    const disposals = readLedger(dataDir).filter((e) => e.ev === 'dispose' && e.scope.id === last.id);
    expect(disposals).toMatchObject([{ reason: 'replaced', attic: null }, { reason: 'removed', attic: last.id }]);

    // nothing is left for the next sync
    const again = await sync(ctx, { llmGraph: false });
    expect(again.removed).toBe(0);
    expect(fs.existsSync(attic)).toBe(true);
  });

  it('never deletes an orphaned sidecar that holds paid extraction', async () => {
    // sidecars whose originals were never applied here (prepared, then removed
    // before a sync, or copied in from another machine): no scope to file them under
    const paid = 'raw/docs/copied.md';
    const plain = 'raw/docs/plain.md';
    write(dataDir, paid, report('天齐锂业', '天齐锂业', '锂矿自给率提升'));
    write(dataDir, plain, '# 笔记\n\n没有付费内容。\n');
    await prepareDocs(dataDir);
    paidExtraction(dataDir, paid);
    fs.rmSync(path.join(dataDir, paid));
    fs.rmSync(path.join(dataDir, plain));

    await sync(ctx, { llmGraph: false });
    expect(readSidecarPart(dataDir, paid, 'tier1')).toMatchObject({ status: 'done' });
    expect(fs.existsSync(path.join(dataDir, '.sidecar', plain))).toBe(false);
  });

  it("keeps a document's projection when its tier-1 child is replaced, and its embeddings when it changes", async () => {
    const key = 'raw/docs/long.md';
    const para = (i: number) => `Paragraph ${i}: [[Lineage]] keeps evidence composable over time. `.repeat(10);
    write(dataDir, key, `# Long\n\n${Array.from({ length: 6 }, (_, i) => para(i)).join('\n\n')}\n`);
    await sync(ctx, { llmGraph: false });
    paidExtraction(dataDir, key);
    await sync(ctx, { llmGraph: false });
    const doc = (await findLiveScope(store, 'doc', key))!;
    const tier1 = (await findLiveScope(store, 'tier1', key))!;
    const chunks = await chunkIds(store, key);
    expect(chunks.length).toBeGreaterThan(1);

    // a fresh extraction of the same content replaces the tier-1 child; the
    // document's chunks are the document scope's, not the child's
    paidExtraction(dataDir, key, new Date(Date.now() + 1000).toISOString());
    expect((await sync(ctx, { llmGraph: false })).errors).toBe(0);
    expect((await findLiveScope(store, 'tier1', key))?.id).not.toBe(tier1.id);
    expect((await findLiveScope(store, 'doc', key))?.id).toBe(doc.id);
    expect(await chunkIds(store, key)).toEqual(chunks);
    expect(await embedded(store, chunks)).toBe(chunks.length);
    const [row] = await store.query<{ status: string; scope_id: string }>(`SELECT status, scope_id FROM documents WHERE path = $1`, [key]);
    expect(row).toEqual({ status: 'indexed', scope_id: doc.id });
    expect(await count(store, `entity_mentions WHERE scope_id = $1`, [(await findLiveScope(store, 'tier1', key))!.id])).toBeGreaterThan(0);

    // a change disposes the child with the document: the unchanged chunks keep their embeddings
    const counting = new CountingEmbedder(ctx.embedder);
    const embedder = ctx.embedder;
    ctx.embedder = counting;
    try {
      fs.appendFileSync(path.join(dataDir, key), `\n\n${para(99)}\n`);
      expect((await sync(ctx, { llmGraph: false })).applied).toBe(1);
    } finally {
      ctx.embedder = embedder;
    }
    const after = await chunkIds(store, key);
    expect(after.length).toBeGreaterThan(chunks.length);
    expect(counting.texts).toBe(after.filter((id) => !chunks.includes(id)).length);
    expect(await embedded(store, after)).toBe(after.length);
  });
});
