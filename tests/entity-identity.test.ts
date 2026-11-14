import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { codeOf, codesConflict, codesOf, documentContext, namesakeFor, NamesakeRule } from '../src/graph/identity.js';
import { builtinOntology } from '../src/graph/ontology.js';
import { resolveEntityId } from '../src/graph/resolve.js';
import { sync } from '../src/ingest/sync.js';

/**
 * Same name, different thing (src/graph/identity.ts): what an extraction
 * records for a mention — a code among its spellings, its team or parent, the
 * organizations of its document — and how write-time resolution uses it.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-identity-'));
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

  it('reads owners from hierarchical relations and the home the document reports for', () => {
    const context = documentContext(entities, relations, ontology, { path: 'raw/docs/w.md' });
    expect(context.home).toBe('二部平台组');
    expect(context.of('陈伟').owners).toEqual(['二部平台组']);
    expect(context.of('日志保留天数').owners).toEqual([]);
    expect(context.of('保留期').documentNames?.has('d2t1-c2')).toBe(true);
    // a related_to edge is nobody's owner, and one member_of gives no home
    expect(documentContext(entities, relations.slice(1), ontology).home).toBeNull();
  });

  const rule = (id: string, label: string, anchors: string[], base_anchors = ['平台组']): NamesakeRule => ({ id, base_id: '日志保留天数', name: '日志保留天数', label, anchors, base_anchors });
  const rules = [rule('d2', 'D2T1-C2', ['二部平台组']), rule('d7', 'D7T1-C2', ['七部平台组'])];
  const names = (...n: string[]) => new Set(n.map((x) => x.toLowerCase()));

  it('chooses among parted entities by code, then owner, then the document, and the base without evidence', () => {
    // the code decides, whatever the document names
    expect(namesakeFor(rules, { codes: codesOf(['日志保留天数', 'D7T1-C2']), context: { documentNames: names('二部平台组') } })?.id).toBe('d7');
    // the mention's own team, in a document that names several
    expect(namesakeFor(rules, { codes: codesOf(['日志保留天数']), context: { owners: ['七部平台组'], documentNames: names('二部平台组', '七部平台组') } })?.id).toBe('d7');
    // the document's organizations
    expect(namesakeFor(rules, { codes: codesOf(['保留期']), context: { documentNames: names('二部平台组', '安全团队') } })?.id).toBe('d2');
    // the base entity's own code gives nothing over the document: an extraction repeats a known name
    expect(namesakeFor(rules, { codes: codesOf(['T1-C2']), context: { documentNames: names('七部平台组') } })?.id).toBe('d7');
    // the base: its own anchor named too, two candidates alike, or nothing to go by
    expect(namesakeFor(rules, { codes: codesOf(['日志保留天数']), context: { documentNames: names('平台组', '二部平台组') } })).toBeNull();
    expect(namesakeFor(rules, { codes: codesOf(['日志保留天数']), context: { documentNames: names('二部平台组', '七部平台组') } })).toBeNull();
    expect(namesakeFor(rules, { codes: codesOf(['日志保留天数']), context: { documentNames: names('日志保留天数') } })).toBeNull();
    expect(namesakeFor(rules, { codes: codesOf(['日志保留天数']) })).toBeNull();
    expect(namesakeFor([], { codes: codesOf(['D7T1-C2']) })).toBeNull();
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

describe('write-time resolution of a name that is two things', () => {
  it('parts a mention whose code differs under another roof, and merges what has no such context', async () => {
    const dataDir = path.join(tmp, 'ws');
    const pool = (code?: string, more = '') => `  - { name: 连接池上限, type: component, aliases: [${[code, more].filter(Boolean).join(', ')}] }`;
    // three reports of 平台组 make the setting and its roof
    write(dataDir, 'raw/docs/a1.md', report('平台组', ['罗芳', '方杰'], pool('P1-C1', '池上限')));
    write(dataDir, 'raw/docs/a2.md', report('平台组', ['罗芳', '方杰'], pool()));
    write(dataDir, 'raw/docs/a3.md', report('平台组', ['罗芳', '方杰'], pool('P1-C1')));
    // 二部平台组 has a setting of the same name, with a code of its own
    write(dataDir, 'raw/docs/b1.md', report('二部平台组', ['廖欣', '赖艳'], pool('P2-C1')));
    // later mentions: without the code in 二部平台组's report, by its short name in 平台组's, and with no context at all
    write(dataDir, 'raw/docs/b2.md', report('二部平台组', ['廖欣', '赖艳'], pool()));
    write(dataDir, 'raw/docs/c1.md', report('平台组', ['罗芳', '方杰'], '  - { name: 池上限, type: component }'));
    write(dataDir, 'raw/docs/c2.md', `---
title: 备忘
entities:
  - { name: 连接池上限, type: component }
---
连接池上限需要复核。
`);
    // a hub: kinds listed as aliases, no roof of its own — a differing code merges as it always did
    const chip = (alias: string, org: string) => `---
title: 芯片 ${alias}
entities:
  - { name: 芯片, type: product, aliases: [${alias}] }
  - { name: ${org}, type: organization }
  - { name: 黄仁勋, type: person }
  - { name: 苏姿丰, type: person }
relations:
  - { source: 黄仁勋, target: ${org}, type: member_of }
  - { source: 苏姿丰, target: ${org}, type: member_of }
---
芯片 ${alias}。
`;
    write(dataDir, 'raw/docs/d1.md', chip('H100', '英伟达'));
    write(dataDir, 'raw/docs/d2.md', chip('H100', '台积电'));
    write(dataDir, 'raw/docs/d3.md', chip('H100', '超微'));
    write(dataDir, 'raw/docs/d4.md', chip('H200', '博通'));
    // one ticker written two ways is one company
    write(dataDir, 'raw/docs/e1.md', `---\ntitle: 腾讯\nentities:\n  - { name: 腾讯, type: organization, aliases: ["00700.HK"] }\n---\n腾讯。\n`);
    write(dataDir, 'raw/docs/e2.md', `---\ntitle: 腾讯控股\nentities:\n  - { name: 腾讯, type: organization, aliases: ["700.HK", "腾讯控股"] }\n---\n腾讯控股。\n`);

    initDataDir(dataDir);
    const config = loadConfig(dataDir);
    config.ingest.concurrency = 1; // in path order: an entity is whoever was written first
    saveConfig(dataDir, config);
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
    const store = ctx.store;
    const docsOf = async (id: string) => (await store.query<{ path: string }>(
      `SELECT DISTINCT d.path FROM entity_mentions m JOIN documents d ON d.id = m.document_id WHERE m.entity_id = $1 ORDER BY d.path`, [id],
    )).map((r) => r.path.replace('raw/docs/', ''));

    // the setting of 二部平台组 is an entity of its own, and the rule is on record with its reason
    const [ns] = await store.query<{ id: string; base_id: string; label: string; anchors: string[]; base_anchors: string[]; documents: string[]; reason: string }>(
      `SELECT id, base_id, label, anchors, base_anchors, documents, reason FROM entity_namesakes`,
    );
    expect(ns).toMatchObject({ base_id: '连接池上限', label: 'P2-C1', anchors: ['二部平台组'], base_anchors: ['平台组'], documents: ['raw/docs/b1.md'] });
    expect(ns.reason).toContain('P2-C1');
    const [variant] = await store.query<{ name: string; aliases: string[] }>(`SELECT name, aliases FROM entities WHERE id = $1`, [ns.id]);
    expect(variant.name).toBe('连接池上限（P2-C1）');
    expect(variant.aliases).toEqual(expect.arrayContaining(['P2-C1', '连接池上限']));
    expect(variant.aliases).not.toContain('P1-C1');
    // each report's mention is with its own team's setting; the note with no context stays with the name
    expect(await docsOf(ns.id)).toEqual(['b1.md', 'b2.md']);
    expect(await docsOf('连接池上限')).toEqual(['a1.md', 'a2.md', 'a3.md', 'c1.md', 'c2.md']);
    const [base] = await store.query<{ aliases: string[] }>(`SELECT aliases FROM entities WHERE id = '连接池上限'`);
    expect(base.aliases).toEqual(expect.arrayContaining(['P1-C1', '池上限']));
    expect(base.aliases).not.toContain('P2-C1');

    // an alias still resolves, and so does the code, to the entity that carries it
    expect((await resolveEntityId(store, { name: '池上限' })).id).toBe('连接池上限');
    expect((await resolveEntityId(store, { name: 'P1-C1' })).id).toBe('连接池上限');
    expect((await resolveEntityId(store, { name: 'P2-C1' })).id).toBe(ns.id);
    expect((await resolveEntityId(store, { name: '连接池上限', aliases: ['P2-C1'] })).id).toBe(ns.id);
    // no context: the name, as before
    expect((await resolveEntityId(store, { name: '连接池上限' })).id).toBe('连接池上限');

    // the hub stays one entity and no rule was written for it; the ticker is one company
    expect(await docsOf('芯片')).toEqual(['d1.md', 'd2.md', 'd3.md', 'd4.md']);
    expect(await store.query(`SELECT id FROM entity_namesakes WHERE base_id = '芯片'`)).toEqual([]);
    expect(await docsOf('腾讯')).toEqual(['e1.md', 'e2.md']);
    expect(await store.query(`SELECT id FROM entities WHERE id LIKE '腾讯（%' OR id LIKE '芯片（%'`)).toEqual([]);
  });
});
