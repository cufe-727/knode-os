import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { codeOf, codesConflict, codesOf, documentContext, namesakeFor, NamesakeRule } from '../src/graph/identity.js';
import { builtinOntology } from '../src/graph/ontology.js';
import { resolveEntityContext } from '../src/graph/entity-context.js';
import { resolveEntityId } from '../src/graph/resolve.js';
import { sync } from '../src/ingest/sync.js';

/**
 * Same name, different thing (src/graph/identity.ts): what an extraction
 * records for a mention — a code among its spellings, its team or parent, the
 * organizations of its document — and how write-time resolution uses it.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-identity-'));
const opened: AppContext[] = [];
afterAll(async () => {
  for (const c of opened) {
    await c.datasources.closeAll();
    await c.store.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('codes among spellings', () => {
  it('reads an identifier, its shape and its value', () => {
    expect(codeOf('D7T1-C1')).toMatchObject({ shape: 'D#T#-C#', value: 'D7T1-C1' });
    expect(codeOf('t1-c1')).toMatchObject({ shape: 'T#-C#', value: 'T1-C1' });
    expect(codeOf('00700.HK')?.value).toBe('700.HK');
    expect(codeOf('700.HK')?.value).toBe('700.HK');
    // a word, a number, a name with a space or Han characters is no code
    for (const s of ['Atlas', '300750', 'A股', 'GPT 4', '5G', '订单库连接池上限', 'a-very-long-identifier-with-1-digit']) expect(codeOf(s)).toBeNull();
  });

  it('keeps the codes that identify a thing: one per shape, the longer of two that end alike', () => {
    expect([...codesOf(['日志保留天数', 'D7T1-C2', '保留期']).values()].map((c) => c.value)).toEqual(['D7T1-C2']);
    // an extraction listing kinds as aliases: no code of that shape names the thing
    expect(codesOf(['芯片', 'H100', 'H200']).size).toBe(0);
    // a known name repeated beside the full code
    expect([...codesOf(['T1-C1', '订单库连接池上限', 'D9T1-C1']).values()].map((c) => c.value)).toEqual(['D9T1-C1']);
  });

  it('finds a conflict only between codes of one kind that differ', () => {
    const c = (...s: string[]) => codesOf(s);
    expect(codesConflict(c('D7T1-C1'), c('D2T1-C1'))).toBe(true);
    expect(codesConflict(c('D7T1-C1'), c('D7T1-C1', '池上限'))).toBe(false);
    // a code and the same with something in front may be two things too (the first division wrote no prefix)
    expect(codesConflict(c('D7T1-C1'), c('T1-C1'))).toBe(true);
    expect(codesConflict(c('D7T1-C1'), c('T2-C1'))).toBe(false);
    expect(codesConflict(c('00700.HK'), c('700.HK'))).toBe(false);
    expect(codesConflict(c('D7T1-C1'), c('订单库连接池上限'))).toBe(false);
    // one code in common outweighs another that differs
    expect(codesConflict(c('D7T1-C1', 'R-71'), c('D7T1-C1', 'R-72'))).toBe(false);
  });
});

describe('the context of a mention', () => {
  const ontology = builtinOntology();
  const entities = [
    { name: '二部平台组', type: 'organization' },
    { name: '安全团队', type: 'organization' },
    { name: '陈伟', type: 'person' },
    { name: '任杰', type: 'person' },
    { name: '日志保留天数', type: 'component', aliases: ['D2T1-C2', '保留期'] },
  ];
  const relations = [
    { source: '陈伟', target: '二部平台组', type: 'member_of' },
    { source: '任杰', target: '二部平台组', type: 'member_of' },
    { source: '二部平台组', target: '安全团队', type: 'related_to' },
  ];

  it('reads a mention\'s owners from the hierarchical relations of its document', () => {
    const context = documentContext(entities, relations, ontology, { path: 'raw/docs/w.md' });
    expect(context.of('陈伟').owners).toEqual(['二部平台组']);
    expect(context.of('日志保留天数').owners).toEqual([]);
    expect(context.of('保留期').documentNames?.has('d2t1-c2')).toBe(true);
    expect(context.of('保留期').documentPath).toBe('raw/docs/w.md');
    // a related_to edge is nobody's owner
    expect(context.of('二部平台组').owners).toEqual([]);
  });

  const rule = (id: string, label: string, anchors: string[], base_anchors = ['平台组']): NamesakeRule => ({ id, base_id: '日志保留天数', name: '日志保留天数', label, anchors, base_anchors });
  const rules = [rule('d2', 'D2T1-C2', ['二部平台组']), rule('d7', 'D7T1-C2', ['七部平台组'])];
  const names = (...n: string[]) => new Set(n.map((x) => x.toLowerCase()));

  it('follows a parted name by the mention\'s own code, then owner, then the document — and the base without evidence', () => {
    // the code decides, whatever the document names
    expect(namesakeFor(rules, { codes: codesOf(['日志保留天数', 'D7T1-C2']), context: { documentNames: names('二部平台组') } })?.id).toBe('d7');
    // the mention's own team, in a document that names several
    expect(namesakeFor(rules, { codes: codesOf(['日志保留天数']), context: { owners: ['七部平台组'], documentNames: names('二部平台组', '七部平台组') } })?.id).toBe('d7');
    // the document's organizations
    expect(namesakeFor(rules, { codes: codesOf(['保留期']), context: { documentNames: names('二部平台组', '安全团队') } })?.id).toBe('d2');
    // the base: its own anchor named too, two candidates alike, or nothing to go by
    expect(namesakeFor(rules, { codes: codesOf(['日志保留天数']), context: { documentNames: names('平台组', '二部平台组') } })).toBeNull();
    expect(namesakeFor(rules, { codes: codesOf(['日志保留天数']), context: { documentNames: names('二部平台组', '七部平台组') } })).toBeNull();
    expect(namesakeFor(rules, { codes: codesOf(['日志保留天数']), context: { documentNames: names('日志保留天数') } })).toBeNull();
    expect(namesakeFor(rules, { codes: codesOf(['日志保留天数']) })).toBeNull();
    expect(namesakeFor([], { codes: codesOf(['D7T1-C2']) })).toBeNull();
  });

  it('never files a mention under an entity whose code differs from its own', () => {
    // a third code, in a document that names one of the roofs: not that roof's entity
    expect(namesakeFor(rules, { codes: codesOf(['日志保留天数', 'D9T1-C2']), context: { documentNames: names('七部平台组') } })).toBeNull();
    expect(namesakeFor(rules, { codes: codesOf(['日志保留天数', 'D9T1-C2']), context: { owners: ['七部平台组'], documentNames: names('七部平台组') } })).toBeNull();
    // the code the base entity is named by: the base entity, whatever the document names
    expect(namesakeFor(rules, { codes: codesOf(['T1-C2']), baseCodes: codesOf(['T1-C2']), context: { documentNames: names('七部平台组') } })).toBeNull();
    // DDR4 is never the entity labelled DDR5
    const dram: NamesakeRule[] = [{ id: 'dram-ddr5', base_id: 'dram', name: 'DRAM', label: 'DDR5', anchors: ['美光'], base_anchors: ['三星'] }];
    expect(namesakeFor(dram, { codes: codesOf(['DRAM', 'DDR4']), context: { documentNames: names('美光') } })).toBeNull();
    expect(namesakeFor(dram, { codes: codesOf(['DRAM']), context: { documentNames: names('美光') } })?.id).toBe('dram-ddr5');
    // a code of another kind says nothing against it
    expect(namesakeFor(dram, { codes: codesOf(['DRAM', 'REQ-2025']), context: { documentNames: names('美光') } })?.id).toBe('dram-ddr5');
  });

  it('follows the split\'s own list of documents, after the code and before anything the document names', () => {
    const listed = [{ ...rules[0], documents: ['raw/docs/w9.md'] }, rules[1]];
    expect(namesakeFor(listed, { codes: codesOf(['日志保留天数']), context: { documentPath: 'raw/docs/w9.md', documentNames: names('七部平台组') } })?.id).toBe('d2');
    expect(namesakeFor(listed, { codes: codesOf(['D7T1-C2']), context: { documentPath: 'raw/docs/w9.md' } })?.id).toBe('d7');
    expect(namesakeFor(listed, { codes: codesOf(['日志保留天数']), context: { documentPath: 'raw/docs/w1.md', documentNames: names('七部平台组') } })?.id).toBe('d7');
    // the first division's code, repeated by an extraction in a document the split gave to another: the split saw it
    expect(namesakeFor(listed, { codes: codesOf(['T1-C2']), baseCodes: codesOf(['T1-C2']), context: { documentPath: 'raw/docs/w9.md' } })?.id).toBe('d2');
  });

  it('keeps the base entity\'s own code and roof: a row for the base entity itself', () => {
    const self: NamesakeRule = { id: '日志保留天数', base_id: '日志保留天数', name: '日志保留天数', label: 'D2T1-C2', anchors: ['二部平台组'], base_anchors: ['二部平台组'] };
    const family = [self, rules[1]];
    expect(namesakeFor(family, { codes: codesOf(['日志保留天数', 'D2T1-C2']), context: { documentNames: names('七部平台组') } })).toBeNull();
    expect(namesakeFor(family, { codes: codesOf(['日志保留天数']), context: { documentNames: names('二部平台组', '七部平台组') } })).toBeNull();
    expect(namesakeFor(family, { codes: codesOf(['日志保留天数']), context: { documentNames: names('七部平台组') } })?.id).toBe('d7');
  });
});

/** A team's weekly report as frontmatter-declared facts: the team, two members, and what else it names. */
function report(team: string, members: [string, string], extra: string): string {
  return `---
title: ${team}周报
entities:
  - { name: ${team}, type: organization }
  - { name: ${members[0]}, type: person }
  - { name: ${members[1]}, type: person }
${extra}
relations:
  - { source: ${members[0]}, target: ${team}, type: member_of }
  - { source: ${members[1]}, target: ${team}, type: member_of }
---
${team}周报。
`;
}

async function build(name: string, files: [string, string][]): Promise<AppContext> {
  const dataDir = path.join(tmp, name);
  for (const [p, text] of files) write(dataDir, p, text);
  initDataDir(dataDir);
  const config = loadConfig(dataDir);
  config.ingest.concurrency = 1; // in path order: an entity is whoever was written first
  config.review.identity = 'context';
  saveConfig(dataDir, config);
  const ctx = await createContext(dataDir);
  opened.push(ctx);
  await sync(ctx, { llmGraph: false });
  return ctx;
}

const docsOf = async (ctx: AppContext, id: string) => (await ctx.store.query<{ path: string }>(
  `SELECT DISTINCT d.path FROM entity_mentions m JOIN documents d ON d.id = m.document_id WHERE m.entity_id = $1 ORDER BY d.path`, [id],
)).map((r) => r.path.replace('raw/docs/', ''));

describe('write-time resolution of a name that may be two things', () => {
  it('parts nothing when a document is written, in whatever order the documents arrive', async () => {
    // a product kind three notes of one maker call DDR4 and another maker's notes call DDR5, DDR4 or nothing
    const dram = (code: string, type = 'component') => `  - { name: DRAM, type: ${type}, aliases: [${code}] }`;
    const samsung = (code: string) => report('三星', ['李在镕', '全永铉'], dram(code));
    const micron = (code: string) => report('美光', ['梅赫罗特拉', '墨菲'], dram(code));
    const first: [string, string][] = [
      ['raw/docs/a1.md', samsung('DDR4')], ['raw/docs/a2.md', samsung('DDR4')], ['raw/docs/a3.md', samsung('DDR4')],
      ['raw/docs/b1.md', micron('DDR5')], ['raw/docs/b2.md', micron('DDR5')], ['raw/docs/b3.md', micron('')], ['raw/docs/b4.md', micron('DDR4')],
    ];
    // the same documents, the other maker's first
    const second: [string, string][] = [
      ['raw/docs/a1.md', micron('DDR5')], ['raw/docs/a2.md', micron('DDR5')],
      ['raw/docs/b1.md', samsung('DDR4')], ['raw/docs/b2.md', samsung('DDR4')], ['raw/docs/b3.md', samsung('DDR4')],
      ['raw/docs/c1.md', micron('')], ['raw/docs/c2.md', micron('DDR4')],
    ];
    for (const [name, files] of [['order-a', first], ['order-b', second]] as const) {
      const ctx = await build(name, files);
      // one entity each, every document, every code among its aliases, no rule written
      expect((await docsOf(ctx, 'dram')).length, name).toBe(7);
      expect(await ctx.store.query(`SELECT id FROM entity_namesakes`), name).toEqual([]);
      expect(await ctx.store.query(`SELECT id FROM entities WHERE id LIKE 'dram%' AND tx_to IS NULL ORDER BY id`), name).toEqual([{ id: 'dram' }]);
      const [e] = await ctx.store.query<{ aliases: string[] }>(`SELECT aliases FROM entities WHERE id = 'dram'`);
      expect(e.aliases, name).toEqual(expect.arrayContaining(['DDR4', 'DDR5']));
      // and refine, which sees all of them, leaves the kind whole in either order: one maker's notes carry both codes
      const refined = await resolveEntityContext(ctx.store, { config: ctx.config });
      expect(refined.split, name).toBe(0);
      expect((await docsOf(ctx, 'dram')).length, name).toBe(7);
    }
  });

  it('leaves a category whole even where each code has a maker of its own', async () => {
    // typed as a product: no code parts it, however cleanly the makers divide
    const dram = (code: string) => `  - { name: DRAM, type: product, aliases: [${code}] }`;
    const ctx = await build('category', [
      ...[1, 2, 3].map((k): [string, string] => [`raw/docs/a${k}.md`, report('三星', ['李在镕', '全永铉'], dram('DDR4'))]),
      ...[1, 2, 3].map((k): [string, string] => [`raw/docs/b${k}.md`, report('美光', ['梅赫罗特拉', '墨菲'], dram('DDR5'))]),
    ]);
    expect((await resolveEntityContext(ctx.store, { config: ctx.config })).split).toBe(0);
    expect(await ctx.store.query(`SELECT id FROM entity_namesakes`)).toEqual([]);
    expect((await docsOf(ctx, 'dram')).length).toBe(6);
  });

  it('follows a name refine parted: by code, by its roof, and to the base without context', async () => {
    const ctx = await build('follow', [
      ['raw/docs/t.md', `---\ntitle: 团队\nentities:\n  - { name: 二部平台组, type: organization, aliases: ["Platform 2 team"] }\n  - { name: 平台组, type: organization }\n  - { name: 连接池上限, type: component, aliases: ["P1-C1", "池上限"] }\n---\n二部平台组（Platform 2 team）与平台组。\n`],
    ]);
    const store = ctx.store;
    const id = '连接池上限二部平台组-p2-c1';
    await store.query(
      `INSERT INTO entity_namesakes (id, base_id, name, label, anchors, base_anchors, documents, reason)
       VALUES ($1, '连接池上限', '连接池上限', 'P2-C1', '["二部平台组"]'::jsonb, '["平台组"]'::jsonb, '["raw/docs/w7.md"]'::jsonb, 'test')`, [id],
    );
    const doc = (...n: string[]) => new Set(n.map((x) => x.toLowerCase()));
    const to = async (input: Parameters<typeof resolveEntityId>[1]) => (await resolveEntityId(store, input)).id;
    // its code, wherever it is written
    expect(await to({ name: '连接池上限', aliases: ['P2-C1'], context: { documentNames: doc('平台组') } })).toBe(id);
    // its roof
    expect(await to({ name: '连接池上限', context: { documentNames: doc('二部平台组', '连接池上限') } })).toBe(id);
    // a document the split gave to it
    expect(await to({ name: '连接池上限', context: { documentPath: 'raw/docs/w7.md', documentNames: doc('连接池上限') } })).toBe(id);
    // the base: its own code, another code under the other roof, both roofs, or nothing to go by
    expect(await to({ name: '连接池上限', aliases: ['P1-C1'], context: { documentNames: doc('二部平台组') } })).toBe('连接池上限');
    expect(await to({ name: '连接池上限', aliases: ['P9-C1'], context: { documentNames: doc('二部平台组') } })).toBe('连接池上限');
    expect(await to({ name: '连接池上限', context: { documentNames: doc('二部平台组', '平台组') } })).toBe('连接池上限');
    expect(await to({ name: '连接池上限' })).toBe('连接池上限');
    expect(await to({ name: '池上限' })).toBe('连接池上限');
    // nothing was written by resolving
    expect(await store.query(`SELECT count(*)::int AS n FROM entity_namesakes`)).toEqual([{ n: 1 }]);
  });
});
