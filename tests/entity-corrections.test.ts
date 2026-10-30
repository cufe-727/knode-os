import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { tier0Known } from '../src/graph/concepts.js';
import {
  ENTITY_CORRECTIONS_FILE,
  parseEntityCorrections,
  readEntityCorrections,
  refusedKeys,
  refuses,
  writeEntityCorrections,
} from '../src/graph/corrections.js';
import { applyMerge, correctEntity } from '../src/graph/merge.js';
import { resolveEntityId } from '../src/graph/resolve.js';
import { sync } from '../src/ingest/sync.js';
import { readLedger } from '../src/lineage/ledger.js';
import { rebuild } from '../src/lineage/rebuild.js';

/**
 * A person's corrections to single entities (src/graph/corrections.ts): a
 * type that overrides the fold's pick, and spellings an entity does not
 * answer to — gone from its aliases and lookup keys, never resolved onto it
 * again (by key, by a merged member, by sameAs, or inside one document), with
 * the evidence untouched, so taking the correction back restores what the
 * extractors said, and a rebuild keeps it.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-corrections-'));
let ctx: AppContext | undefined;
afterAll(async () => {
  await ctx?.datasources.closeAll();
  await ctx?.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('the corrections file', () => {
  it('round-trips, skips empty entries and matches spellings with or without a corporate suffix', () => {
    const dir = path.join(tmp, 'file');
    fs.mkdirSync(dir, { recursive: true });
    expect(readEntityCorrections(dir).size).toBe(0);
    writeEntityCorrections(dir, new Map([
      ['a股', { name: 'A股', type: 'market', notAliases: ['创业板', '20cm'], reason: 'extraction merge: "创业板" is a board, not A股', by: 'user', at: '2026-10-30T08:00:00.000Z' }],
      ['中船特气', { notAliases: ['中国船舶'] }],
    ]));
    const back = readEntityCorrections(dir);
    expect(back.get('a股')).toEqual({ name: 'A股', type: 'market', notAliases: ['创业板', '20cm'], reason: 'extraction merge: "创业板" is a board, not A股', by: 'user', at: '2026-10-30T08:00:00.000Z' });
    expect(back.get('中船特气')).toEqual({ notAliases: ['中国船舶'] });
    expect(parseEntityCorrections('entities:\n  x: { name: X }\n  y: { type: theme }\n').size).toBe(1);
    expect(parseEntityCorrections('entities: [1, 2]\n').size).toBe(0);

    const refused = refusedKeys(back.get('中船特气'));
    expect(refuses(refused, '中国船舶')).toBe(true);
    expect(refuses(refused, '中国船舶集团')).toBe(true);
    expect(refuses(refused, '中船特气')).toBe(false);
    expect(fs.readFileSync(path.join(dir, ENTITY_CORRECTIONS_FILE), 'utf8')).toContain('notAliases: ["创业板", "20cm"]');
  });
});

describe('correcting an entity', () => {
  it('overrides the type, drops refused spellings everywhere they resolve, and is reversible and rebuilt', async () => {
    const dataDir = path.join(tmp, 'ws');
    // an extraction merge filed 创业板 and 20cm under A股, and extraction kept reading it as a data set
    // (in finance: 3,653 dataset readings to 2,739 market ones)
    write(dataDir, 'raw/docs/a.md', `---
title: A股周评
entities:
  - { name: A股, type: dataset, aliases: ["创业板", "20cm", "沪深A股"] }
claims:
  - { subject: A股, statement: 本周 A股 成交额放大, type: market }
---
本周 A股 成交额放大，创业板 领涨。
`);
    write(dataDir, 'raw/docs/b.md', `---
title: 券商晨报
entities:
  - { name: A股, type: dataset }
---
A股 早盘震荡。
`);
    write(dataDir, 'raw/docs/c.md', `---
title: 市场结构
entities:
  - { name: A股, type: dataset }
  - { name: 沪深股市, type: market, aliases: ["ChiNext"] }
  - { name: 20cm, type: concept }
claims:
  - { subject: 20cm, statement: 20cm 个股波动大, type: market }
---
A股 与 沪深股市，20cm 个股波动大。
`);
    initDataDir(dataDir);
    const config = loadConfig(dataDir);
    config.ingest.concurrency = 1;
    config.graph = { ...config.graph, ontologyPacks: ['core', 'organization', 'finance'] };
    saveConfig(dataDir, config);
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
    const store = ctx.store;

    const row = async (id: string) =>
      (await store.query<{ type: string; aliases: string[] }>(`SELECT type, aliases FROM entities WHERE id = $1`, [id]))[0];
    const keys = async (id: string) =>
      (await store.query<{ alias_key: string }>(`SELECT alias_key FROM entity_alias_keys WHERE entity_id = $1 ORDER BY alias_key`, [id])).map((r) => r.alias_key);
    const carrying = async (spelling: string) =>
      (await store.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM evidence WHERE kind = 'entity' AND target_id = 'a股' AND tx_to IS NULL AND attrs->'aliases' ? $1`,
        [spelling],
      ))[0].n;

    // before: the most-read type is the wrong one, the wrong spellings are A股's keys
    expect(await row('a股')).toMatchObject({ type: 'dataset' });
    expect((await row('a股')).aliases).toEqual(expect.arrayContaining(['创业板', '20cm']));
    expect(await keys('a股')).toEqual(expect.arrayContaining(['20cm', '创业板']));
    expect((await resolveEntityId(store, { name: '20cm' })).id).toBe('a股');
    const claimOn20cm = async () =>
      (await store.query<{ subject_id: string }>(`SELECT subject_id FROM claims WHERE statement = '20cm 个股波动大' AND tx_to IS NULL`)).map((r) => r.subject_id);
    expect(await claimOn20cm()).toEqual(['a股']);
    const evidenceBefore = await carrying('创业板');
    expect(evidenceBefore).toBe(1);

    // a person corrects it: unknown types and the entity's own name are refused
    await expect(correctEntity(store, { entity: 'A股', type: 'board' })).rejects.toThrow(/unknown entity type/);
    await expect(correctEntity(store, { entity: 'A股', notAliases: ['a 股'] })).rejects.toThrow(/own name/);
    await expect(correctEntity(store, { entity: '不存在' })).rejects.toThrow(/no live entity/);
    const res = await correctEntity(store, { entity: 'A股', type: 'market', notAliases: ['创业板', '20cm', 'ChiNext'], reason: 'boards are not A股' });
    expect(res).toMatchObject({ id: 'a股', name: 'A股', mergedInto: null, before: { type: 'dataset' }, after: { type: 'market' } });
    expect(res.after.aliases).not.toContain('创业板');
    expect(res.after.aliases).toContain('沪深A股');
    expect(readEntityCorrections(dataDir).get('a股')).toMatchObject({ name: 'A股', type: 'market', notAliases: ['创业板', '20cm', 'ChiNext'], reason: 'boards are not A股', by: 'user' });
    expect(readLedger(dataDir).some((e) => e.ev === 'feedback' && e.kind === 'entity.correct' && e.id === 'a股')).toBe(true);

    // the row, its keys and every lookup follow; the evidence still says what the extractor said
    expect(await row('a股')).toMatchObject({ type: 'market' });
    expect(await keys('a股')).not.toEqual(expect.arrayContaining(['创业板']));
    expect(await keys('a股')).not.toContain('20cm');
    expect(await carrying('创业板')).toBe(evidenceBefore);
    const corrections = readEntityCorrections(dataDir);
    expect((await resolveEntityId(store, { name: '20cm' }, undefined, { corrections })).id).toBe('20cm');
    // sameAs naming A股 for a spelling it refuses does not land there either
    expect((await resolveEntityId(store, { name: '创业板', sameAs: 'A股' }, undefined, { corrections })).id).toBe('创业板');
    expect((await resolveEntityId(store, { name: '沪深A股', sameAs: 'A股' }, undefined, { corrections })).id).toBe('a股');

    // later documents: a refused spelling becomes its own entity, by key and inside the same document
    write(dataDir, 'raw/docs/d.md', `---
title: 打板笔记
entities:
  - { name: A股, type: market, aliases: ["创业板"] }
  - { name: 创业板, type: market, aliases: ["A股"] }
  - { name: 20cm, type: concept }
claims:
  - { subject: 20cm, statement: 20cm 涨停板的个股更活跃, type: market }
---
A股 里 创业板 的 20cm 更活跃。
`);
    await sync(ctx, { llmGraph: false });
    expect(await row('创业板')).toMatchObject({ type: 'market' });
    expect(await row('20cm')).toBeDefined();
    expect((await store.query<{ subject_id: string }>(`SELECT subject_id FROM claims WHERE statement LIKE '20cm 涨停板%'`))).toEqual([{ subject_id: '20cm' }]);
    expect((await row('a股')).aliases).not.toContain('创业板');
    expect(await carrying('创业板')).toBe(evidenceBefore + 1);
    // tier-0 links and the view's marking read the keys: 创业板 now marks the board, not A股
    expect((await tier0Known(store, { force: true })).index.byKey.get('创业板')?.id).toBe('创业板');
    // a document applied before the correction keeps what it resolved then, until it is applied again
    expect(await claimOn20cm()).toEqual(['a股']);
    await sync(ctx, { llmGraph: false, reapply: true, only: ['raw/docs/c.md'] });
    expect(await claimOn20cm()).toEqual(['20cm']);

    // a member merged into A股 does not bring a refused spelling back
    await applyMerge(store, { entityId: '沪深股市', canonicalId: 'a股', reason: 'test' });
    expect(await keys('a股')).toContain('沪深股市');
    expect(await keys('a股')).not.toContain('chinext');
    expect((await resolveEntityId(store, { name: 'ChiNext' }, undefined, { corrections })).id).not.toBe('a股');

    // taking it back restores what the extractors said
    await correctEntity(store, { entity: 'a股', clear: true });
    expect(readEntityCorrections(dataDir).has('a股')).toBe(false);
    expect(await row('a股')).toMatchObject({ type: 'dataset' });
    expect(await keys('a股')).toEqual(expect.arrayContaining(['20cm', '创业板', 'chinext']));

    // corrected again, it survives a rebuild: the file is declared state the fold reads
    await correctEntity(store, { entity: 'a股', type: 'market', notAliases: ['创业板', '20cm'] });
    await correctEntity(store, { entity: 'a股', allowAliases: ['20cm'] });
    expect(readEntityCorrections(dataDir).get('a股')).toMatchObject({ type: 'market', notAliases: ['创业板'] });
    await rebuild(ctx);
    expect(await ctx.store.query(`SELECT type FROM entities WHERE id = 'a股'`)).toEqual([{ type: 'market' }]);
    const rebuilt = (await ctx.store.query<{ alias_key: string }>(`SELECT alias_key FROM entity_alias_keys WHERE entity_id = 'a股'`)).map((r) => r.alias_key);
    expect(rebuilt).not.toContain('创业板');
    expect(rebuilt).toContain('20cm');

    // a hand-edited type the ontology does not have is ignored: the fold keeps its own pick
    writeEntityCorrections(dataDir, new Map([['a股', { type: 'board' }]]));
    expect((await correctEntity(ctx.store, { entity: 'a股' })).after.type).toBe('dataset');
  });
});
