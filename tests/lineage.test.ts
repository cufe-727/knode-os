import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { DuckDBInstance } from '@duckdb/node-api';
import { loadConfig, saveConfig } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { readSidecar, updateSidecar } from '../src/fs/sidecar.js';
import { claimsForEntities, graphSearch } from '../src/graph/query.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { sync } from '../src/ingest/sync.js';
import { readLedger } from '../src/lineage/ledger.js';
import { historyOf, lineageOf } from '../src/lineage/inspect.js';
import { forgetSource } from '../src/lineage/purge.js';
import { rebuild } from '../src/lineage/rebuild.js';
import { findLiveScope } from '../src/lineage/scope.js';
import { search } from '../src/search/search.js';
import { Store } from '../src/store/db.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/store/migrations.js';
import { generateWiki } from '../src/wiki/generate.js';
import { splitRegions } from '../src/wiki/regions.js';
import { listDatasets } from '../src/store/queries.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-lineage-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const REPORT_A = `---
title: 宁德时代研报
entities:
  - { name: 宁德时代, type: organization, aliases: ["300750"] }
claims:
  - { subject: 宁德时代, type: earnings, statement: 2026Q2 净利润 120 亿元, status: fact, startDate: "2026-08-10" }
---
# 宁德时代研报

宁德时代与 [[比亚迪]] 在 [[动力电池]] 市场竞争，动力电池出货量全球第一。
`;

const REPORT_B = `---
title: 宁德时代快讯
entities:
  - { name: 宁德时代, type: organization }
claims:
  - { subject: 宁德时代, type: earnings, statement: 2026Q2 净利润 120 亿元, status: disputed, startDate: "2026-08-12" }
---
# 宁德时代快讯

快讯：宁德时代业绩修正，[[比亚迪]] 同期增长。
`;

async function liveEvidence(store: Store, kind: string, id: string): Promise<{ scope_key: string; extractor: string; weight: number }[]> {
  return store.query(
    `SELECT s.key AS scope_key, ev.extractor, ev.weight FROM evidence ev JOIN scopes s ON s.id = ev.scope_id
     WHERE ev.kind = $1 AND ev.target_id = $2 AND ev.tx_to IS NULL ORDER BY s.key, ev.extractor`,
    [kind, id],
  );
}

async function entityRow(store: Store, id: string) {
  const [row] = await store.query<{ id: string; tx_to: string | null; wiki_path: string | null; evidence_count: number; mention_count: number; name: string }>(
    `SELECT id, tx_to, wiki_path, evidence_count, mention_count, name FROM entities WHERE id = $1`,
    [id],
  );
  return row;
}

async function count(store: Store, sql: string, params: unknown[] = []): Promise<number> {
  const [row] = await store.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params);
  return row.n;
}

async function snapshotGraph(store: Store) {
  const entities = await store.query(`SELECT id, name, type, description, aliases, wiki_path, mention_count, evidence_count, (tx_to IS NULL) AS live FROM entities ORDER BY id`);
  const relations = await store.query(`SELECT id, source_id, target_id, type, round(weight::numeric, 3)::float AS weight, evidence_count, (tx_to IS NULL) AS live FROM relations ORDER BY id`);
  const claims = await store.query(`SELECT id, subject_id, statement, status, type, valid_from, valid_to, evidence_count, (tx_to IS NULL) AS live FROM claims ORDER BY id`);
  const evidence = await store.query(
    `SELECT ev.kind, ev.target_id, s.key AS scope_key, ev.extractor, ev.weight, (ev.tx_to IS NULL) AS live
     FROM evidence ev JOIN scopes s ON s.id = ev.scope_id WHERE ev.tx_to IS NULL ORDER BY ev.kind, ev.target_id, s.key, ev.extractor`,
  );
  const pages = await store.query(`SELECT path, kind, status, inputs_sha FROM pages ORDER BY path`);
  const deps = await store.query(`SELECT artifact_kind, artifact_id, input_kind, input_id, required FROM deps ORDER BY artifact_kind, artifact_id, input_kind, input_id`);
  return { entities, relations, claims, evidence, pages, deps };
}

class CountingEmbedder implements EmbeddingProvider {
  calls = 0;
  texts = 0;
  constructor(private readonly inner: EmbeddingProvider) {}
  get model() { return this.inner.model; }
  get dimensions() { return this.inner.dimensions; }
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    this.texts += texts.length;
    return this.inner.embed(texts);
  }
}

describe('lineage: temporal composability of sources', () => {
  const dataDir = path.join(tmp, 'basic');
  let ctx: AppContext;

  afterAll(async () => {
    await ctx?.store.close();
  });

  it('applies a source as a scope with evidence, and disposing it reverts every effect', async () => {
    initDataDir(dataDir);
    write(dataDir, 'raw/docs/a.md', REPORT_A);
    ctx = await createContext(dataDir);
    const { store } = ctx;

    const first = await sync(ctx, { llmGraph: false });
    expect(first.applied).toBeGreaterThanOrEqual(1); // the report plus the wiki anchor pages
    expect(first.errors).toBe(0);

    const scope = await findLiveScope(store, 'doc', 'cooked/docs/a.md');
    expect(scope).not.toBeNull();
    expect(await count(store, `chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = 'cooked/docs/a.md'`)).toBeGreaterThan(0);
    const ev = await liveEvidence(store, 'entity', '宁德时代');
    expect(ev.map((e) => e.extractor)).toEqual(expect.arrayContaining(['tier0.frontmatter']));
    expect((await entityRow(store, '比亚迪')).tx_to).toBeNull();
    expect(await count(store, `claims WHERE subject_id = '宁德时代' AND tx_to IS NULL`)).toBe(1);
    expect(await count(store, `relations WHERE type = 'co_occurs' AND tx_to IS NULL`)).toBeGreaterThan(0);
    const forDoc = (events: ReturnType<typeof readLedger>) =>
      events.filter((e) => (e.ev === 'apply' || e.ev === 'dispose') && e.scope.key === 'cooked/docs/a.md');
    expect(forDoc(readLedger(dataDir)).map((e) => e.ev)).toEqual(['apply']);

    // remove the source
    fs.rmSync(path.join(dataDir, 'raw/docs/a.md'));
    const second = await sync(ctx, { llmGraph: false });
    expect(second.disposed).toBe(1);

    expect(await count(store, `evidence WHERE scope_id = $1 AND tx_to IS NULL`, [scope!.id])).toBe(0);
    expect((await entityRow(store, '宁德时代')).tx_to).not.toBeNull();
    expect((await entityRow(store, '比亚迪')).tx_to).not.toBeNull();
    expect((await entityRow(store, '动力电池')).tx_to).not.toBeNull();
    expect(await count(store, `claims WHERE tx_to IS NULL`)).toBe(0);
    expect(await count(store, `relations WHERE tx_to IS NULL`)).toBe(0);
    expect(await count(store, `chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = 'cooked/docs/a.md'`)).toBe(0);
    expect(await count(store, `entity_mentions WHERE scope_id = $1`, [scope!.id])).toBe(0);
    expect(await count(store, `extraction_queue`)).toBe(0);
    const [doc] = await store.query<{ status: string; scope_id: string | null }>(`SELECT status, scope_id FROM documents WHERE path = 'cooked/docs/a.md'`);
    expect(doc).toMatchObject({ status: 'disposed', scope_id: null });
    expect(fs.existsSync(path.join(dataDir, 'cooked/docs/a.md'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, `ledger/attic/${scope!.id}.knode.json`))).toBe(true);
    const events = forDoc(readLedger(dataDir));
    expect(events.map((e) => e.ev)).toEqual(['apply', 'dispose']);
    expect(events[1]).toMatchObject({ ev: 'dispose', reason: 'removed', attic: scope!.id });

    // search no longer sees it (vector recall still returns other pages); history still does
    const hits = await search(store, ctx.embedder, '宁德时代 动力电池', { k: 5, track: false });
    expect(hits.map((h) => h.path)).not.toContain('cooked/docs/a.md');
    const history = await historyOf(store, dataDir, 'raw/docs/a.md');
    expect(history.scopes[0].status).toBe('disposed');
  });

  it('keeps a claim shared by two sources alive when one of them is removed', async () => {
    const { store } = ctx;
    write(dataDir, 'raw/docs/a.md', REPORT_A);
    write(dataDir, 'raw/docs/b.md', REPORT_B);
    await sync(ctx, { llmGraph: false });

    const claims = await store.query<{ id: string; status: string; evidence_count: number }>(
      `SELECT id, status, evidence_count FROM claims WHERE subject_id = '宁德时代' AND tx_to IS NULL`,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ evidence_count: 2, status: 'disputed' });
    expect((await entityRow(store, '宁德时代')).tx_to).toBeNull();
    expect((await liveEvidence(store, 'entity', '比亚迪')).map((e) => e.scope_key).sort()).toEqual(['cooked/docs/a.md', 'cooked/docs/b.md']);

    fs.rmSync(path.join(dataDir, 'raw/docs/b.md'));
    await sync(ctx, { llmGraph: false });
    const after = await store.query<{ status: string; evidence_count: number; tx_to: string | null }>(
      `SELECT status, evidence_count, tx_to FROM claims WHERE id = $1`,
      [claims[0].id],
    );
    expect(after[0]).toMatchObject({ evidence_count: 1, status: 'fact', tx_to: null });
    const projected = await claimsForEntities(store, ['宁德时代']);
    expect(projected).toHaveLength(1);
    expect(projected[0].path).toBe('cooked/docs/a.md');
    expect(projected[0].startDate).toBe('2026-08-10');
    expect((await entityRow(store, '比亚迪')).tx_to).toBeNull();
    const lineage = await lineageOf(store, 'claim', claims[0].id);
    expect(lineage.evidence.filter((e) => e.live).map((e) => e.scopeKey)).toEqual(['cooked/docs/a.md']);
    // history keeps b.md's contribution (and a.md's from the earlier removal) as closed evidence
    expect(lineage.evidence.filter((e) => !e.live && e.scopeKey === 'cooked/docs/b.md')).toHaveLength(1);
  });

  it('re-applies idempotently: unchanged sources write nothing and weights never inflate', async () => {
    const { store } = ctx;
    const weightOf = async () => {
      const [row] = await store.query<{ weight: number }>(
        `SELECT weight FROM relations WHERE type = 'co_occurs' AND tx_to IS NULL
         AND ((source_id = '比亚迪' AND target_id = '动力电池') OR (source_id = '动力电池' AND target_id = '比亚迪'))`,
      );
      return row?.weight;
    };
    const before = {
      scopes: await count(store, 'scopes'),
      evidence: await count(store, 'evidence'),
      ledger: readLedger(dataDir).length,
      weight: await weightOf(),
    };
    expect(before.weight).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) {
      const s = await sync(ctx, { llmGraph: false });
      expect(s.applied).toBe(0);
      expect(s.unchanged).toBeGreaterThan(0);
    }
    const mtime = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dataDir, 'raw/docs/a.md'), mtime, mtime);
    expect((await sync(ctx, { llmGraph: false })).applied).toBe(0);
    expect(await count(store, 'scopes')).toBe(before.scopes);
    expect(await count(store, 'evidence')).toBe(before.evidence);
    expect(readLedger(dataDir).length).toBe(before.ledger);
    expect(await weightOf()).toBe(before.weight);

    // a real content change: exactly one dispose + one apply, same edge weight
    fs.appendFileSync(path.join(dataDir, 'raw/docs/a.md'), '\n补充：产能持续扩张。\n');
    const s = await sync(ctx, { llmGraph: false });
    expect(s.applied).toBe(1);
    expect(await count(store, `scopes WHERE kind = 'doc' AND key = 'cooked/docs/a.md' AND status = 'disposed'`)).toBeGreaterThanOrEqual(1);
    expect(await count(store, `scopes WHERE kind = 'doc' AND key = 'cooked/docs/a.md' AND status = 'active'`)).toBe(1);
    expect(await weightOf()).toBe(before.weight);
    const events = readLedger(dataDir).slice(before.ledger).filter((e) => (e.ev === 'apply' || e.ev === 'dispose') && e.scope.key === 'cooked/docs/a.md');
    expect(events.map((e) => e.ev)).toEqual(['dispose', 'apply']);
  });

  it('answers as_of from evidence after a source is gone, and forget purges the history', async () => {
    const { store } = ctx;
    await sleep(20);
    const t1 = new Date().toISOString();
    await sleep(20);
    fs.rmSync(path.join(dataDir, 'raw/docs/a.md'));
    await sync(ctx, { llmGraph: false });
    await sleep(20);
    const t2 = new Date().toISOString();

    expect(await claimsForEntities(store, ['宁德时代'])).toHaveLength(0);
    expect(await claimsForEntities(store, ['宁德时代'], 12, { asOf: t1 })).toHaveLength(1);
    expect(await claimsForEntities(store, ['宁德时代'], 12, { asOf: t2 })).toHaveLength(0);

    const now = await graphSearch(store, '宁德时代', { track: false });
    expect(now.nodes.find((n) => n.id === '宁德时代')).toBeUndefined();
    const then = await graphSearch(store, '宁德时代', { track: false, asOf: t1 });
    expect(then.nodes.find((n) => n.id === '宁德时代')).toBeDefined();
    const edgesThen = await graphSearch(store, '比亚迪', { track: false, asOf: t1 });
    expect(edgesThen.edges.length).toBeGreaterThan(0);
    expect((await graphSearch(store, '比亚迪', { track: false })).nodes.find((n) => n.id === '比亚迪')).toBeUndefined();

    // documents live at t1 are searchable as_of t1 only while their chunks exist;
    // the removed doc keeps no chunks, so its text is gone from the index
    const asOfHits = await search(store, ctx.embedder, '宁德时代', { k: 5, track: false, asOf: t1 });
    expect(asOfHits.map((h) => h.path)).not.toContain('cooked/docs/a.md');

    // forget = dispose (already done) + purge history
    const disposed = await store.query<{ id: string }>(`SELECT id FROM scopes WHERE key = 'cooked/docs/a.md' AND status = 'disposed'`);
    expect(disposed.length).toBeGreaterThan(0);
    const res = await forgetSource(ctx, 'raw/docs/a.md');
    expect(res.purged.length).toBeGreaterThan(0);
    expect(await count(store, `scopes WHERE key = 'cooked/docs/a.md'`)).toBe(0);
    expect(await count(store, `evidence ev JOIN scopes s ON s.id = ev.scope_id WHERE s.key = 'cooked/docs/a.md'`)).toBe(0);
    for (const id of disposed) expect(fs.existsSync(path.join(dataDir, `ledger/attic/${id.id}.knode.json`))).toBe(false);
    expect(await claimsForEntities(store, ['宁德时代'], 12, { asOf: t1 })).toHaveLength(0);
    expect(readLedger(dataDir).some((e) => e.ev === 'purge')).toBe(true);
  });
});

describe('lineage: wiki pages as views', () => {
  const dataDir = path.join(tmp, 'views');
  let ctx: AppContext;

  afterAll(async () => {
    await ctx?.store.close();
  });

  it('generates a stub with declared inputs, archives it when the entity dies, restores it when the entity returns', async () => {
    initDataDir(dataDir);
    write(dataDir, 'raw/docs/a.md', REPORT_A);
    write(dataDir, 'raw/docs/c.md', `---
title: 比亚迪观察
---
# 比亚迪观察

[[比亚迪]] 的刀片电池与 [[动力电池]] 行业格局。
`);
    ctx = await createContext(dataDir);
    const { store } = ctx;
    await sync(ctx, { llmGraph: false });
    expect((await entityRow(store, '比亚迪')).mention_count).toBeGreaterThanOrEqual(2);

    const created = await generateWiki(store, ctx.llm, { config: ctx.config, embedder: ctx.embedder });
    const pagePath = 'wiki/entities/比亚迪.md';
    expect(created).toContain(pagePath);
    const file = fs.readFileSync(path.join(dataDir, pagePath), 'utf8');
    expect(file).toContain('<!-- knode:begin body -->');
    expect(file).toContain('generated: true');
    const [page] = await store.query<{ status: string; kind: string }>(`SELECT status, kind FROM pages WHERE path = $1`, [pagePath]);
    expect(page).toMatchObject({ status: 'active', kind: 'entity_stub' });
    const deps = await store.query<{ input_kind: string; input_id: string; required: boolean }>(`SELECT input_kind, input_id, required FROM deps WHERE artifact_id = $1`, [pagePath]);
    expect(deps).toContainEqual({ input_kind: 'entity', input_id: '比亚迪', required: true });
    expect((await entityRow(store, '比亚迪')).wiki_path).toBe(pagePath);

    // the generated page is a view: syncing it must not add evidence or new scopes
    const scopesBefore = await count(store, `scopes WHERE status = 'active'`);
    await sync(ctx, { llmGraph: false });
    await sync(ctx, { llmGraph: false });
    expect(await count(store, `scopes WHERE status = 'active'`)).toBe(scopesBefore);
    expect((await liveEvidence(store, 'entity', '比亚迪')).map((e) => e.scope_key)).not.toContain(pagePath);
    const [pageDoc] = await store.query<{ kind: string }>(`SELECT kind FROM documents WHERE path = $1`, [pagePath]);
    expect(pageDoc.kind).toBe('view');

    // remove every source → the entity dies → the page is archived, not resurrected
    fs.rmSync(path.join(dataDir, 'raw/docs/a.md'));
    fs.rmSync(path.join(dataDir, 'raw/docs/c.md'));
    const s = await sync(ctx, { llmGraph: false });
    expect(s.pagesArchived).toBeGreaterThanOrEqual(1);
    expect((await entityRow(store, '比亚迪')).tx_to).not.toBeNull();
    expect((await entityRow(store, '比亚迪')).wiki_path).toBeNull();
    const [archived] = await store.query<{ status: string }>(`SELECT status FROM pages WHERE path = $1`, [pagePath]);
    expect(archived.status).toBe('archived');
    expect(fs.existsSync(path.join(dataDir, pagePath))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'wiki/.archive/entities/比亚迪.md'))).toBe(true);
    expect(await findLiveScope(store, 'doc', pagePath)).toBeNull();
    expect(await findLiveScope(store, 'page', pagePath)).toBeNull();
    expect((await search(store, ctx.embedder, '比亚迪 刀片电池', { k: 5, track: false })).map((h) => h.path)).not.toContain(pagePath);

    // bring one source back → entity reopens → stub is recreated from the archived copy
    write(dataDir, 'raw/docs/a.md', REPORT_A);
    write(dataDir, 'raw/docs/c.md', `# 比亚迪观察\n\n[[比亚迪]] 与 [[动力电池]]。\n`);
    await sync(ctx, { llmGraph: false });
    expect((await entityRow(store, '比亚迪')).tx_to).toBeNull();
    const again = await generateWiki(store, ctx.llm, { config: ctx.config, embedder: ctx.embedder });
    expect(again).toContain(pagePath);
    expect(fs.existsSync(path.join(dataDir, pagePath))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'wiki/.archive/entities/比亚迪.md'))).toBe(false);
  });

  it('keeps an entity alive through prose a human wrote outside the managed region', async () => {
    const { store } = ctx;
    const pagePath = 'wiki/entities/比亚迪.md';
    const current = fs.readFileSync(path.join(dataDir, pagePath), 'utf8');
    fs.writeFileSync(path.join(dataDir, pagePath), current.trimEnd() + '\n\n## 我的笔记\n\n比亚迪是我长期跟踪的公司，重点看储能业务。\n');
    await sync(ctx, { llmGraph: false });
    const human = await liveEvidence(store, 'entity', '比亚迪');
    expect(human.some((e) => e.extractor === 'human' && e.scope_key === pagePath)).toBe(true);

    fs.rmSync(path.join(dataDir, 'raw/docs/a.md'));
    fs.rmSync(path.join(dataDir, 'raw/docs/c.md'));
    await sync(ctx, { llmGraph: false });
    expect((await entityRow(store, '比亚迪')).tx_to).toBeNull();
    const [page] = await store.query<{ status: string }>(`SELECT status FROM pages WHERE path = $1`, [pagePath]);
    expect(page.status).not.toBe('archived');
    const after = fs.readFileSync(path.join(dataDir, pagePath), 'utf8');
    expect(splitRegions(after).human).toContain('我的笔记');
  });
});

describe('lineage: scoped sync, rebuild and migration', () => {
  it('disposes only within the requested prefix, then the rest on a full sync', async () => {
    const dataDir = path.join(tmp, 'scoped');
    initDataDir(dataDir);
    write(dataDir, 'raw/docs/sub/x.md', '# X\n\n[[Alpha]] and [[Beta]] together.\n');
    write(dataDir, 'raw/docs/y.md', '# Y\n\n[[Gamma]] alone.\n');
    const ctx = await createContext(dataDir);
    try {
      await sync(ctx, { llmGraph: false });
      fs.rmSync(path.join(dataDir, 'raw/docs/sub/x.md'));
      fs.rmSync(path.join(dataDir, 'raw/docs/y.md'));
      const partial = await sync(ctx, { llmGraph: false, only: ['raw/docs/sub'] });
      expect(partial.disposed).toBe(1);
      expect(await findLiveScope(ctx.store, 'doc', 'cooked/docs/sub/x.md')).toBeNull();
      expect(await findLiveScope(ctx.store, 'doc', 'cooked/docs/y.md')).not.toBeNull();
      const full = await sync(ctx, { llmGraph: false });
      expect(full.disposed).toBe(1);
      expect(await findLiveScope(ctx.store, 'doc', 'cooked/docs/y.md')).toBeNull();
    } finally {
      await ctx.store.close();
    }
  });

  it('rebuilds the same graph from files + ledger, replaying sidecar extractions and keeping apply times', async () => {
    const dataDir = path.join(tmp, 'rebuild');
    initDataDir(dataDir);
    write(dataDir, 'raw/docs/a.md', REPORT_A);
    write(dataDir, 'raw/docs/b.md', REPORT_B);
    let ctx = await createContext(dataDir);
    try {
      await sync(ctx, { llmGraph: false });
      const cooked = readSidecar(dataDir, 'cooked/docs/a.md')!;
      updateSidecar(dataDir, 'cooked/docs/a.md', (s) => {
        s.extraction.tier1 = {
          status: 'done',
          entities: [{ name: '宁德时代', type: 'organization' }, { name: '曾毓群', type: 'person', description: '董事长' }],
          relations: [{ source: '曾毓群', target: '宁德时代', type: 'works_at' }],
          claims: [{ subject: '宁德时代', type: 'capacity', statement: '产能规划超过 1TWh', status: 'suspected' }],
          model: 'test-model',
          contentSha: cooked.meta.sha256,
          extractedAt: new Date().toISOString(),
        };
      });
      // an unchanged document picks up the new sidecar extraction as a child scope
      await sync(ctx, { llmGraph: false });
      expect((await liveEvidence(ctx.store, 'entity', '曾毓群')).map((e) => e.extractor)).toEqual(['tier1.llm:test-model']);
      expect(await count(ctx.store, `claims WHERE subject_id = '宁德时代' AND tx_to IS NULL`)).toBe(2);

      const s1 = await snapshotGraph(ctx.store);
      const ledgerBefore = readLedger(dataDir);
      const scopeBefore = await findLiveScope(ctx.store, 'doc', 'cooked/docs/a.md');

      const report = await rebuild(ctx, {});
      expect(report.sync.applied).toBeGreaterThanOrEqual(2);
      expect(report.sync.errors).toBe(0);
      const s2 = await snapshotGraph(ctx.store);
      expect(s2).toEqual(s1);
      const ledgerAfter = readLedger(dataDir);
      expect(ledgerAfter.length).toBeGreaterThan(ledgerBefore.length);
      expect(ledgerAfter.slice(ledgerBefore.length).every((e) => e.ev === 'apply' || e.ev === 'rebuild')).toBe(true);
      expect(ledgerAfter[ledgerAfter.length - 1].seq).toBe(ledgerAfter.length);
      const scopeAfter = await findLiveScope(ctx.store, 'doc', 'cooked/docs/a.md');
      expect(scopeAfter!.applied_at).toBe(scopeBefore!.applied_at);
    } finally {
      await ctx.store.close();
    }
  });

  it('reuses embeddings of unchanged chunks when a document changes', async () => {
    const dataDir = path.join(tmp, 'embed');
    initDataDir(dataDir);
    const para = (i: number) => `Paragraph ${i}: ` + 'knowledge graphs compose lineage and evidence over time. '.repeat(12);
    const body = Array.from({ length: 6 }, (_, i) => para(i)).join('\n\n');
    write(dataDir, 'raw/docs/long.md', `# Long\n\n${body}\n`);
    const ctx = await createContext(dataDir);
    const counting = new CountingEmbedder(ctx.embedder);
    ctx.embedder = counting;
    try {
      await sync(ctx, { llmGraph: false });
      const chunks = await count(ctx.store, `chunks`);
      expect(chunks).toBeGreaterThan(1);
      expect(counting.texts).toBe(chunks);
      counting.texts = 0;
      fs.appendFileSync(path.join(dataDir, 'raw/docs/long.md'), `\n\n${para(99)}\n`);
      await sync(ctx, { llmGraph: false });
      const chunksAfter = await count(ctx.store, `chunks`);
      expect(chunksAfter).toBeGreaterThanOrEqual(chunks);
      expect(counting.texts).toBeLessThan(chunksAfter);
      expect(await count(ctx.store, `embeddings`)).toBe(chunksAfter);
    } finally {
      await ctx.store.close();
    }
  });

  it('migrates a pre-lineage database and rebuilds its graph on the first sync', async () => {
    const dataDir = path.join(tmp, 'migrate');
    initDataDir(dataDir);
    write(dataDir, 'raw/docs/a.md', REPORT_A);
    const db = await PGlite.create(path.join(dataDir, '.knode/db'), { extensions: { vector } });
    await db.exec(`CREATE EXTENSION IF NOT EXISTS vector; CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value JSONB NOT NULL);`);
    const q = { query: async <T>(sql: string, params?: unknown[]) => (await db.query<T>(sql, params)).rows, exec: async (sql: string) => { await db.exec(sql); } };
    await MIGRATIONS[0].up(q, { from: 0 });
    await db.exec(`CREATE TABLE embeddings (chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE, model TEXT NOT NULL, embedding vector(384) NOT NULL);`);
    await db.query(`INSERT INTO meta (key, value) VALUES ('embedding', '{"dim":384}'), ('schema_version', '{"v":1}')`);
    await db.query(`INSERT INTO documents (id, path, root, title, sha256, bytes, status) VALUES ('legacydoc', 'cooked/docs/a.md', 'docs', 'old', 'sha', 10, 'indexed')`);
    await db.query(`INSERT INTO entities (id, name, type, mention_count) VALUES ('legacy-entity', 'Legacy', 'concept', 5)`);
    await db.query(`INSERT INTO relations (id, source_id, target_id, type, weight, document_id) VALUES ('r1', 'legacy-entity', 'legacy-entity', 'related_to', 9, 'legacydoc')`);
    await db.close();

    const ctx = await createContext(dataDir);
    try {
      expect(ctx.store.migration).toEqual({ from: 1, to: SCHEMA_VERSION });
      expect(await count(ctx.store, `entities`)).toBe(0);
      const [doc] = await ctx.store.query<{ status: string }>(`SELECT status FROM documents WHERE id = 'legacydoc'`);
      expect(doc.status).toBe('pending');
      const s = await sync(ctx, { llmGraph: false });
      expect(s.applied).toBeGreaterThanOrEqual(1);
      expect(s.errors).toBe(0);
      expect((await entityRow(ctx.store, '宁德时代')).tx_to).toBeNull();
      expect(await ctx.store.getMeta('lineage_rebuild')).toBeDefined();
    } finally {
      await ctx.store.close();
    }
  });
});

describe('lineage: datasources as scopes', () => {
  it('tombstones datasets, links and pages when a source leaves the config', async () => {
    const dataDir = path.join(tmp, 'ds');
    initDataDir(dataDir);
    const parquetDir = path.join(dataDir, 'lake');
    fs.mkdirSync(parquetDir, { recursive: true });
    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();
    await conn.run(`CREATE TABLE bars (symbol VARCHAR, trade_date DATE, close DOUBLE)`);
    await conn.run(`INSERT INTO bars VALUES ('300750', DATE '2026-08-27', 243.68)`);
    await conn.run(`COPY bars TO '${path.join(parquetDir, 'bars.parquet').replace(/'/g, "''")}' (FORMAT PARQUET)`);
    conn.disconnectSync();

    write(dataDir, 'raw/docs/a.md', REPORT_A);
    const config = loadConfig(dataDir);
    config.datasources = [{ id: 'lake', kind: 'duckdb', path: 'lake', tables: [{ name: 'bars', entityColumns: [{ column: 'symbol', entityType: 'organization' }] }] }];
    saveConfig(dataDir, config);

    let ctx = await createContext(dataDir);
    try {
      const s = await sync(ctx, { llmGraph: false });
      expect(s.datasourceErrors).toEqual([]);
      expect((await listDatasets(ctx.store)).map((d) => d.id)).toEqual(['lake.bars']);
      expect(await count(ctx.store, `relations WHERE type = 'appears_in' AND source_id = '宁德时代' AND tx_to IS NULL`)).toBe(1);
      expect(fs.existsSync(path.join(dataDir, 'wiki/datasets/lake.bars.md'))).toBe(true);
      expect(await findLiveScope(ctx.store, 'datasource', 'lake')).not.toBeNull();
      await sync(ctx, { llmGraph: false }); // idempotent
      expect(await count(ctx.store, `scopes WHERE kind = 'datasource' AND status = 'active'`)).toBe(1);
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }

    config.datasources = [];
    saveConfig(dataDir, config);
    ctx = await createContext(dataDir);
    try {
      const s = await sync(ctx, { llmGraph: false });
      expect(s.disposed).toBe(1);
      expect(await listDatasets(ctx.store)).toEqual([]);
      expect(await count(ctx.store, `datasets WHERE id = 'lake.bars' AND tx_to IS NOT NULL`)).toBe(1);
      expect(await count(ctx.store, `relations WHERE type = 'appears_in' AND tx_to IS NULL`)).toBe(0);
      expect((await entityRow(ctx.store, '宁德时代')).tx_to).toBeNull(); // still supported by the report
      expect(fs.existsSync(path.join(dataDir, 'wiki/datasets/lake.bars.md'))).toBe(false);
      expect(fs.existsSync(path.join(dataDir, 'wiki/.archive/datasets/lake.bars.md'))).toBe(true);
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  }, 60_000);
});
