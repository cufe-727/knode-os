import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { sync } from '../src/ingest/sync.js';
import { foldTouched, IN_BATCH } from '../src/lineage/fold.js';
import { findLiveScope } from '../src/lineage/scope.js';
import { emptyTouched } from '../src/lineage/types.js';

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

const doc = (title: string, names: string[]) => `---
title: ${title}
entities:
${names.map((n) => `  - { name: ${n}, type: organization }`).join('\n')}
---
# ${title}

${names.map((n) => `[[${n}]]`).join('、')} 同时出现在这份报告里。
`;

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
        `SELECT (tx_to IS NULL) AS live, tx_to FROM relations WHERE type = 'co_occurs' AND ((source_id = $1 AND target_id = $2) OR (source_id = $2 AND target_id = $1))`,
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
        `SELECT id, (tx_to IS NULL) AS live FROM relations WHERE type = 'co_occurs' AND ((source_id = $1 AND target_id = $2) OR (source_id = $2 AND target_id = $1))`,
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
