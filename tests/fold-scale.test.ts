import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { applyClaimMerge, unmergeClaim } from '../src/graph/claim-merge.js';
import { sync } from '../src/ingest/sync.js';
import { foldTouched, IN_BATCH } from '../src/lineage/fold.js';
import { findLiveScope } from '../src/lineage/scope.js';
import { emptyTouched } from '../src/lineage/types.js';
import { ensureEntityStubs } from '../src/wiki/pages.js';

/**
 * The fold (src/lineage/fold.ts) at the sizes a real workspace reaches: a hub
 * entity's tombstone or return can touch more rows than one statement can
 * bind (Postgres and PGlite both stop at 65,535 parameters).
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-fold-scale-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Co-occurrence is derived from mentions, not stored, so the edges the fold is tested on are typed: one per consecutive pair. */
const EDGE_TYPE = 'competes_with';
const doc = (title: string, names: string[]) => {
  const relations = names.slice(1).map((n, i) => `  - { source: ${names[i]}, target: ${n}, type: ${EDGE_TYPE} }`);
  return [
    '---',
    `title: ${title}`,
    'entities:',
    ...names.map((n) => `  - { name: ${n}, type: organization }`),
    ...(relations.length ? ['relations:', ...relations] : []),
    '---',
    `# ${title}`,
    '',
    `${names.map((n) => `[[${n}]]`).join('、')} 同时出现在这份报告里。`,
    '',
  ].join('\n');
};

describe('the fold at scale', () => {
  const dataDir = path.join(tmp, 'ws');
  let ctx: AppContext;

  beforeAll(async () => {
    initDataDir(dataDir);
    ctx = await createContext(dataDir);
  });
  afterAll(async () => {
    await ctx?.store.close();
  });

  it('folds more ids than one statement can bind', async () => {
    const n = 70_000;
    expect(n).toBeGreaterThan(65_535);
    expect(IN_BATCH).toBeLessThan(65_535);
    const touched = emptyTouched();
    for (let i = 0; i < n; i++) {
      touched.entities.add(`entity-${i}`);
      touched.relations.add(`relation-${i}`);
      touched.claims.add(`claim-${i}`);
    }
    const result = await ctx.store.tx((q) => foldTouched(q, touched, new Date().toISOString()));
    expect(result.changed.entities.size + result.changed.relations.size + result.changed.claims.size).toBe(0);
  });

  it('ends only the live edges of an entity that dies, and leaves the ones already gone as they were', async () => {
    const { store } = ctx;
    const live = async (id: string) => (await store.query<{ live: boolean }>(`SELECT (tx_to IS NULL) AS live FROM entities WHERE id = $1`, [id]))[0]?.live;
    const edge = async (a: string, b: string) =>
      (await store.query<{ live: boolean; tx_to: string | null }>(
        `SELECT (tx_to IS NULL) AS live, tx_to FROM relations WHERE type = '${EDGE_TYPE}' AND ((source_id = $1 AND target_id = $2) OR (source_id = $2 AND target_id = $1))`,
        [a, b],
      ))[0];

    write(dataDir, 'raw/docs/a.md', doc('甲乙报告', ['甲公司', '乙公司']));
    await sync(ctx, { llmGraph: false });
    expect((await edge('甲公司', '乙公司'))?.live).toBe(true);

    // a.md goes: both companies die, and so does their edge
    fs.rmSync(path.join(dataDir, 'raw/docs/a.md'));
    await sync(ctx, { llmGraph: false });
    expect(await live('甲公司')).toBe(false);
    const ended = await edge('甲公司', '乙公司');
    expect(ended?.live).toBe(false);

    // 甲 returns with 丙: the new edge lives, the one to the still-dead 乙 stays gone
    write(dataDir, 'raw/docs/b.md', doc('甲丙报告', ['甲公司', '丙公司']));
    await sync(ctx, { llmGraph: false });
    expect(await live('甲公司')).toBe(true);
    expect((await edge('甲公司', '丙公司'))?.live).toBe(true);
    expect((await edge('甲公司', '乙公司'))?.live).toBe(false);

    // and dies again: its live edge ends, the old one keeps the end it had
    fs.rmSync(path.join(dataDir, 'raw/docs/b.md'));
    await sync(ctx, { llmGraph: false });
    expect(await live('甲公司')).toBe(false);
    expect((await edge('甲公司', '丙公司'))?.live).toBe(false);
    const old = await edge('甲公司', '乙公司');
    expect(old?.live).toBe(false);
    expect(String(old?.tx_to)).toBe(String(ended?.tx_to));
    expect((await store.query<{ n: number }>(`SELECT count(*)::int AS n FROM relations WHERE tx_to IS NULL`))[0].n).toBe(0);

    // a source naming both again revives the old edge
    write(dataDir, 'raw/docs/a.md', doc('甲乙报告', ['甲公司', '乙公司']));
    await sync(ctx, { llmGraph: false });
    expect((await edge('甲公司', '乙公司'))?.live).toBe(true);
    expect((await edge('甲公司', '丙公司'))?.live).toBe(false);
  });

  it('revives an edge with live evidence when its dead endpoint returns, without being touched itself', async () => {
    const { store } = ctx;
    const live = async (id: string) => (await store.query<{ live: boolean }>(`SELECT (tx_to IS NULL) AS live FROM entities WHERE id = $1`, [id]))[0]?.live;
    const edgeOf = async (a: string, b: string) =>
      (await store.query<{ id: string; live: boolean }>(
        `SELECT id, (tx_to IS NULL) AS live FROM relations WHERE type = '${EDGE_TYPE}' AND ((source_id = $1 AND target_id = $2) OR (source_id = $2 AND target_id = $1))`,
        [a, b],
      ))[0];
    write(dataDir, 'raw/docs/e.md', doc('丁戊报告', ['丁公司', '戊公司']));
    await sync(ctx, { llmGraph: false });
    fs.rmSync(path.join(dataDir, 'raw/docs/e.md'));
    await sync(ctx, { llmGraph: false });
    const gone = await edgeOf('丁公司', '戊公司');
    expect(gone?.live).toBe(false);
    // 丁 returns alone; then the edge gains live evidence from 丁's source while 戊 is still dead
    write(dataDir, 'raw/docs/f.md', doc('丁报告', ['丁公司']));
    await sync(ctx, { llmGraph: false });
    expect(await live('丁公司')).toBe(true);
    const f = await findLiveScope(store, 'doc', 'raw/docs/f.md');
    await store.query(
      `INSERT INTO evidence (kind, target_id, scope_id, segment_id, weight, extractor, attrs, tx_from, trust)
       SELECT 'relation', $1, scope_id, NULL, 1, 'test.injected', '{}'::jsonb, now(), trust FROM evidence WHERE scope_id = $2 LIMIT 1`,
      [gone!.id, f!.id],
    );
    expect((await edgeOf('丁公司', '戊公司'))?.live).toBe(false);
    // 戊 returns through a source that names only 戊: the edge is not touched, its endpoint's return revives it
    write(dataDir, 'raw/docs/g.md', doc('戊报告', ['戊公司']));
    await sync(ctx, { llmGraph: false });
    expect(await live('戊公司')).toBe(true);
    expect((await edgeOf('丁公司', '戊公司'))?.live).toBe(true);
  });
});

describe('disposal at scale', () => {
  const dataDir = path.join(tmp, 'disposal');
  let ctx: AppContext;
  /** More ids than one statement can bind: 65,535 parameters, and the count wraps past it. */
  const n = 70_000;

  beforeAll(async () => {
    initDataDir(dataDir);
    ctx = await createContext(dataDir);
  });
  afterAll(async () => {
    await ctx?.store.close();
  });

  const count = async (sql: string, params: unknown[] = []) => (await ctx.store.query<{ n: number }>(sql, params))[0].n;

  it('disposes the only source of a hub entity with more live edges than one statement can bind', async () => {
    // the watch sync that failed after the finance folders were cleared on
    // 2026-10-17: a document went, its hub entity died, and the tombstone
    // reached more edges than one statement binds ("bind message has 14761
    // parameter formats but 0 parameters")
    const { store } = ctx;
    write(dataDir, 'raw/docs/hub.md', doc('枢纽报告', ['枢纽集团']));
    write(dataDir, 'raw/docs/partners.md', doc('合作方名录', ['合作方甲']));
    await sync(ctx, { llmGraph: false });
    const [{ id: hub }] = await store.query<{ id: string }>(`SELECT id FROM entities WHERE name = '枢纽集团'`);
    const partners = await findLiveScope(store, 'doc', 'raw/docs/partners.md');
    // the hub's wiki page, which goes to the archive with it
    const page = `wiki/entities/${hub}.md`;
    expect(await ensureEntityStubs(ctx, { minMentions: 1 })).toContain(page);

    // an edge from the hub to each of n partners; the partners and the edges stand on partners.md, the hub only on hub.md
    await store.query(
      `INSERT INTO entities (id, name, type, evidence_count) SELECT 'partner-' || g, '合作方' || g, 'organization', 1 FROM generate_series(1, $1::int) AS g`,
      [n],
    );
    await store.query(
      `INSERT INTO relations (id, source_id, target_id, type, weight, evidence_count)
       SELECT 'edge-' || g, $2, 'partner-' || g, '${EDGE_TYPE}', 1, 1 FROM generate_series(1, $1::int) AS g`,
      [n, hub],
    );
    await store.query(
      `INSERT INTO evidence (kind, target_id, scope_id, weight, extractor, tx_from)
       SELECT k.kind, k.prefix || g, $2, 1, 'test.bulk', now()
       FROM generate_series(1, $1::int) AS g, (VALUES ('entity', 'partner-'), ('relation', 'edge-')) AS k(kind, prefix)`,
      [n, partners!.id],
    );
    const liveEdges = () => count(`SELECT count(*)::int AS n FROM relations WHERE source_id = $1 AND tx_to IS NULL`, [hub]);
    expect(await liveEdges()).toBe(n);

    // hub.md goes, and the watcher syncs that one path
    fs.rmSync(path.join(dataDir, 'raw/docs/hub.md'));
    const stats = await sync(ctx, { only: ['raw/docs/hub.md'], llmGraph: false });
    expect(stats).toMatchObject({ disposed: 1, pagesArchived: 1 });
    expect(await count(`SELECT count(*)::int AS n FROM entities WHERE id = $1 AND tx_to IS NULL`, [hub])).toBe(0);
    expect(await liveEdges()).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM pages WHERE path = $1 AND status = 'archived'`, [page])).toBe(1);
    expect(fs.existsSync(path.join(dataDir, 'wiki/.archive/entities', `${hub}.md`))).toBe(true);
    // the partners stand on their own source
    expect(await count(`SELECT count(*)::int AS n FROM entities WHERE id LIKE 'partner-%' AND tx_to IS NULL`)).toBe(n);
  });

  it('undoes a claim merge that carried more members than one statement can bind', async () => {
    const { store } = ctx;
    write(dataDir, 'raw/docs/jia.md', [
      '---',
      'title: 甲公司',
      'entities:',
      '  - { name: 甲公司, type: organization }',
      'claims:',
      '  - { subject: 甲公司, statement: "甲公司营收增长20%" }',
      '  - { subject: 甲公司, statement: "甲公司收入同比增长两成" }',
      '---',
      '# 甲公司',
      '',
    ].join('\n'));
    await sync(ctx, { llmGraph: false });
    const claim = async (statement: string) => (await store.query<{ id: string; subject_id: string }>(`SELECT id, subject_id FROM claims WHERE statement = $1`, [statement]))[0];
    const from = await claim('甲公司营收增长20%');
    const into = await claim('甲公司收入同比增长两成');
    // `from` already represents n claims (members whose sources have gone stay in their group)
    await store.query(
      `INSERT INTO claims (id, subject_id, statement, canonical_id, tx_to)
       SELECT 'member-' || g, $2, '甲公司营收增长20%（转述 ' || g || '）', $3, now() FROM generate_series(1, $1::int) AS g`,
      [n, from.subject_id, from.id],
    );
    const members = (rep: string) => count(`SELECT count(*)::int AS n FROM claims WHERE canonical_id = $1`, [rep]);

    // the merge takes `from`'s whole group along; undoing it gives the group back
    await applyClaimMerge(store, { claimId: from.id, canonicalId: into.id });
    expect(await members(into.id)).toBe(n + 1);
    expect(await unmergeClaim(store, from.id)).toBe(true);
    expect(await members(from.id)).toBe(n);
    expect(await members(into.id)).toBe(0);
  });

  it('rebuilds the lookup keys of an entity that answers to more names than one statement can bind', async () => {
    // an entity answers to its own names and to those of every entity merged
    // into it; the fold rewrote them with two parameters per key
    const { store } = ctx;
    write(dataDir, 'raw/docs/yi.md', doc('乙公司简介', ['乙公司']));
    await sync(ctx, { llmGraph: false });
    const [{ id }] = await store.query<{ id: string }>(`SELECT id FROM entities WHERE name = '乙公司'`);
    const merged = 40_000;
    expect(2 * merged).toBeGreaterThan(65_535);
    await store.query(
      `INSERT INTO entities (id, name, type, canonical_id) SELECT 'former-' || g, '乙公司旧称' || g, 'organization', $2 FROM generate_series(1, $1::int) AS g`,
      [merged, id],
    );
    const touched = emptyTouched();
    touched.entities.add(id);
    await store.tx((q) => foldTouched(q, touched, new Date().toISOString()));
    expect(await count(`SELECT count(*)::int AS n FROM entity_alias_keys WHERE entity_id = $1`, [id])).toBe(merged + 1);
    expect(await count(`SELECT count(*)::int AS n FROM entity_alias_keys WHERE entity_id = $1 AND alias_key = $2`, [id, '乙公司旧称39999'])).toBe(1);
  });
});
