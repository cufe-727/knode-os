import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { sync } from '../src/ingest/sync.js';
import { foldTouched, IN_BATCH } from '../src/lineage/fold.js';
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
});
