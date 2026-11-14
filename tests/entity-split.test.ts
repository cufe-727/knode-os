import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { CodedDoc, codedClusters, medianDate, namesakeClusters, NamesakeDoc, resolveEntityContext, sequentialShare } from '../src/graph/entity-context.js';
import { codesOf } from '../src/graph/identity.js';
import { applyMerge } from '../src/graph/merge.js';
import { resolveEntityId } from '../src/graph/resolve.js';
import { RawExtractReply } from '../src/graph/llm-extract.js';
import { enqueueTier1, runTier1Pass } from '../src/graph/tier1.js';
import { sync } from '../src/ingest/sync.js';
import { LlmClient } from '../src/llm/client.js';

/**
 * Refine's splits (src/graph/entity-context.ts): two people of one name told
 * apart when the documents carry no date of their own, and one entity that
 * holds several coded things parted by code — with the documents re-applied
 * from their sidecars, no model call.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-split-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const TYPES: Record<string, string> = { 平台组: 'organization', 二部平台组: 'organization', 三部平台组: 'organization', 英伟达: 'organization', 安全团队: 'organization', 罗芳: 'person', 廖欣: 'person', 方杰: 'person' };
const typeOf = (id: string) => TYPES[id];

describe('the middle of the dates a document states', () => {
  it('takes the median, so one plan or one look back does not date the document', () => {
    expect(medianDate(['2025-08-25', '2025-08-25', '2025-11-03', '2025-06-02', '2025-08-25'])).toBe('2025-08-25');
    expect(medianDate(['2025-08-25', '2025-09-01'])).toBe('2025-08-25');
    expect(medianDate([])).toBeNull();
  });
});

describe('one entity parted by the codes its documents carry', () => {
  const doc = (id: string, spellings: string[], context: string[]): CodedDoc => ({ id, path: `${id}.md`, date: null, context: new Set(context), codes: codesOf(spellings) });
  const team = (prefix: string, org: string, person: string, code: string): CodedDoc[] => [
    doc(`${prefix}1`, ['日志保留天数', code], [org, person]),
    doc(`${prefix}2`, ['日志保留天数', code, '保留期'], [org, person, '安全团队']),
    // named without its code: the documents it is like say whose it is
    doc(`${prefix}3`, ['保留期'], [org, person]),
    doc(`${prefix}4`, ['日志保留天数'], [org]),
  ];

  it('gives every code with a roof of its own the documents like its own, coded or not', () => {
    const docs = [
      ...team('a', '平台组', '罗芳', 'T1-C2'),
      ...team('b', '二部平台组', '廖欣', 'D2T1-C2'),
      ...team('c', '三部平台组', '方杰', 'D3T1-C2'),
      // as much like one team's reports as another's, and like none: nobody's
      doc('x1', ['日志保留天数'], ['二部平台组', '三部平台组']),
      doc('x2', ['日志保留天数'], ['安全团队']),
    ];
    const split = codedClusters(docs, typeOf)!;
    expect(split.parts.map((p) => [p.code.value, p.anchors, p.docs.map((d) => d.id).sort()])).toEqual([
      ['D2T1-C2', ['二部平台组'], ['b1', 'b2', 'b3', 'b4']],
      ['D3T1-C2', ['三部平台组'], ['c1', 'c2', 'c3', 'c4']],
      ['T1-C2', ['平台组'], ['a1', 'a2', 'a3', 'a4']],
    ]);
    expect(split.rest.map((d) => d.id)).toEqual(['x1', 'x2']);
    // the first division's documents carry no code at all: they stay, under the roof they share
    const uncoded = [...team('a', '平台组', '罗芳', 'T1-C2').map((d) => ({ ...d, codes: codesOf([]) })), ...team('b', '二部平台组', '廖欣', 'D2T1-C2'), ...team('c', '三部平台组', '方杰', 'D3T1-C2')];
    const kept = codedClusters(uncoded, typeOf)!;
    expect(kept.parts.map((p) => p.code.value)).toEqual(['D2T1-C2', 'D3T1-C2']);
    expect(kept.rest.map((d) => d.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(kept.restAnchors).toEqual(['平台组']);
  });

  it('parts nothing when the codes\' roofs account for a small part of the documents', () => {
    // a hub: two kinds seen twice each beside organizations of their own, and twenty documents that name neither
    const hub = [
      doc('h1', ['DRAM', 'DDR4'], ['平台组']), doc('h2', ['DRAM', 'DDR4'], ['平台组']),
      doc('h3', ['DRAM', 'DDR5'], ['二部平台组']), doc('h4', ['DRAM', 'DDR5'], ['二部平台组']),
      ...Array.from({ length: 20 }, (_, i) => doc(`n${i}`, ['DRAM'], i % 2 ? ['英伟达'] : ['安全团队', '罗芳'])),
    ];
    expect(codedClusters(hub, typeOf)).toBeNull();
    // the same four with nothing else: the codes are all there is to go by
    expect(codedClusters(hub.slice(0, 4), typeOf)?.parts).toHaveLength(2);
  });

  it('leaves alone codes that share their context, a code in one document, and a single code', () => {
    // kinds listed as aliases: every document under the same roof
    const hub = [
      doc('h1', ['芯片', 'H100'], ['英伟达', '罗芳']), doc('h2', ['芯片', 'H100'], ['英伟达']),
      doc('h3', ['芯片', 'H200'], ['英伟达', '廖欣']), doc('h4', ['芯片', 'H200'], ['英伟达']),
    ];
    expect(codedClusters(hub, typeOf)).toBeNull();
    // one code written short and long by one team
    const short = [
      doc('s1', ['日志保留天数', 'T1-C2'], ['平台组']), doc('s2', ['日志保留天数', 'T1-C2'], ['平台组']),
      doc('s3', ['日志保留天数', 'P-T1-C2'], ['平台组']), doc('s4', ['日志保留天数', 'P-T1-C2'], ['平台组']),
    ];
    expect(codedClusters(short, typeOf)).toBeNull();
    // a second code seen once (a wrong ticker in one report) parts nothing
    const once = [...team('a', '平台组', '罗芳', 'T1-C2'), doc('b1', ['日志保留天数', 'D2T1-C2'], ['二部平台组'])];
    expect(codedClusters(once, typeOf)).toBeNull();
    expect(codedClusters(team('a', '平台组', '罗芳', 'T1-C2'), typeOf)).toBeNull();
    // codes of different kinds on one thing: an asset tag and a ticket are not rivals
    const kinds = [
      doc('k1', ['日志保留天数', 'T1-C2'], ['平台组']), doc('k2', ['日志保留天数', 'T1-C2'], ['平台组']),
      doc('k3', ['日志保留天数', 'REQ-2025'], ['二部平台组']), doc('k4', ['日志保留天数', 'REQ-2025'], ['二部平台组']),
    ];
    expect(codedClusters(kinds, typeOf)).toBeNull();
  });
});

describe('two people of one name', () => {
  const doc = (id: string, date: string | null, context: string[]): NamesakeDoc => ({ id, path: `${id}.md`, date, context: new Set(context) });
  it('needs both active at the same time, by whatever date the documents have', () => {
    const at = (k: number) => new Date(Date.UTC(2025, 0, 6 + k * 7)).toISOString().slice(0, 10);
    const both = [0, 1, 2, 3].flatMap((k) => [doc(`a${k}`, at(k), ['平台组', '罗芳']), doc(`b${k}`, at(k), ['二部平台组', '廖欣'])]);
    expect(namesakeClusters(both, typeOf)).not.toBeNull();
    // one after the other: a person who moved
    const moved = [0, 1, 2, 3].flatMap((k) => [doc(`a${k}`, at(k), ['平台组', '罗芳']), doc(`b${k}`, at(k + 10), ['二部平台组', '廖欣'])]);
    expect(namesakeClusters(moved, typeOf)).toBeNull();
    // no date at all: not decided
    expect(namesakeClusters(both.map((d) => ({ ...d, date: null })), typeOf)).toBeNull();
    // moved after week 7, and named twice more in the old team's reviews months later: the ranges overlap, the documents do not
    const lookedBack = [
      ...[0, 1, 2, 3, 4, 5, 6, 14, 22].map((k) => doc(`a${k}`, at(k), ['平台组', '罗芳'])),
      ...[7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21, 23].map((k) => doc(`b${k}`, at(k), ['二部平台组', '廖欣'])),
    ];
    expect(namesakeClusters(lookedBack, typeOf)).toBeNull();
    expect(sequentialShare(['2025-01-06', '2025-01-13'], ['2025-01-20', '2025-01-27'])).toBe(1);
    expect(sequentialShare(['2025-01-06', '2025-01-20'], ['2025-01-13', '2025-01-27'])).toBe(0.5);
    expect(sequentialShare([], ['2025-01-13'])).toBe(0);
  });

  it('tells contexts apart by what each is about, not by a customer both name once', () => {
    const at = (k: number) => new Date(Date.UTC(2025, 0, 6 + k * 7)).toISOString().slice(0, 10);
    const weeks = Array.from({ length: 10 }, (_, k) => k);
    // each team names the security team once and 英伟达 once: a third of all they ever name, a tenth of their reports
    const a = weeks.map((k) => doc(`a${k}`, at(k), ['平台组', '罗芳', ...(k === 3 ? ['安全团队'] : []), ...(k === 6 ? ['英伟达'] : [])]));
    const b = weeks.map((k) => doc(`b${k}`, at(k), ['二部平台组', '廖欣', ...(k === 2 ? ['安全团队'] : []), ...(k === 7 ? ['英伟达'] : [])]));
    expect(namesakeClusters([...a, ...b], typeOf, { characteristic: true })?.map((c) => c.anchors)).toEqual([['平台组'], ['二部平台组']]);
    // compared over everything each ever names, as by default, they meet: not decided
    expect(namesakeClusters([...a, ...b], typeOf)).toBeNull();
    // a colleague in every report of both: one person in two teams' reports
    const shared = [...a, ...b].map((d) => ({ ...d, context: new Set([...d.context, '方杰']) }));
    expect(namesakeClusters(shared, typeOf, { characteristic: true })).toBeNull();
  });

  it('decides nothing from a few dated documents, or from two languages', () => {
    const at = (k: number) => new Date(Date.UTC(2025, 0, 6 + k * 7)).toISOString().slice(0, 10);
    const weeks = Array.from({ length: 10 }, (_, k) => k);
    const a = weeks.map((k) => doc(`a${k}`, at(k), ['平台组', '罗芳']));
    const b = weeks.map((k) => doc(`b${k}`, at(k), ['二部平台组', '廖欣']));
    expect(namesakeClusters([...a, ...b], typeOf)).not.toBeNull();
    // four of one cluster's ten documents are dated: what the other six would say is not known
    expect(namesakeClusters([...a, ...b.map((d, k) => (k < 4 ? d : { ...d, date: null }))], typeOf)).toBeNull();
    expect(namesakeClusters([...a, ...b.map((d, k) => (k < 5 ? d : { ...d, date: null }))], typeOf)).not.toBeNull();
    // one cluster in Chinese, the other in English: the same organizations would be different entities
    const zh = a.map((d) => ({ ...d, language: 'zh' }));
    expect(namesakeClusters([...zh, ...b.map((d) => ({ ...d, language: 'en' }))], typeOf)).toBeNull();
    expect(namesakeClusters([...zh, ...b.map((d) => ({ ...d, language: 'zh' }))], typeOf)).not.toBeNull();
    expect(namesakeClusters([...zh, ...b], typeOf)).not.toBeNull();
  });
});

/* ------------------------------- the fixture build ------------------------------- */

const WEEKS = 6;
const week = (k: number) => new Date(Date.UTC(2025, 0, 6 + k * 7)).toISOString().slice(0, 10);
const TEAMS = [
  { team: '平台组', code: 'T1-C2', members: (k: number) => ['陈伟', '罗芳', ...(k >= 3 ? ['孙欣'] : [])] },
  { team: '二部平台组', code: 'D2T1-C2', members: () => ['陈伟', '廖欣'] },
  { team: '三部平台组', code: 'D3T1-C2', members: (k: number) => ['方杰', '赖艳', ...(k < 3 ? ['孙欣'] : [])] },
];

/**
 * Weekly reports of three teams, none with a date in its path, frontmatter
 * or first lines. Every team has a setting 日志保留天数 with a code of its own,
 * named with the code in two weeks and without it in four (once with its short name). 陈伟 is two
 * people, one in 平台组 and one in 二部平台组 all six weeks; 孙欣 is one, who
 * moved from 三部平台组 to 平台组 after week 3.
 */
function fixture(): Map<string, { text: string; reply: RawExtractReply }> {
  const out = new Map<string, { text: string; reply: RawExtractReply }>();
  for (const t of TEAMS) {
    for (let k = 0; k < WEEKS; k++) {
      const members = t.members(k);
      const setting = k === 1 ? { name: '日志保留天数', aliases: [t.code] }
        : k === 2 ? { name: '日志保留天数', aliases: [t.code, '保留期'] }
        : k === 4 ? { name: '日志保留天数', aliases: ['保留期'] }
        : { name: '日志保留天数', aliases: [] as string[] };
      out.set(`raw/docs/周报/${t.team}/w${k + 1}.md`, {
        text: `# ${t.team}周报 第${k + 1}周\n\n本周完成工单${20 + k}个。${setting.name}${setting.aliases[0] ? `（${setting.aliases[0]}）` : ''}为${30 + TEAMS.indexOf(t) * 30}天。${members.join('、')}参加评审。\n`,
        reply: {
          entities: [
            { name: t.team, type: 'organization', aliases: [] },
            { name: setting.name, type: 'component', aliases: setting.aliases },
            ...members.map((m) => ({ name: m, type: 'person', aliases: [] })),
          ],
          relations: members.map((m) => ({ source: m, target: t.team, type: 'member_of' })),
          claims: [
            { subject: t.team, statement: `${t.team}第${k + 1}周完成工单${20 + k}个`, type: 'other', status: 'fact', kind: 'fact', startDate: week(k) },
            { subject: setting.name, statement: `${t.team}的${setting.name}为${30 + TEAMS.indexOf(t) * 30}天（第${k + 1}周）`, type: 'other', status: 'fact', kind: 'fact', startDate: week(k) },
          ],
        },
      });
    }
  }
  return out;
}

/** A model that answers single and batched extraction requests from the fixture. */
function stubExtractor(docs: Map<string, { reply: RawExtractReply }>): LlmClient {
  const reply = (p: string) => docs.get(p)?.reply ?? { entities: [], relations: [], claims: [] };
  const completeJson = async (messages: { role: string; content: string }[]) => {
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    const batched = [...user.matchAll(/^=== Document (\d+): .* \((raw\/docs\/[^)]+)\) ===$/gm)];
    if (batched.length > 0) return { documents: batched.map((m) => ({ doc: Number(m[1]), ...reply(m[2]) })) };
    const single = /Document: .* \((raw\/docs\/[^)]+)\)/.exec(user);
    return reply(single?.[1] ?? '');
  };
  return { enabled: true, label: 'stub@extract', provider: 'openai', model: 'stub', completeJson } as unknown as LlmClient;
}

describe('refine on reports that date themselves only in their claims', () => {
  let ctx: AppContext | undefined;
  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
  });

  it('splits the namesake, keeps the person who moved, and parts the setting by code', async () => {
    const dataDir = path.join(tmp, 'ws');
    initDataDir(dataDir);
    const docs = fixture();
    for (const [p, d] of docs) {
      fs.mkdirSync(path.dirname(path.join(dataDir, p)), { recursive: true });
      fs.writeFileSync(path.join(dataDir, p), d.text);
    }
    ctx = await createContext(dataDir);
    const store = ctx.store;
    await sync(ctx, { llmGraph: false });
    for (const d of await store.query<{ id: string }>(`SELECT id FROM documents WHERE root = 'docs'`)) await enqueueTier1(store, d.id);
    (ctx.config.extraction as { entityLlm?: unknown }).entityLlm = undefined;
    const llm = stubExtractor(docs);
    for (let i = 0; i < 10; i++) if ((await runTier1Pass(store, ctx.config, llm, { batchSize: 64 })).queued === 0) break;
    expect(await store.query(`SELECT 1 FROM documents WHERE root = 'docs' AND doc_date IS NOT NULL`)).toEqual([]);

    // as a workspace is by default: nothing is parted — no code parts an entity, and documents without a date split no one
    expect(ctx.config.review.identity).toBeUndefined();
    expect(await resolveEntityContext(store, { config: ctx.config })).toMatchObject({ merged: 0, split: 0, replayed: 0 });
    expect(await store.query(`SELECT id FROM entity_namesakes`)).toEqual([]);

    // turned on
    ctx.config.review.identity = 'context';
    const messages: string[] = [];
    const first = await resolveEntityContext(store, { config: ctx.config, onProgress: (m) => messages.push(m) });
    expect(first.split).toBeGreaterThanOrEqual(1);
    expect(messages.some((m) => m.includes('陈伟 split'))).toBe(true);

    const teamsOf = async (id: string) => {
      const rows = await store.query<{ path: string }>(`SELECT DISTINCT d.path FROM entity_mentions m JOIN documents d ON d.id = m.document_id WHERE m.entity_id = $1`, [id]);
      const by = new Map<string, number>();
      for (const r of rows) by.set(r.path.split('/')[3], (by.get(r.path.split('/')[3]) ?? 0) + 1);
      return Object.fromEntries(by);
    };
    const named = async (like: string) => store.query<{ id: string; name: string; aliases: string[] }>(`SELECT id, name, aliases FROM entities WHERE name LIKE $1 AND tx_to IS NULL AND canonical_id IS NULL ORDER BY id`, [like]);

    // 陈伟: two people, each with one team's six reports
    const chens = await named('陈伟%');
    expect(chens).toHaveLength(2);
    expect((await Promise.all(chens.map((c) => teamsOf(c.id)))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([{ 二部平台组: WEEKS }, { 平台组: WEEKS }]);
    const [rule] = await store.query<{ reason: string }>(`SELECT reason FROM entity_namesakes WHERE base_id = '陈伟'`);
    expect(rule.reason).toContain('同名不同人');
    // 孙欣 moved: one person, in both teams' reports
    expect(await named('孙欣%')).toHaveLength(1);
    expect(await teamsOf('孙欣')).toEqual({ 三部平台组: 3, 平台组: 3 });

    // the setting: three things, each with its team's six reports — coded, bare or by its short name
    const settings = await named('日志保留天数%');
    expect(settings).toHaveLength(3);
    expect((await Promise.all(settings.map((s) => teamsOf(s.id)))).map((t) => JSON.stringify(t)).sort()).toEqual(TEAMS.map((t) => JSON.stringify({ [t.team]: WEEKS })).sort());
    // each keeps its own team's code and none of the others'; a parted one is named by its roof and its code
    for (const s of settings) {
      const [team] = Object.keys(await teamsOf(s.id));
      const carried = TEAMS.filter((t) => s.aliases.includes(t.code) || s.name.endsWith(` ${t.code}）`)).map((t) => t.team);
      expect(carried, `${s.name} ${JSON.stringify(s.aliases)}`).toEqual([team]);
    }
    for (const s of settings.filter((x) => x.name !== '日志保留天数')) expect(s.name).toMatch(/^日志保留天数（(平台组|二部平台组|三部平台组) · (T1-C2|D2T1-C2|D3T1-C2)）$/);
    // the claims went with their subject
    for (const s of settings) {
      const [team] = Object.keys(await teamsOf(s.id));
      const claims = await store.query<{ statement: string }>(`SELECT statement FROM claims WHERE subject_id = $1 AND tx_to IS NULL`, [s.id]);
      expect(claims).toHaveLength(WEEKS);
      expect(claims.every((c) => c.statement.startsWith(`${team}的`))).toBe(true);
    }
    // every parted pair is on record as decided, with its reason
    const parted = await store.query<{ id: string; base_id: string; reason: string }>(`SELECT id, base_id, reason FROM entity_namesakes WHERE id <> base_id ORDER BY id`);
    expect(parted).toHaveLength(3);
    const decided = await store.query<{ n: number }>(`SELECT count(*)::int AS n FROM suggestions WHERE status = 'rejected' AND payload->>'namesake' = 'true'`);
    expect(decided[0].n).toBe(3);

    // a second run decides nothing new
    expect(await resolveEntityContext(store, { config: ctx.config })).toMatchObject({ merged: 0, split: 0, replayed: 0 });

    // every document went with a code, so one code kept the entity itself: on record, with its roof
    const [kept] = await store.query<{ id: string; label: string; anchors: string[] }>(`SELECT id, label, anchors FROM entity_namesakes WHERE id = base_id`);
    expect(kept.id).toBe('日志保留天数');
    const keptTeam = TEAMS.find((t) => t.code === kept.label)!.team;
    expect(kept.anchors).toEqual([keptTeam]);
    expect(await teamsOf('日志保留天数')).toEqual({ [keptTeam]: WEEKS });
    const claimIds = async () => (await store.query<{ id: string }>(`SELECT id FROM claims WHERE subject_id = '日志保留天数' AND tx_to IS NULL ORDER BY id`)).map((c) => c.id);
    const before = await claimIds();

    // later: a fourth team with a code of its own, and a memo that is like no team's reports
    const later = new Map<string, { text: string; reply: RawExtractReply }>();
    for (let k = 0; k < WEEKS; k++) {
      const aliases = k === 1 || k === 2 ? ['D4T1-C2'] : [];
      later.set(`raw/docs/周报/四部平台组/w${k + 1}.md`, {
        text: `# 四部平台组周报 第${k + 1}周\n\n日志保留天数${aliases[0] ? `（${aliases[0]}）` : ''}为120天。丁博、乔敏参加评审。\n`,
        reply: {
          entities: [{ name: '四部平台组', type: 'organization', aliases: [] }, { name: '日志保留天数', type: 'component', aliases }, { name: '丁博', type: 'person', aliases: [] }, { name: '乔敏', type: 'person', aliases: [] }],
          relations: [{ source: '丁博', target: '四部平台组', type: 'member_of' }, { source: '乔敏', target: '四部平台组', type: 'member_of' }],
          claims: [{ subject: '日志保留天数', statement: `四部平台组的日志保留天数为120天（第${k + 1}周）`, type: 'other', status: 'fact', kind: 'fact', startDate: week(k) }],
        },
      });
    }
    later.set('raw/docs/备忘/retention.md', {
      text: '# 备忘\n\n日志保留天数需要审计组复核。\n',
      reply: { entities: [{ name: '审计组', type: 'organization', aliases: [] }, { name: '日志保留天数', type: 'component', aliases: [] }], relations: [], claims: [] },
    });
    for (const [p, d] of later) {
      fs.mkdirSync(path.dirname(path.join(dataDir, p)), { recursive: true });
      fs.writeFileSync(path.join(dataDir, p), d.text);
    }
    await sync(ctx, { llmGraph: false });
    for (const d of await store.query<{ id: string }>(`SELECT id FROM documents WHERE root = 'docs' AND (path LIKE '%四部平台组%' OR path LIKE '%备忘%')`)) await enqueueTier1(store, d.id);
    const llm2 = stubExtractor(new Map([...docs, ...later]));
    for (let i = 0; i < 10; i++) if ((await runTier1Pass(store, ctx.config, llm2, { batchSize: 64 })).queued === 0) break;
    // written to the entity that keeps the name: nothing says yet that they are another thing
    expect(await teamsOf('日志保留天数')).toEqual({ [keptTeam]: WEEKS, 四部平台组: WEEKS, 'retention.md': 1 });
    const again = await resolveEntityContext(store, { config: ctx.config });
    expect(again.split).toBe(1);
    // the entity that kept the name keeps it, its id and its claims; only the new team's setting is parted from it
    expect(await teamsOf('日志保留天数')).toEqual({ [keptTeam]: WEEKS, 'retention.md': 1 });
    expect(await claimIds()).toEqual(before);
    const four = await named('日志保留天数（四部平台组%');
    expect(four.map((e) => e.name)).toEqual(['日志保留天数（四部平台组 · D4T1-C2）']);
    expect(await teamsOf(four[0].id)).toEqual({ 四部平台组: WEEKS });
    expect((await named('日志保留天数%')).length).toBe(4);
    expect(await store.query(`SELECT count(*)::int AS n FROM entity_namesakes WHERE id = base_id`)).toEqual([{ n: 1 }]);
    expect(await resolveEntityContext(store, { config: ctx.config })).toMatchObject({ merged: 0, split: 0, replayed: 0 });

    // undoing a split: a person merges the parted entity back, and it stays merged
    await applyMerge(store, { entityId: four[0].id, canonicalId: '日志保留天数', reason: '同一个设置', actor: 'user' });
    expect(await resolveEntityContext(store, { config: ctx.config })).toMatchObject({ merged: 0, split: 0, replayed: 0 });
    expect((await resolveEntityId(store, { name: '日志保留天数', aliases: ['D4T1-C2'], context: { documentNames: new Set(['四部平台组']) } })).id).toBe('日志保留天数');
    expect((await store.query<{ canonical_id: string | null }>(`SELECT canonical_id FROM entities WHERE id = $1`, [four[0].id]))[0].canonical_id).toBe('日志保留天数');
  });
});
