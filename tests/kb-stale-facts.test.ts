import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { initDataDir } from '../src/fs/datadir.js';
import { namesApartByCode, nameCode } from '../src/graph/resolve.js';
import { sync } from '../src/ingest/sync.js';

/**
 * Facts the 10× reports benchmark showed missing or stale in a built knowledge
 * base (2026-11-15): incidents of one title taken by another incident's
 * entity, and the rest of this file's cases.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-stale-facts-'));
const contexts: AppContext[] = [];
afterAll(async () => {
  for (const ctx of contexts) {
    await ctx.datasources.closeAll();
    await ctx.store.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

async function workspace(name: string, docs: Record<string, string>): Promise<AppContext> {
  const dataDir = path.join(tmp, name);
  for (const [rel, text] of Object.entries(docs)) write(dataDir, rel, text);
  initDataDir(dataDir);
  const config = loadConfig(dataDir);
  config.ingest.concurrency = 1;
  saveConfig(dataDir, config);
  const ctx = await createContext(dataDir);
  contexts.push(ctx);
  await sync(ctx, { llmGraph: false });
  return ctx;
}

describe('identifiers of one kind', () => {
  it('reads the identifier a name is', () => {
    expect(nameCode('INC-020-D3T3')?.value).toBe('INC-20-D3T3');
    expect(nameCode('事故INC-020-D3T3')?.value).toBe('INC-20-D3T3');
    expect(nameCode('活动页白屏')).toBeNull();
    expect(namesApartByCode('INC-017-D7T3', 'INC-020-D3T3')).toBe(true);
    expect(namesApartByCode('INC-020-D3T3', '事故INC-020-D3T3')).toBe(false);
    expect(namesApartByCode('INC-020-D3T3', '活动页白屏')).toBe(false);
  });

  it('gives each incident its own entity although both list the title as an alias', async () => {
    const ctx = await workspace('incidents', {
      'raw/docs/a.md': `---
title: 七部增长组周报
entities:
  - { name: INC-017-D7T3, type: event, aliases: ["活动页白屏"] }
claims:
  - { subject: INC-017-D7T3, statement: INC-017-D7T3已由周磊修复, type: event }
---
INC-017-D7T3（P1）活动页白屏，周磊修复。
`,
      'raw/docs/b.md': `---
title: 三部增长组周报
entities:
  - { name: INC-020-D3T3, type: event, aliases: ["活动页白屏"] }
claims:
  - { subject: INC-020-D3T3, statement: INC-020-D3T3已由吴婷修复, type: event }
---
INC-020-D3T3（P1）活动页白屏，吴婷修复。
`,
    });
    const rows = await ctx.store.query<{ subject_id: string; statement: string }>(`SELECT subject_id, statement FROM claims WHERE tx_to IS NULL ORDER BY statement`);
    expect(rows).toEqual([
      { subject_id: 'inc-017-d7t3', statement: 'INC-017-D7T3已由周磊修复' },
      { subject_id: 'inc-020-d3t3', statement: 'INC-020-D3T3已由吴婷修复' },
    ]);
    // the title alone still finds an incident of that title
    const both = await ctx.store.query<{ id: string }>(`SELECT id FROM entities WHERE tx_to IS NULL AND id LIKE 'inc-%' ORDER BY id`);
    expect(both.map((r) => r.id)).toEqual(['inc-017-d7t3', 'inc-020-d3t3']);
  });
});

describe('back-references to the previous report', () => {
  it('reads what a statement refers back to, and nothing when it names an identifier', async () => {
    const { backReferenceIn } = await import('../src/graph/backrefs.js');
    expect(backReferenceIn('上周那起缓存击穿已由方杰修复，根因是参数填反了')).toBe('缓存击穿');
    expect(backReferenceIn('方杰已修复上周发生的配置下发失败。')).toBe('配置下发失败');
    expect(backReferenceIn('上周发生的登录失败事故已由贾洋修复。')).toBe('登录失败');
    expect(backReferenceIn('上周发生的缓存击穿问题根因是一处空指针。')).toBe('缓存击穿');
    expect(backReferenceIn('上周发生了一起推送重复事故。')).toBe('推送重复');
    expect(backReferenceIn('十部增长组上周的登录失败事故根因是机器资源不足。')).toBe('登录失败');
    expect(backReferenceIn("Last week's cache stampede was fixed by Fang Jie")).toBe('cache stampede');
    expect(backReferenceIn('上周那起INC-001-T1已由方杰修复')).toBeNull();
    expect(backReferenceIn('方杰本周完成接口评审')).toBeNull();
  });

  it('links the fixer to the one identified incident of that description in the same series the period before', async () => {
    const report = (team: string, date: string, body: string, fm: string) => `---\ntitle: ${team}周报\ndate: ${date}\n${fm}---\n${body}\n`;
    const ctx = await workspace('backrefs', {
      'raw/docs/周报/平台组/w05.md': report('平台组', '2025-02-03', 'INC-001-T1（P1）缓存击穿；INC-002-T1（P3）数据延迟', `entities:
  - { name: INC-001-T1, type: event }
  - { name: INC-002-T1, type: event }
claims:
  - { subject: INC-001-T1, statement: INC-001-T1为P1级缓存击穿事故, type: event }
  - { subject: INC-002-T1, statement: INC-002-T1为P3级数据延迟事故, type: event }
`),
      'raw/docs/周报/平台组/w06.md': report('平台组', '2025-02-10', '上周那起缓存击穿已由方杰修复；上周那起数据延迟已由廖欣修复', `entities:
  - { name: 方杰, type: person }
  - { name: 廖欣, type: person }
claims:
  - { subject: 方杰, statement: 方杰已修复上周发生的缓存击穿, type: event }
  - { subject: 廖欣, statement: 上周那起数据延迟已由廖欣修复, type: event }
`),
      // another team's incident of the same title, and a week whose report has two of them
      'raw/docs/周报/支付组/w05.md': report('支付组', '2025-02-03', 'INC-003-T2（P1）缓存击穿；INC-004-T2（P1）缓存击穿', `entities:
  - { name: INC-003-T2, type: event }
  - { name: INC-004-T2, type: event }
claims:
  - { subject: INC-003-T2, statement: INC-003-T2为P1级缓存击穿事故, type: event }
  - { subject: INC-004-T2, statement: INC-004-T2为P1级缓存击穿事故, type: event }
`),
      'raw/docs/周报/支付组/w06.md': report('支付组', '2025-02-10', '上周那起缓存击穿已由郭军修复', `entities:
  - { name: 郭军, type: person }
claims:
  - { subject: 郭军, statement: 上周那起缓存击穿已由郭军修复, type: event }
`),
    });
    const { linkBackReferences } = await import('../src/graph/backrefs.js');
    const stats = await linkBackReferences(ctx.store);
    expect(stats).toMatchObject({ references: 3, resolved: 2, linked: 2, disposed: 0 });
    const links = await ctx.store.query<{ source_id: string; target_id: string }>(
      `SELECT source_id, target_id FROM relations WHERE tx_to IS NULL AND target_id LIKE 'inc-%' ORDER BY source_id`,
    );
    expect(links).toEqual([{ source_id: '廖欣', target_id: 'inc-002-t1' }, { source_id: '方杰', target_id: 'inc-001-t1' }]);
    // a second run keeps them; once the reading no longer holds, the link goes
    expect(await linkBackReferences(ctx.store)).toMatchObject({ resolved: 2, disposed: 0 });
    await ctx.store.query(`UPDATE documents SET doc_date = doc_date - interval '30 days' WHERE path = 'raw/docs/周报/平台组/w05.md'`);
    expect(await linkBackReferences(ctx.store)).toMatchObject({ resolved: 0, disposed: 2 });
    expect(await ctx.store.query(`SELECT 1 FROM relations WHERE tx_to IS NULL AND target_id LIKE 'inc-%'`)).toEqual([]);
  });
});

describe('a title several incidents carry', () => {
  it('resolves to none of them', async () => {
    const ctx = await workspace('shared-title', {
      'raw/docs/a.md': `---\ntitle: a\nentities:\n  - { name: INC-001-T1, type: event, aliases: ["登录失败事故"] }\n---\nINC-001-T1 登录失败事故\n`,
      'raw/docs/b.md': `---\ntitle: b\nentities:\n  - { name: INC-005-T3, type: event, aliases: ["登录失败事故"] }\n---\nINC-005-T3 登录失败事故\n`,
      'raw/docs/c.md': `---\ntitle: c\nentities:\n  - { name: 登录失败事故, type: event }\nclaims:\n  - { subject: 登录失败事故, statement: 上周发生的登录失败事故已由贾洋修复, type: event }\n---\n上周发生的登录失败事故已由贾洋修复\n`,
    });
    const [row] = await ctx.store.query<{ subject_id: string }>(`SELECT subject_id FROM claims WHERE tx_to IS NULL AND statement LIKE '上周%'`);
    expect(row.subject_id).toBe('登录失败事故');
  });

  it('gives a numbered incident its own entity rather than the title entity its alias names', async () => {
    const ctx = await workspace('numbered', {
      'raw/docs/a.md': `---\ntitle: a\nentities:\n  - { name: INC-001-T1, type: event, aliases: ["登录失败事故"] }\n---\nINC-001-T1 登录失败事故\n`,
      'raw/docs/b.md': `---\ntitle: b\nentities:\n  - { name: 登录失败事故, type: event }\n---\n登录失败事故\n`,
      'raw/docs/c.md': `---\ntitle: c\nentities:\n  - { name: INC-005-T3, type: event, aliases: ["登录失败事故"] }\nclaims:\n  - { subject: INC-005-T3, statement: INC-005-T3已由尹婷修复, type: event }\n---\nINC-005-T3 登录失败事故\n`,
    });
    const [row] = await ctx.store.query<{ subject_id: string }>(`SELECT subject_id FROM claims WHERE tx_to IS NULL AND statement LIKE 'INC-005%'`);
    expect(row.subject_id).toBe('inc-005-t3');
  });
});

describe('a setting named by its code alone', () => {
  it('joins the entity a coded split labelled with that code', async () => {
    const { splitEntities } = await import('../src/graph/entity-context.js');
    const { slugify } = await import('../src/graph/store.js');
    const parted = '日志保留天数（七部平台组 · D7T1-C2）';
    const ctx = await workspace('coded', {
      // the code alone, applied before the report that introduces it
      'raw/docs/a0.md': `---\ntitle: 七部平台组周报\nentities:\n  - { name: D7T1-C2, type: other }\nclaims:\n  - { subject: D7T1-C2, statement: D7T1-C2调整为45天, type: other }\n---\nD7T1-C2调整为45天\n`,
      'raw/docs/c1.md': `---\ntitle: 七部平台组周报\nentities:\n  - { name: ${parted}, type: other, aliases: ["保留期"] }\nclaims:\n  - { subject: ${parted}, statement: 日志保留天数定为30天, type: other }\n---\n日志保留天数（D7T1-C2）定为30天\n`,
    });
    // what a coded split leaves on record: the parted entity and its rule
    const id = slugify(parted);
    expect((await ctx.store.query(`SELECT id FROM entities WHERE id = $1 AND tx_to IS NULL`, [id])).length).toBe(1);
    await ctx.store.query(
      `INSERT INTO entity_namesakes (id, base_id, name, label, anchors, base_anchors, documents, reason)
       VALUES ($1, '日志保留天数', '日志保留天数', 'D7T1-C2', '["七部平台组"]'::jsonb, '[]'::jsonb, '["raw/docs/c1.md"]'::jsonb, 'test')`, [id],
    );
    // the merge is the coded split's companion: a workspace that turned the split on
    ctx.config.review.identity = 'context';
    await splitEntities(ctx.store, { config: ctx.config });
    const [code] = await ctx.store.query<{ canonical_id: string | null }>(`SELECT canonical_id FROM entities WHERE id = 'd7t1-c2'`);
    expect(code.canonical_id).toBe(id);
    // undone by a person, it is not made again
    const { unmergeEntity } = await import('../src/graph/merge.js');
    await unmergeEntity(ctx.store, 'd7t1-c2');
    await splitEntities(ctx.store, { config: ctx.config });
    const [after] = await ctx.store.query<{ canonical_id: string | null }>(`SELECT canonical_id FROM entities WHERE id = 'd7t1-c2'`);
    expect(after.canonical_id).toBeNull();
  });
});

describe('a rename between a project and a product', () => {
  it('merges the old name into the new when the extraction typed the two differently', async () => {
    const { renameTypes, resolveEntityContext } = await import('../src/graph/entity-context.js');
    expect(renameTypes('project', 'product')).toBe(true);
    expect(renameTypes('organization', 'product')).toBe(false);
    const ctx = await workspace('rename-types', {
      'raw/docs/a.md': `---\ntitle: 五部平台组周报\nentities:\n  - { name: 箕宿系统, type: product }\n  - { name: 心宿方案, type: project }\nclaims:\n  - { subject: 箕宿系统, object: 心宿方案, statement: 箕宿系统自本周起更名为心宿方案, type: event }\n---\n心宿方案完成度72%（箕宿系统自本周起更名为心宿方案）\n`,
      'raw/docs/b.md': `---\ntitle: 五部平台组周报\nentities:\n  - { name: 箕宿系统, type: product }\nclaims:\n  - { subject: 箕宿系统, statement: 箕宿系统完成度为65%, type: other }\n---\n箕宿系统完成度65%\n`,
    });
    const stats = await resolveEntityContext(ctx.store, { config: ctx.config, splits: false });
    expect(stats.merged).toBe(1);
    const [old] = await ctx.store.query<{ canonical_id: string | null }>(`SELECT canonical_id FROM entities WHERE id = '箕宿系统'`);
    expect(old.canonical_id).toBe('心宿方案');
  });
});
