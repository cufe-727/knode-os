import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { readSidecarPart, updateSidecarPart } from '../src/fs/sidecar.js';
import { readConceptStoplist, readFrequentTerms, stopKeySet } from '../src/graph/concept-stoplist.js';
import {
  buildLinkIndex,
  conceptCandidates,
  conceptCap,
  extractConcepts,
  findLinks,
  frontmatterNames,
  learnFrequentTerms,
  maskSpans,
  relinkTier0,
  selectConcepts,
  stripTemplate,
  weakLinkKey,
} from '../src/graph/concepts.js';
import { knownEntitiesIn } from '../src/graph/llm-extract.js';
import { keyOf } from '../src/graph/normalize.js';
import { documentIdFor } from '../src/ingest/apply.js';
import { sync } from '../src/ingest/sync.js';
import { findLiveScope } from '../src/lineage/scope.js';
import { parseFrontmatter, titleFromMarkdown } from '../src/markdown.js';

/**
 * Tier-0 concepts (src/graph/concepts.ts): the zero-LLM miner on a document
 * shaped like a real xueqiu digest, linking a document to entities the graph
 * already knows, the length-proportional cap, the corpus stop list, and the
 * retirement of placeholders once tier-1 has read the document.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-concepts-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** A digest as the rookie-trade xueqiu exporter writes it: author in `source:`, repeated in every entry heading, attachment lines. */
const DIGEST = `---
title: "雪球 · 不明真相的群众 · 2024-05-20"
platform: xueqiu
source: "不明真相的群众"
period: day
date: 2024-05-20
entries: 6
---

# 雪球 · 不明真相的群众 · 2024-05-20

6 条相关内容

---

<a id="e-1"></a>
## 09:12 · 不明真相的群众

看了一篇关于泡沫的文章，作者用 LPPL 模型拟合了过去三轮牛市的指数走势，结论是对数周期幂律能提前几周给出临界点的区间。

- image: 附件 (https://example.com/a/1)

---

<a id="e-2"></a>
## 10:40 · 不明真相的群众

纽约证券交易所的成交量连续三天放大，但波动率指数反而下降，机构在换仓而不是离场；波动率的季节性比多数人以为的强。

- image: 附件 (https://example.com/a/2)

---

<a id="e-3"></a>
## 11:05 · 不明真相的群众

白酒板块的回调更像情绪宣泄，茅台的基本面没有变化，渠道库存仍在健康区间；白酒的估值修复需要时间。

- image: 附件 (https://example.com/a/3)

---

<a id="e-4"></a>
## 13:11 · 不明真相的群众

新能源车的渗透率曲线开始走平，电池厂商的产能利用率是接下来两个季度最值得跟踪的指标，电池价格的下行还没有结束。

- image: 附件 (https://example.com/a/4)

---

<a id="e-5"></a>
## 15:30 · 不明真相的群众

银行股的估值修复还没有结束，拨备覆盖率高的几家城商行更值得关注。

---

<a id="e-6"></a>
## 21:48 · 不明真相的群众

再说一遍：不要用杠杆去赌单一事件，波动率本身就是风险。
`;

const AUTHOR_FRAGMENTS = ['不明真相', '明真相的', '真相的群', '相的群众'];
/** Text this long reaches the maximum cap (CAP_MAX × CAP_CHARS_PER_CONCEPT). */
const CAP_CHARS_FOR_MAX = 24 * 400;

/** A source that teaches the graph two typed entities before the digest arrives. */
const KNOWN = `---
title: 交易所与作者
entities:
  - { name: 纽约证券交易所, type: organization, aliases: ["NYSE", "公司"] }
  - { name: 不明真相的群众, type: person }
---
# 交易所与作者

纽约证券交易所是全球最大的证券交易所之一；波动率指数由芝加哥期权交易所发布，波动率指数常被称为恐慌指数。
`;

function digestText(): string {
  const parsed = parseFrontmatter(DIGEST);
  const title = titleFromMarkdown('raw/docs/digest.md', parsed);
  const { source } = frontmatterNames(parsed.frontmatter);
  return stripTemplate(parsed.body, { source, title });
}

describe('tier-0 mining on a xueqiu digest', () => {
  it('strips the exporter template: attachment lines and headings that repeat the author or title', () => {
    const text = digestText();
    expect(text).not.toContain('附件');
    expect(text).not.toContain('不明真相的群众');
    expect(text).not.toContain('<a id=');
    expect(text).toContain('LPPL');
    expect(text).toContain('纽约证券交易所');
    expect(frontmatterNames(parseFrontmatter(DIGEST).frontmatter)).toEqual({ source: '不明真相的群众', declared: [] });
  });

  it('counts every span once, keeps no fragments of the author name and no template words', () => {
    const text = digestText();
    const by = new Map(conceptCandidates(text).map((c) => [c.term, c]));
    expect(by.get('LPPL')).toMatchObject({ count: 1, kind: 'acronym' });
    for (const fragment of AUTHOR_FRAGMENTS) expect(by.has(fragment)).toBe(false);
    expect(by.has('附件')).toBe(false);
    // segmenter words, not sliding-window substrings: 波动率 ×3 is counted as the word 波动, never as 动率
    expect(by.get('波动')?.count).toBe(3);
    expect(by.has('动率')).toBe(false);
    // a run the segmenter does not know stays one term
    expect(by.get('估值')).toMatchObject({ count: 2, kind: 'cjk-run' });

    const relaxed = extractConcepts(text, { chars: 4000 });
    expect(relaxed.filter((t) => t === 'LPPL')).toHaveLength(1);
    expect(new Set(relaxed).size).toBe(relaxed.length);
    for (const fragment of AUTHOR_FRAGMENTS) expect(relaxed).not.toContain(fragment);
    expect(relaxed).not.toContain('附件');
    expect(relaxed).not.toContain('没有');
  });

  it('caps the terms in proportion to the text length', () => {
    expect(conceptCap(100)).toBe(3);
    expect(conceptCap(4000)).toBe(10);
    expect(conceptCap(100_000)).toBe(24);
    const text = digestText();
    expect(extractConcepts(text)).toHaveLength(3);
    const long = Array.from({ length: 40 }, (_, i) => `Topic${i} is discussed here. Topic${i} again, with Rule${i} and Rule${i}.`).join(' '.repeat(200));
    expect(long.length).toBeGreaterThan(CAP_CHARS_FOR_MAX);
    expect(extractConcepts(long)).toHaveLength(24);
  });

  it('honours the stop list and its exceptions', () => {
    const cands = conceptCandidates(digestText());
    const stopped = selectConcepts(cands, { chars: 4000, stop: stopKeySet({ terms: ['LPPL', '波动'], allow: [] }, null) });
    expect(stopped).not.toContain('LPPL');
    expect(stopped).not.toContain('波动');
    const allowed = stopKeySet({ terms: [], allow: ['没有'] }, null);
    expect(allowed.has(keyOf('没有'))).toBe(false);
    expect(allowed.has(keyOf('公司'))).toBe(true);
  });
});

describe('linking to what the graph knows', () => {
  const index = buildLinkIndex([
    { id: '纽约证券交易所', name: '纽约证券交易所', type: 'organization', keys: ['纽约证券交易所', 'nyse'] },
    { id: '宁德时代', name: '宁德时代', type: 'organization', keys: ['宁德时代', 'catl'] },
    { id: '宁德', name: '宁德', type: 'location', keys: ['宁德'] },
    { id: 'elon-musk', name: 'Elon Musk', type: 'person', keys: ['elonmusk'] },
  ]);

  it('matches CJK as substrings and Latin as whole words, longest span first', () => {
    const text = '宁德时代新能源的电池；CATL 与 CATLX 不同；Elon Musk 和 elon-musk 都算，nyse 也算。';
    const spans = findLinks(text, index);
    const seen = spans.map((s) => `${s.candidate.id}:${text.slice(s.start, s.end)}`);
    expect(seen).toEqual(['宁德时代:宁德时代', '宁德时代:CATL', 'elon-musk:Elon Musk', 'elon-musk:elon-musk', '纽约证券交易所:nyse']);
    expect(seen.some((s) => s.startsWith('宁德:'))).toBe(false);
    const masked = maskSpans(text, spans);
    expect(masked).toHaveLength(text.length);
    expect(masked).not.toContain('宁德时代');
    expect(masked).toContain('CATLX');
    expect(masked).toContain('新能源的电池');
  });

  it('skips surfaces on the stop list', () => {
    const generic = buildLinkIndex([{ id: 'p', name: '某人', type: 'person', keys: ['某人', '公司'] }], stopKeySet({ terms: [], allow: [] }, null));
    expect(findLinks('这家公司的某人说', generic).map((s) => s.key)).toEqual(['某人']);
  });

  it('never links on a short number, a two-letter spelling or a generic alias', () => {
    const stop = stopKeySet({ terms: [], allow: [] }, null);
    const frequent = new Set([keyOf('指数'), keyOf('茅台')]);
    expect(weakLinkKey('11', { isName: false })).toBe(true);
    expect(weakLinkKey('2025', { isName: true })).toBe(true);
    expect(weakLinkKey('600519', { isName: false })).toBe(false);
    expect(weakLinkKey('ai', { isName: true })).toBe(true);
    expect(weakLinkKey('nyse', { isName: false })).toBe(false);
    expect(weakLinkKey('a股', { isName: false })).toBe(false);
    expect(weakLinkKey(keyOf('公司'), { isName: false, stop })).toBe(true);
    expect(weakLinkKey(keyOf('公司'), { isName: true, stop })).toBe(true);
    // a frequent word is no alias surface, but a frequent name is the hub it names
    expect(weakLinkKey(keyOf('指数'), { isName: false, aliasStop: frequent })).toBe(true);
    expect(weakLinkKey(keyOf('茅台'), { isName: true, aliasStop: frequent })).toBe(false);

    const index = buildLinkIndex(
      [
        { id: 'iphone-11', name: 'iPhone 11', type: 'product', keys: ['iphone11', '11'] },
        { id: 'a股', name: 'A股', type: 'dataset', keys: ['a股', keyOf('指数'), keyOf('公司')] },
        { id: '茅台', name: '茅台', type: 'organization', keys: ['茅台'] },
      ],
      stop,
      frequent,
    );
    const text = '## 11-24 11:18 · 表舅\n\nA股指数走弱，茅台和 iPhone 11 降价；公司观望。';
    expect(findLinks(text, index).map((s) => `${s.candidate.id}:${text.slice(s.start, s.end)}`)).toEqual(['a股:A股', '茅台:茅台', 'iphone-11:iPhone 11']);
  });
});

describe('tier-0 through sync', () => {
  const dataDir = path.join(tmp, 'ws');
  let ctx: AppContext;

  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
  });

  const count = async (sql: string, params: unknown[] = []) => {
    const [row] = await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params);
    return row.n;
  };

  it('links the known organization and the declared author from a single mention and mints no fragments', async () => {
    initDataDir(dataDir);
    expect(readConceptStoplist(dataDir).terms).toContain('附件');
    write(dataDir, 'raw/docs/known.md', KNOWN);
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
    expect(await count(`entities WHERE id = '纽约证券交易所' AND type = 'organization' AND tx_to IS NULL`)).toBe(1);

    write(dataDir, 'raw/docs/digest.md', DIGEST);
    await sync(ctx, { llmGraph: false });
    const scope = (await findLiveScope(ctx.store, 'doc', 'raw/docs/digest.md'))!;
    expect(scope).toBeTruthy();

    // one mention of the organization in the body, plus the author named in `source:`, link the document to the existing entities
    const links = await ctx.store.query<{ target_id: string; weight: number }>(
      `SELECT target_id, weight FROM evidence WHERE scope_id = $1 AND kind = 'entity' AND extractor = 'tier0.link' AND tx_to IS NULL ORDER BY target_id`,
      [scope.id],
    );
    expect(links.map((l) => l.target_id)).toEqual(['不明真相的群众', '纽约证券交易所']);
    expect(await count(`entity_mentions WHERE scope_id = $1 AND entity_id = '纽约证券交易所'`, [scope.id])).toBeGreaterThan(0);
    // still one node of its declared type: the link added no concept and did not out-vote the type
    expect(await count(`entities WHERE name = '纽约证券交易所' AND tx_to IS NULL`)).toBe(1);
    expect(await count(`entities WHERE id = '纽约证券交易所' AND type = 'organization' AND tx_to IS NULL`)).toBe(1);
    expect(await count(`entities WHERE id = '不明真相的群众' AND type = 'person' AND tx_to IS NULL`)).toBe(1);
    // the declared alias that is a stop word stays in the evidence but out of the row
    const [org] = await ctx.store.query<{ aliases: string[] }>(`SELECT aliases FROM entities WHERE id = '纽约证券交易所'`);
    expect(org.aliases).toEqual(['NYSE']);
    expect(await count(`entity_alias_keys WHERE entity_id = '纽约证券交易所' AND alias_key = $1`, [keyOf('公司')])).toBe(0);

    // no template noise, no fragments of the author name
    const noise = ['附件', ...AUTHOR_FRAGMENTS];
    expect(await count(`entities WHERE name IN (${noise.map((_, i) => `$${i + 1}`).join(',')}) AND tx_to IS NULL`, noise)).toBe(0);

    const tier0 = readSidecarPart(dataDir, 'raw/docs/digest.md', 'tier0')!;
    expect([...(tier0.linked ?? [])].sort()).toEqual(['不明真相的群众', '纽约证券交易所']);
    expect(tier0.concepts).toHaveLength(3);
    expect(tier0.concepts).toContain('波动');
    expect(tier0.concepts).not.toContain('附件');
    // the placeholders are concept nodes with this document's tier0.concept evidence
    expect(await count(`evidence WHERE scope_id = $1 AND kind = 'entity' AND extractor = 'tier0.concept' AND tx_to IS NULL`, [scope.id])).toBe(3);
  });

  it('learns corpus-frequent terms from the documents themselves; the stop list can overrule them', async () => {
    const frequent = await learnFrequentTerms(ctx.store, { ratio: 0.5, minCorpus: 2, minDocs: 2 });
    expect(frequent.docs).toBe(2);
    expect(frequent.threshold).toBe(2);
    // 波动 is a candidate in both documents; the declared organization is counted from its text, not from the graph
    expect(frequent.terms.map((t) => t.term)).toContain('波动');
    expect(frequent.terms.map((t) => t.term)).not.toContain('LPPL');
    expect(readFrequentTerms(dataDir)?.terms.map((t) => t.term)).toContain('波动');
    const stop = stopKeySet({ terms: [], allow: [] }, frequent);
    expect(stop.has(keyOf('波动'))).toBe(true);
    expect(stopKeySet({ terms: [], allow: ['波动'] }, frequent).has(keyOf('波动'))).toBe(false);
    // a document applied from now on does not mine the learned term
    write(dataDir, 'raw/docs/third.md', `---\ntitle: 丙\n---\n# 丙\n\n波动率在上升，波动率的均值回归需要耐心，波动率本身不是风险；均值回归是老话题。\n`);
    await sync(ctx, { llmGraph: false });
    const third = readSidecarPart(dataDir, 'raw/docs/third.md', 'tier0')!.concepts;
    expect(third).not.toContain('波动');
    expect(third).toContain('均值');
    // the real threshold needs a corpus of 50 documents: nothing is learned (and the small-corpus list is reset)
    expect((await learnFrequentTerms(ctx.store)).terms).toEqual([]);
    expect(readFrequentTerms(dataDir)?.terms).toEqual([]);
  });

  it('retires the placeholders tier-1 did not type once the document has been read', async () => {
    const key = 'raw/docs/digest.md';
    const scope = (await findLiveScope(ctx.store, 'doc', key))!;
    const before = await ctx.store.query<{ target_id: string }>(
      `SELECT target_id FROM evidence WHERE scope_id = $1 AND kind = 'entity' AND extractor = 'tier0.concept' AND tx_to IS NULL ORDER BY target_id`,
      [scope.id],
    );
    expect(before.length).toBe(3);
    const [typedTerm, ...rest] = readSidecarPart(dataDir, key, 'tier0')!.concepts;

    // tier-1 reads the document: one of the mined terms turns out to be a technology, the others are not entities at all
    const meta = readSidecarPart(dataDir, key, 'meta')!;
    updateSidecarPart(dataDir, key, 'tier1', () => ({
      status: 'done',
      entities: [{ name: typedTerm, type: 'technology' }],
      relations: [],
      claims: [],
      model: 'test-model',
      contentSha: meta.contentSha256,
      extractedAt: new Date().toISOString(),
    }));
    await sync(ctx, { llmGraph: false });
    expect(await findLiveScope(ctx.store, 'tier1', key)).not.toBeNull();

    // the typed term keeps this document's tier-0 support; the untyped placeholders lost it
    const live = await ctx.store.query<{ target_id: string; type: string }>(
      `SELECT ev.target_id, e.type FROM evidence ev JOIN entities e ON e.id = ev.target_id
       WHERE ev.scope_id = $1 AND ev.kind = 'entity' AND ev.extractor = 'tier0.concept' AND ev.tx_to IS NULL`,
      [scope.id],
    );
    expect(live).toEqual([{ target_id: typedTerm, type: 'technology' }]);
    expect(await count(`entity_mentions m JOIN entities e ON e.id = m.entity_id WHERE m.scope_id = $1 AND e.type = 'concept'`, [scope.id])).toBe(0);
    for (const term of rest) {
      const others = await count(`evidence WHERE kind = 'entity' AND target_id = $1 AND tx_to IS NULL`, [term]);
      const [row] = await ctx.store.query<{ tx_to: string | null }>(`SELECT tx_to FROM entities WHERE id = $1`, [term]);
      // a placeholder no other source supports is tombstoned; one another document still mines stays live
      expect(row.tx_to === null).toBe(others > 0);
    }
    // the links are not placeholders: they stay
    expect(await count(`evidence WHERE scope_id = $1 AND extractor = 'tier0.link' AND tx_to IS NULL`, [scope.id])).toBe(2);
    expect(await count(`entity_mentions WHERE scope_id = $1 AND entity_id = '纽约证券交易所'`, [scope.id])).toBeGreaterThan(0);
    // the sidecar keeps the mined list for history rebuilds
    expect(readSidecarPart(dataDir, key, 'tier0')!.concepts).toEqual([typedTerm, ...rest]);
    // running again changes nothing
    await sync(ctx, { llmGraph: false });
    expect(await count(`evidence WHERE scope_id = $1 AND kind = 'entity' AND extractor = 'tier0.concept' AND tx_to IS NULL`, [scope.id])).toBe(1);
  });

  it('names for the extraction prompt only the entities the text really contains, with a few aliases', async () => {
    const names = async (text: string) => (await knownEntitiesIn(ctx.store, text)).map((k) => k.name);
    expect(await names('NYSEX 开盘后，纽约证券交易所的成交量放大')).toEqual(['纽约证券交易所']);
    expect(await names('the nyse floor')).toEqual(['纽约证券交易所']);
    // a whole word, never a substring; the author's name links as itself
    expect(await names('NYSEX only, and silver')).toEqual([]);
    expect(await names('不明真相的群众说过')).toEqual(['不明真相的群众']);
    const [known] = await knownEntitiesIn(ctx.store, 'nyse 与 NYSE 都指纽约证券交易所');
    expect(known).toEqual({ name: '纽约证券交易所', type: 'organization', aliases: ['nyse'] });
  });

  it('relinks every document from its text: a link no surface gives any more goes, its mentions and count with it', async () => {
    const key = 'raw/docs/third.md';
    const docId = documentIdFor(key);
    const scope = (await findLiveScope(ctx.store, 'doc', key))!;
    const [chunk] = await ctx.store.query<{ id: string }>(`SELECT id FROM chunks WHERE document_id = $1 ORDER BY seq LIMIT 1`, [docId]);
    // the pollution a weak surface left behind: a link, and a mention, on a document that never names the organization
    await ctx.store.query(
      `INSERT INTO evidence (kind, target_id, scope_id, segment_id, weight, extractor, attrs, tx_from, trust)
       VALUES ('entity', '纽约证券交易所', $1, $2, 0.5, 'tier0.link', '{"name":"纽约证券交易所","type":"concept"}', now(), 'trusted')`,
      [scope.id, chunk.id],
    );
    await ctx.store.query(`INSERT INTO entity_mentions (entity_id, chunk_id, document_id, scope_id) VALUES ('纽约证券交易所', $1, $2, $3) ON CONFLICT DO NOTHING`, [chunk.id, docId, scope.id]);
    const digest = (await findLiveScope(ctx.store, 'doc', 'raw/docs/digest.md'))!;

    const stats = await relinkTier0(ctx.store);
    // three documents; the two genuine digest links and the planted one were closed
    expect(stats).toMatchObject({ documents: 3, linksBefore: 3 });
    expect(stats.entities).toBeGreaterThanOrEqual(2);
    expect(await count(`evidence WHERE scope_id = $1 AND target_id = '纽约证券交易所' AND extractor = 'tier0.link' AND tx_to IS NULL`, [scope.id])).toBe(0);
    expect(await count(`entity_mentions WHERE scope_id = $1 AND entity_id = '纽约证券交易所'`, [scope.id])).toBe(0);
    // the digest's genuine links are written again (with whatever tier-1 has typed since), the closed rows stay as history
    const live = await ctx.store.query<{ target_id: string }>(
      `SELECT target_id FROM evidence WHERE scope_id = $1 AND extractor = 'tier0.link' AND tx_to IS NULL ORDER BY target_id`,
      [digest.id],
    );
    expect(live.map((r) => r.target_id)).toEqual(expect.arrayContaining(['不明真相的群众', '纽约证券交易所']));
    expect(await count(`evidence WHERE scope_id = $1 AND extractor = 'tier0.link' AND tx_to IS NOT NULL`, [digest.id])).toBe(2);
    expect(await count(`entity_mentions WHERE scope_id = $1 AND entity_id = '纽约证券交易所'`, [digest.id])).toBeGreaterThan(0);
    const [row] = await ctx.store.query<{ mention_count: number }>(`SELECT mention_count FROM entities WHERE id = '纽约证券交易所'`);
    expect(row.mention_count).toBe(await count(`(SELECT DISTINCT chunk_id FROM entity_mentions WHERE entity_id = '纽约证券交易所') m`));
    // running again changes nothing
    expect(await relinkTier0(ctx.store)).toMatchObject({ documents: 3, linksBefore: stats.linksAfter, linksAfter: stats.linksAfter });
  });
});
