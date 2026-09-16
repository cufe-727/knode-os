import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { auditDuplicateEntities, mergeSuggestionId } from '../src/graph/dedupe.js';
import { applyMerge, listMerges, unmergeEntity } from '../src/graph/merge.js';
import { entityKeys, nameKey, stripCorporateSuffix } from '../src/graph/normalize.js';
import { claimsForEntities, graphSearch } from '../src/graph/query.js';
import { resolveEntityId } from '../src/graph/resolve.js';
import { sync } from '../src/ingest/sync.js';
import { rebuild } from '../src/lineage/rebuild.js';
import { applySuggestion } from '../src/pack/learn.js';
import { matchEntities } from '../src/pack/pack.js';
import { queryClaims } from '../src/store/claims.js';
import { listSuggestions, setSuggestionStatus } from '../src/store/queries.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { initDataDir } from '../src/fs/datadir.js';

/**
 * Entity resolution: normalization keys, write-time resolution of other
 * spellings onto the known entity, the nightly duplicate audit proposing
 * merges, accepting a merge as a reversible link that every read path
 * follows, and the decision surviving a rebuild.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-resolution-'));
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

describe('name normalization', () => {
  it('folds width, case, punctuation and corporate suffixes', () => {
    expect(nameKey('Ｃ.A.T.L').key).toBe('catl');
    expect(nameKey('宁德时代新能源科技股份有限公司')).toEqual({ key: '宁德时代新能源科技股份有限公司', bare: '宁德时代新能源科技' });
    expect(nameKey('腾讯控股')).toEqual({ key: '腾讯控股', bare: '腾讯' });
    expect(nameKey('Tesla, Inc.')).toEqual({ key: 'teslainc', bare: 'tesla' });
    expect(nameKey('Contemporary Amperex Technology Co., Ltd.').bare).toBe('contemporaryamperextechnology');
    expect(stripCorporateSuffix('Costco Wholesale Corporation')).toBe('Costco Wholesale');
    expect(nameKey('公司').bare).toBe('公司'); // nothing left to strip to
    expect(nameKey('集团')).toEqual({ key: '集团', bare: '集团' });
    expect([...entityKeys('宁德时代', ['CATL', '300750'])].sort()).toEqual(['300750', 'catl', '宁德时代']);
  });
});

describe('write-time resolution and merges', () => {
  it('lands other spellings on the known entity, proposes fuzzy duplicates, and merges reversibly', async () => {
    const dataDir = path.join(tmp, 'ws');
    write(dataDir, 'raw/docs/a.md', `---
title: 宁德时代简介
entities:
  - { name: 宁德时代, type: organization, aliases: ["CATL", "300750"], description: 动力电池制造商 }
claims:
  - { subject: 宁德时代, statement: 2025 年动力电池装机量全球第一, type: market }
---
宁德时代（CATL，300750）是全球最大的动力电池制造商，总部位于福建宁德。
`);
    write(dataDir, 'raw/docs/b.md', `---
title: CATL 供应链
entities:
  - { name: CATL, type: organization }
  - { name: 特斯拉, type: organization }
relations:
  - { source: CATL, target: 特斯拉, type: supplies_to }
claims:
  - { subject: CATL, statement: 2024 年向特斯拉供应磷酸铁锂电池, type: supply }
---
CATL 向特斯拉供应磷酸铁锂电池。
`);
    write(dataDir, 'raw/docs/c.md', `---
title: 年报摘录
entities:
  - { name: 宁德时代新能源科技股份有限公司, type: organization }
claims:
  - { subject: 宁德时代新能源科技股份有限公司, statement: 2025 年营业收入 4000 亿元, type: revenue }
---
宁德时代新能源科技股份有限公司 2025 年营业收入 4000 亿元。
`);
    // apply documents one at a time so a.md's alias is known before b.md mentions CATL (ids are first-come)
    initDataDir(dataDir);
    const config = loadConfig(dataDir);
    config.ingest.concurrency = 1;
    saveConfig(dataDir, config);
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });

    // "CATL" is an alias of 宁德时代, so b.md's entity and claim resolved to it — no separate "catl" entity
    const catl = await ctx.store.query<{ id: string }>(`SELECT id FROM entities WHERE id = 'catl'`);
    expect(catl).toEqual([]);
    const supply = await ctx.store.query<{ source_id: string; target_id: string }>(`SELECT source_id, target_id FROM relations WHERE type = 'supplies_to' AND tx_to IS NULL`);
    expect(supply).toEqual([{ source_id: '宁德时代', target_id: '特斯拉' }]);
    const subjects = await ctx.store.query<{ subject_id: string }>(`SELECT subject_id FROM claims WHERE statement LIKE '2024 年向特斯拉%'`);
    expect(subjects).toEqual([{ subject_id: '宁德时代' }]);
    expect(JSON.stringify(await resolveEntityId(ctx.store, { name: 'catl', type: 'organization' }))).toContain('"id":"宁德时代"');
    expect((await resolveEntityId(ctx.store, { name: '比亚迪', type: 'organization' })).id).toBe('比亚迪');

    // the long legal name is a different key, so it stayed separate — until the audit notices the short name is its prefix
    const legal = await ctx.store.query<{ id: string; canonical_id: string | null }>(`SELECT id, canonical_id FROM entities WHERE id = '宁德时代新能源科技股份有限公司'`);
    expect(legal).toEqual([{ id: '宁德时代新能源科技股份有限公司', canonical_id: null }]);
    const audit = await auditDuplicateEntities(ctx, {});
    expect(audit.suggested).toBeGreaterThanOrEqual(1);
    const pending = await listSuggestions(ctx.store, { status: 'pending' });
    const merge = pending.find((s) => s.kind === 'merge' && s.id === mergeSuggestionId('宁德时代', '宁德时代新能源科技股份有限公司'));
    expect(merge?.payload).toMatchObject({ entityId: '宁德时代新能源科技股份有限公司', canonicalId: '宁德时代' });

    // accepting the suggestion records the link; every read path follows it
    await setSuggestionStatus(ctx.store, merge!.id, 'accepted');
    const applied = await applySuggestion(ctx.store, dataDir, merge!.id);
    expect(applied).toMatchObject({ applied: true, merged: { entityId: '宁德时代新能源科技股份有限公司', canonicalId: '宁德时代' } });
    expect((await listMerges(ctx.store)).map((m) => [m.entityId, m.canonicalId])).toEqual([['宁德时代新能源科技股份有限公司', '宁德时代']]);

    // id-based claim reads include everything merged into the survivor (name-based queryClaims already matched by substring)
    expect((await claimsForEntities(ctx.store, ['宁德时代'], 20)).map((c) => c.type).sort()).toEqual(['market', 'revenue', 'supply']);
    expect((await queryClaims(ctx.store, { subject: '300750' })).claims.map((c) => c.type).sort()).toEqual(['market', 'revenue', 'supply']);
    const graph = await graphSearch(ctx.store, '宁德时代新能源科技股份有限公司', { depth: 1, track: false });
    expect(graph.nodes.map((n) => n.id)).toContain('宁德时代');
    expect(graph.nodes.map((n) => n.id)).not.toContain('宁德时代新能源科技股份有限公司');
    const matched = await matchEntities(ctx, '宁德时代新能源科技股份有限公司的营收', 4);
    expect(matched.map((e) => e.id)).toEqual(['宁德时代']);
    // new mentions of the merged spelling land on the survivor
    expect((await resolveEntityId(ctx.store, { name: '宁德时代新能源科技股份有限公司' })).id).toBe('宁德时代');

    // the decision survives a rebuild, and unmerge reverts it
    const report = await rebuild(ctx);
    expect(report.feedbackReplayed).toBeGreaterThanOrEqual(1); // the merge decision (suggestion rows are not rebuilt)
    expect(await ctx.store.query(`SELECT canonical_id FROM entities WHERE id = '宁德时代新能源科技股份有限公司'`)).toEqual([{ canonical_id: '宁德时代' }]);
    expect(await unmergeEntity(ctx.store, '宁德时代新能源科技股份有限公司')).toBe(true);
    expect(await ctx.store.query(`SELECT canonical_id FROM entities WHERE id = '宁德时代新能源科技股份有限公司'`)).toEqual([{ canonical_id: null }]);
    expect((await claimsForEntities(ctx.store, ['宁德时代'], 20)).map((c) => c.type).sort()).toEqual(['market', 'supply']);

    // a rejected pair is never proposed again (the audit re-proposes after the unmerge, then a person says no)
    await auditDuplicateEntities(ctx, {});
    expect((await listSuggestions(ctx.store, { status: 'pending' })).some((s) => s.id === merge!.id)).toBe(true);
    await setSuggestionStatus(ctx.store, merge!.id, 'rejected');
    await auditDuplicateEntities(ctx, {});
    expect((await listSuggestions(ctx.store, { status: 'pending' })).some((s) => s.id === merge!.id)).toBe(false);

    // merging by hand goes through the same path
    const r = await applyMerge(ctx.store, { entityId: '宁德时代新能源科技股份有限公司', canonicalId: '宁德时代', reason: 'manual' });
    expect(r.outcome).toBe('merged');
    await expect(applyMerge(ctx.store, { entityId: '宁德时代', canonicalId: '宁德时代新能源科技股份有限公司' })).rejects.toThrow(/itself|already merged/);
  });
});
