import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { defaultConfig, defaultRerankConfig, KnodeConfig, RerankConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { entityKeyKinds } from '../src/graph/normalize.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import type { ChatMessage, LlmClient } from '../src/llm/client.js';
import { grepWithContext, readMany, shareBudget } from '../src/mcp/batch.js';
import { CATALOG_EXAMPLES, catalogGuide } from '../src/mcp/catalog-guide.js';
import { questionKindGuide } from '../src/mcp/question-kinds.js';
import { registerKnodeTools } from '../src/mcp/tools.js';
import { KNODE_AGENT_TOOLS, knodeAgentBrief } from '../src/eval/systems/knode.js';
import { ask } from '../src/search/ask.js';
import { enumerateClaims, typedColumns } from '../src/search/enumerate.js';
import { parseRerankResponse, rerankResults } from '../src/search/rerank.js';
import { classifyQuestion, questionRange, routeQuestion } from '../src/search/route.js';
import { search } from '../src/search/search.js';
import { chainOrder, walkRelations, walkTerms } from '../src/search/walk.js';
import { catalogQuery } from '../src/store/catalog.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../src/store/db.js';
import type { SearchResult } from '../src/types.js';

/**
 * docs/design/30: `ask` routed by the kind of question (a list answered by
 * enumerating claims, a multi-hop one by a relation walk, a lookup as
 * before), the optional rerank stage, the current claim beside a superseded
 * one, and the batched read / grep the agent tools gained.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-answer-routing-'));

class FixtureEmbedder implements EmbeddingProvider {
  readonly model = 'fixture-v1';
  readonly dimensions = 4;
  calls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return texts.map(() => [1, 0, 0, 0]);
  }
}

const embedder = new FixtureEmbedder();
let store: Store;

async function addDoc(id: string, content: string, docDate: string | null = null): Promise<void> {
  await store.query(`INSERT INTO documents (id, path, root, title, sha256, bytes, status, doc_date) VALUES ($1, $2, 'docs', $1, $3, 10, 'indexed', $4)`, [id, `raw/docs/${id}.md`, `sha-${id}`, docDate]);
  await store.query(`INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, 0, $3, 3, to_tsvector('simple', $3))`, [`c-${id}`, id, content]);
  await store.query(`INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::${VECTOR_TYPE})`, [`c-${id}`, embedder.model, toVectorLiteral([1, 0, 0, 0])]);
  await store.query(`INSERT INTO scopes (id, kind, key, sha, status, applied_at) VALUES ($1, 'doc', $2, $3, 'active', now())`, [`s-${id}`, `raw/docs/${id}.md`, `sha-${id}`]);
}

async function addEntity(id: string, name: string, type = 'organization'): Promise<void> {
  await store.query(`INSERT INTO entities (id, name, type, mention_count, aliases, description) VALUES ($1, $2, $3, 5, '[]'::jsonb, '')`, [id, name, type]);
  for (const key of entityKeyKinds(name).keys()) {
    await store.query(`INSERT INTO entity_alias_keys (entity_id, alias_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, key]);
  }
}

async function mention(entity: string, doc: string): Promise<void> {
  await store.query(`INSERT INTO entity_mentions (entity_id, chunk_id, document_id, scope_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [entity, `c-${doc}`, doc, `s-${doc}`]);
}

async function addClaim(id: string, subject: string, statement: string, doc: string, extra: { type?: string; eventAt?: string | null; supersededBy?: string } = {}): Promise<void> {
  await store.query(
    `INSERT INTO claims (id, subject_id, type, statement, status, kind, event_at, chunk_id, primary_scope_id, superseded_by, evidence_count, tx_from)
     VALUES ($1, $2, $3, $4, 'fact', 'fact', $5, $6, $7, $8, 1, now())`,
    [id, subject, extra.type ?? 'event', statement, extra.eventAt ?? null, `c-${doc}`, `s-${doc}`, extra.supersededBy ?? null],
  );
  await store.query(`INSERT INTO evidence (kind, target_id, scope_id, weight, extractor, tx_from) VALUES ('claim', $1, $2, 1, 'fixture', now())`, [id, `s-${doc}`]);
}

/** A client that records each prompt and answers with `reply`. */
function recordingLlm(reply: (prompt: string) => string): { llm: LlmClient; prompts: string[] } {
  const prompts: string[] = [];
  const llm = {
    enabled: true,
    complete: async (messages: ChatMessage[]) => {
      const prompt = messages.map((m) => m.content).join('\n');
      prompts.push(prompt);
      return reply(prompt);
    },
    completeJson: async () => {
      throw new Error('no JSON call expected');
    },
  } as unknown as LlmClient;
  return { llm, prompts };
}

/** Cites every fact line the prompt lists. */
const citeAll = (prompt: string) => {
  const refs = [...prompt.matchAll(/^\[(\d+)\] \[fact[^\]]*\] Nimbus Freight had a depot outage/gm)].map((m) => Number(m[1]));
  return `${refs.length} outages ${refs.map((r) => `[${r}]`).join('')}.\n{"citations":[${refs.join(',')}],"gaps":[]}`;
};

const OUTAGES = 30;
const config: KnodeConfig = defaultConfig();

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, embedder.dimensions);
  await store.indexing;
  await addEntity('nimbus', 'Nimbus Freight');
  await addEntity('borealis', 'Borealis Logistics');
  await addEntity('jane', 'Jane Okafor', 'person');
  await addEntity('weather', 'Monsoon', 'event');
  // thirty outage reports, one a document, spread over 2026: more than a top-k search or the 24 ranked facts hold
  for (let i = 1; i <= OUTAGES; i++) {
    const doc = `ops-${String(i).padStart(2, '0')}`;
    const month = String(((i - 1) % 6) + 1).padStart(2, '0');
    const day = String(((i - 1) % 27) + 1).padStart(2, '0');
    await addDoc(doc, `Operations note ${i}. Nimbus Freight had a depot outage at site ${i}. Staff meetings, schedules and other routine matters.`);
    await mention('nimbus', doc);
    await addClaim(`out-${i}`, 'nimbus', `Nimbus Freight had a depot outage at site ${i}`, doc, { type: 'incident', eventAt: `2026-${month}-${day}T12:00:00Z` });
  }
  await addDoc('weather', 'The monsoon arrived early this year.');
  await addClaim('rain', 'weather', 'The monsoon arrived early', 'weather');

  // two hops: Borealis was acquired by Nimbus, whose chief executive is Jane Okafor
  await addDoc('deal', 'Nimbus Freight acquired Borealis Logistics in a share deal.');
  await mention('nimbus', 'deal');
  await mention('borealis', 'deal');
  await addDoc('board', 'Jane Okafor is the chief executive of Nimbus Freight since 2024.');
  await mention('jane', 'board');
  await mention('nimbus', 'board');
  await store.query(`INSERT INTO relations (id, source_id, target_id, type, description, weight, document_id) VALUES ('r-acq', 'nimbus', 'borealis', 'acquired', 'Nimbus Freight acquired Borealis Logistics', 2, 'deal')`);
  await store.query(`INSERT INTO relations (id, source_id, target_id, type, description, weight, document_id) VALUES ('r-ceo', 'jane', 'nimbus', 'chief_executive_of', 'Jane Okafor leads Nimbus Freight as chief executive', 1, 'board')`);

  // a figure restated: the first report's claim was replaced by the second's
  await addDoc('q1-report', 'Borealis Logistics reported revenue of 40 million for the quarter.');
  await addDoc('q1-restated', 'Borealis Logistics restated its quarterly revenue to 38 million.');
  await addClaim('rev-new', 'borealis', 'Borealis Logistics quarterly revenue was 38 million', 'q1-restated', { type: 'revenue', eventAt: '2026-04-20T00:00:00Z' });
  await addClaim('rev-old', 'borealis', 'Borealis Logistics quarterly revenue was 40 million', 'q1-report', { type: 'revenue', eventAt: '2026-04-01T00:00:00Z', supersededBy: 'rev-new' });
});

afterAll(async () => {
  await store?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('question routing', () => {
  it('tells lookups, lists, counts, timelines and multi-hop questions apart by their wording', () => {
    const kinds: [string, string][] = [
      ['What is Nimbus Freight?', 'lookup'],
      ['Who founded Borealis Logistics?', 'lookup'],
      ['Which sites of Nimbus Freight had an outage?', 'list'],
      ['List every acquisition Nimbus Freight made.', 'list'],
      ['How many depot outages did Nimbus Freight have?', 'aggregate'],
      ['Nimbus 一共发生了几次停机？', 'aggregate'],
      ['Give the timeline of Nimbus Freight outages.', 'timeline'],
      ['按时间顺序列出 Nimbus 的事件', 'timeline'],
      ['Who is the chief executive of the company that acquired Borealis Logistics?', 'multihop'],
      ['收购 Borealis 的公司的CEO是谁？', 'multihop'],
    ];
    for (const [q, kind] of kinds) expect(classifyQuestion(q).kind, q).toBe(kind);
  });

  it('reads the time window a question names', () => {
    expect(questionRange('What happened in 2025?')).toMatchObject({ from: '2025-01-01T00:00:00.000Z', to: '2025-12-31T23:59:59.999Z' });
    expect(questionRange('Outages in March 2026')).toMatchObject({ from: '2026-03-01T00:00:00.000Z', to: '2026-03-31T23:59:59.999Z' });
    expect(questionRange('since 2024, which deals')).toMatchObject({ from: '2024-01-01T00:00:00.000Z', to: null });
    expect(questionRange('between 2024 and 2025')).toMatchObject({ from: '2024-01-01T00:00:00.000Z', to: '2025-12-31T23:59:59.999Z' });
    expect(questionRange('2026年3月的停机')).toMatchObject({ from: '2026-03-01T00:00:00.000Z' });
    expect(questionRange('2026Q2 revenue')?.from).toBe('2026-04-01T00:00:00.000Z');
    expect(questionRange('What is Nimbus?')).toBeNull();
  });

  it('asks the model only when told to, and only when the rules had no cue', async () => {
    let calls = 0;
    const llm = { enabled: true, completeJson: async () => { calls++; return { kind: 'multihop' }; } } as unknown as LlmClient;
    expect((await routeQuestion('Nimbus and Borealis, related?', { llm })).kind).toBe('lookup');
    expect((await routeQuestion('Nimbus and Borealis, related?', { classifier: 'model', llm }))).toMatchObject({ kind: 'multihop', by: 'model' });
    expect((await routeQuestion('How many outages?', { classifier: 'model', llm })).by).toBe('rule:aggregate');
    expect(calls).toBe(1);
  });
});

describe('ask, routed', () => {
  it('answers a list question from the enumerated claims, every item listed, with one completion', async () => {
    const { llm, prompts } = recordingLlm(citeAll);
    const before = embedder.calls;
    const res = await ask(store, config, embedder, llm, 'Which sites of Nimbus Freight had a depot outage?');
    expect(res.route).toMatchObject({ kind: 'list', enumerated: { matched: OUTAGES + 0, documents: OUTAGES } });
    expect(prompts).toHaveLength(1);
    expect(embedder.calls).toBe(before + 1);
    // every outage is in the prompt and in the facts, each cited back to its own document
    for (let i = 1; i <= OUTAGES; i++) expect(prompts[0]).toContain(`Nimbus Freight had a depot outage at site ${i} (`);
    expect(new Set(res.facts.map((f) => f.id).filter((id) => id.startsWith('out-'))).size).toBe(OUTAGES);
    expect(prompts[0]).toMatch(/# Known facts \(enumerated: 30 of 30 matching claims listed\)/);
    expect(prompts[0]).toContain('# Counts\n30 matching claims from 30 documents');
    expect(prompts[0]).toContain('Known facts marked "enumerated" are every claim');
    expect(new Set(res.citations.map((c) => c.path)).size).toBe(OUTAGES);
    // a short search, not the top eight
    expect(res.contexts.filter((c) => !c.excerpt).length).toBeLessThanOrEqual(4);
  });

  it('counts over the whole match inside the window the question names', async () => {
    const { llm, prompts } = recordingLlm(citeAll);
    const res = await ask(store, config, embedder, llm, 'How many depot outages did Nimbus Freight have in March 2026?');
    expect(res.route.kind).toBe('aggregate');
    expect(res.route.range?.text).toBe('March 2026');
    expect(res.route.enumerated?.matched).toBe(5);
    expect(prompts[0]).toContain('5 matching claims from 5 documents');
    // nothing dated outside March is listed
    const listed = [...prompts[0].matchAll(/depot outage at site \d+ \((2026-\d\d)/g)].map((m) => m[1]);
    expect(new Set(listed)).toEqual(new Set(['2026-03']));
  });

  it('lists a timeline oldest first, with the claim a newer one replaced marked as such', async () => {
    const { llm, prompts } = recordingLlm(() => 'History.\n{"citations":[],"gaps":[]}');
    const res = await ask(store, config, embedder, llm, 'Give the timeline of Borealis Logistics revenue figures.');
    expect(res.route).toMatchObject({ kind: 'timeline', enumerated: { types: ['revenue'] } });
    const old = prompts[0].indexOf('[fact; replaced later] Borealis Logistics quarterly revenue was 40 million (2026-04-01)');
    const now = prompts[0].indexOf('[fact] Borealis Logistics quarterly revenue was 38 million (2026-04-20)');
    expect(old).toBeGreaterThan(0);
    expect(now).toBeGreaterThan(old);
  });

  it('walks relations for a multi-hop question and reads the passages that state each hop', async () => {
    const { llm, prompts } = recordingLlm(() => 'Jane Okafor.\n{"citations":[],"gaps":[]}');
    const res = await ask(store, config, embedder, llm, 'Who is the chief executive of the company that acquired Borealis Logistics?');
    expect(res.route.kind).toBe('multihop');
    expect(res.route.walked).toMatchObject({ hops: 2, relations: 2 });
    expect(prompts[0]).toContain('Nimbus Freight acquired Borealis Logistics: Nimbus Freight acquired Borealis Logistics — raw/docs/deal.md');
    expect(prompts[0]).toContain('Jane Okafor chief executive of Nimbus Freight');
    expect(res.contexts.map((c) => c.path)).toEqual(expect.arrayContaining(['raw/docs/deal.md', 'raw/docs/board.md']));
  });

  it('keeps the single-shot path for a lookup, and falls back to it when nothing is enumerated', async () => {
    const { llm, prompts } = recordingLlm(() => 'Early.\n{"citations":[],"gaps":[]}');
    const res = await ask(store, config, embedder, llm, 'When did the monsoon arrive?');
    expect(res.route).toMatchObject({ kind: 'lookup', by: 'rule:default' });
    expect(prompts[0]).not.toContain('enumerated');
    const none = await ask(store, config, embedder, llm, 'Which planets have rings?');
    expect(none.route).toMatchObject({ kind: 'list', by: 'fallback:rule:list' });
    expect(none.route.enumerated).toBeUndefined();
  });

  it('lists the claim that holds now beside a passage stating the one it replaced', async () => {
    const hits = await search(store, embedder, 'Borealis Logistics reported revenue of 40 million', { k: 3, mode: 'keyword', track: false });
    const old = hits.find((h) => h.chunkId === 'c-q1-report')!;
    expect(old.current).toEqual([{
      was: { id: 'rev-old', statement: 'Borealis Logistics quarterly revenue was 40 million' },
      now: { id: 'rev-new', statement: 'Borealis Logistics quarterly revenue was 38 million', date: '2026-04-20', path: 'raw/docs/q1-restated.md' },
    }]);
    expect(hits.find((h) => h.chunkId === 'c-q1-restated')?.current).toBeUndefined();
    const { llm, prompts } = recordingLlm(() => '38 million.\n{"citations":[],"gaps":[]}');
    await ask(store, config, embedder, llm, 'What revenue did Borealis Logistics report for the quarter?', { route: 'lookup' });
    expect(prompts[0]).toContain('Borealis Logistics quarterly revenue was 38 million (replaces: Borealis Logistics quarterly revenue was 40 million)');
  });
});

describe('claim enumeration', () => {
  it('filters by entity, type and window, and counts by month over the whole match', async () => {
    const e = await enumerateClaims(store, { entities: ['nimbus'], types: ['incident'], range: { from: '2026-01-01T00:00:00Z', to: '2026-02-28T23:59:59Z' }, limit: 3 });
    expect(e.matched).toBe(10);
    expect(e.claims).toHaveLength(3);
    expect(e.byMonth).toEqual([['2026-01', 5], ['2026-02', 5]]);
    expect(e.claims[0]).toMatchObject({ sources: ['raw/docs/ops-01.md'], superseded: false });
    // nothing to enumerate by
    expect((await enumerateClaims(store, {})).matched).toBe(0);
  });

  it('reads the typed claim columns once they exist', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-typed-claims-'));
    fs.mkdirSync(path.join(dir, '.knode'), { recursive: true });
    const typed = await Store.open(dir, 4);
    try {
      await typed.indexing;
      await typed.query(`INSERT INTO entities (id, name, type, mention_count, aliases, description) VALUES ('x', 'Xeno', 'organization', 1, '[]'::jsonb, '')`);
      await typed.query(`INSERT INTO claims (id, subject_id, type, statement, status, attribute, value_num, unit, effective_at, tx_from) VALUES ('v1', 'x', 'revenue', 'Xeno revenue was 12', 'fact', 'revenue', 12, 'million USD', '2026-05-10T00:00:00Z', now())`);
      // the claim-state migration (v19) adds them to every store
      expect(await typedColumns(typed)).toEqual({ attribute: 'attribute', valueNum: 'value_num', valueText: 'value_text', unit: 'unit', effective: 'effective_at' });
      const e = await enumerateClaims(typed, { entities: ['x'], range: { from: '2026-05-01T00:00:00Z', to: '2026-05-31T00:00:00Z' } });
      expect(e.claims[0]).toMatchObject({ attribute: 'revenue', value: '12', unit: 'million USD', date: '2026-05-10' });
    } finally {
      await typed.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('walks no further than the question leads', async () => {
    const walk = await walkRelations(store, 'Who is the chief executive of the company that acquired Borealis Logistics?', ['borealis'], { maxHops: 1 });
    expect(walk.steps.map((s) => s.relationId)).toEqual(['r-acq']);
    expect(walk.bridges.map((b) => b.chunkId)).toEqual(['c-deal']);
  });
});

describe('relation walk', () => {
  // its own store: a chain across three divisions, a customer with incidents in each, and a hub group
  let walkStore: Store;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-walk-'));
  let rel = 0;
  const entity = (id: string, name: string, type = 'organization') =>
    walkStore.query(`INSERT INTO entities (id, name, type, mention_count, aliases, description) VALUES ($1, $2, $3, 1, '[]'::jsonb, '')`, [id, name, type]);
  /** A relation, and a passage that mentions both its ends. */
  const relate = async (source: string, target: string, description: string, weight = 1, type = 'related_to') => {
    const id = `w${++rel}`;
    await walkStore.query(`INSERT INTO documents (id, path, root, title, sha256, bytes, status) VALUES ($1, $2, 'docs', $1, $1, 10, 'indexed')`, [`d-${id}`, `raw/docs/${id}.md`]);
    await walkStore.query(`INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, 0, $3, 3, to_tsvector('simple', $3))`, [`c-${id}`, `d-${id}`, description]);
    for (const e of [source, target]) {
      await walkStore.query(`INSERT INTO entity_mentions (entity_id, chunk_id, document_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [e, `c-${id}`, `d-${id}`]);
    }
    await walkStore.query(`INSERT INTO relations (id, source_id, target_id, type, description, weight, document_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, source, target, type, description, weight, `d-${id}`]);
    return id;
  };

  beforeAll(async () => {
    fs.mkdirSync(path.join(dir, '.knode'), { recursive: true });
    walkStore = await Store.open(dir, 4);
    await walkStore.indexing;
    for (const [id, name] of [['d7', '第七事业部'], ['d2', '第二事业部'], ['d3', '第三事业部'], ['g7', '七部平台组'], ['g7b', '七部增长组'], ['g2', '二部平台组'], ['g3', '三部平台组'], ['cust', '华鼎零售']]) await entity(id, name);
    for (const [id, name] of [['huang', '黄勇'], ['qian', '钱勇'], ['lin', '林婷']]) await entity(id, name, 'person');
    for (const [id, name] of [['inc7', 'INC-001-D7T1'], ['risk', 'R-13'], ['proj', '文昌计划']]) await entity(id, name, 'other');
    await relate('g7', 'd7', '七部平台组隶属于第七事业部。', 10, 'part_of');
    await relate('g7b', 'd7', '七部增长组隶属于第七事业部。', 10, 'part_of');
    await relate('g2', 'd2', '二部平台组隶属于第二事业部。', 10, 'part_of');
    await relate('g3', 'd3', '三部平台组隶属于第三事业部。', 10, 'part_of');
    // the customer escalated six heavier incidents in other divisions, and one in the seventh
    for (let i = 1; i <= 6; i++) {
      const inc = `inc-other-${i}`;
      await entity(inc, `INC-00${i}-D${i % 2 ? 2 : 3}T1`, 'other');
      await relate('cust', inc, '华鼎零售升级上报了该事故。', 3);
      await relate(inc, i % 2 ? 'g2' : 'g3', '平台组报告的事故。');
    }
    await relate('inc7', 'cust', '事故涉及华鼎零售投诉升级。', 1);
    await relate('inc7', 'g7', '七部平台组报告的事故。', 1);
    await relate('huang', 'inc7', '黄勇修复了INC-001-D7T1。', 1);
    await relate('huang', 'g7b', '黄勇本周从七部平台组调入七部增长组。', 2, 'works_at');
    await relate('huang', 'proj', '自本周起接手项目。', 5);
    // a risk raised by one person, followed by another, and tracked by a hub group whose incidents outweigh the person's
    await relate('qian', 'risk', '钱勇提出R-13风险。', 1);
    await relate('risk', 'g2', 'R-13是二部平台组跟踪的风险。', 1);
    for (let i = 1; i <= 6; i++) {
      await entity(`hub-${i}`, `INC-01${i}-D2T1`, 'other');
      await relate(`hub-${i}`, 'g2', '二部平台组修复的事故。', 5);
    }
    await entity('inc-q', 'INC-009-D2T1', 'other');
    await relate('qian', 'inc-q', '钱勇修复了INC-009-D2T1。', 1);
  });

  afterAll(async () => {
    await walkStore?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a predicate in its other spellings, and leaves out the fragments of what the question names', () => {
    const { terms, budget } = walkTerms('（第七事业部）是谁处理好的？此人名下的那个项目是在哪一周投产的？', ['第七事业部']);
    const texts = terms.map((t) => t.text);
    expect(texts).toEqual(expect.arrayContaining(['修复', '负责', '上线']));
    expect(texts).not.toContain('事业');
    // a predicate the question uses twice may be walked twice
    const twice = walkTerms('提出风险R-13的人修复过一起由客户升级的事故。同一个客户还在另一个组升级过事故——那一起是谁修复的？');
    expect(twice.budget.get(twice.terms.find((t) => t.text === '升级')!.key)).toBe(2);
    expect(budget.get(terms.find((t) => t.text === '修复')!.key)).toBe(1);
  });

  it('prefers, among a named entity\'s relations, the one whose far end lies near the other entity the question names', async () => {
    const q = '（第七事业部）华鼎零售升级的那起事故，是谁处理好的？此人后来调到了另一个组，并在那里接手了一个项目，那个项目叫什么？';
    const walk = await walkRelations(walkStore, q, ['d7', 'cust'], { maxHops: 3 });
    const hop = (n: number) => walk.steps.filter((s) => s.hop === n).map((s) => `${s.source}→${s.target}`);
    // the six heavier incidents of other divisions do not crowd out the seventh division's
    expect(hop(1)).toContain('INC-001-D7T1→华鼎零售');
    // 处理好 reads the relation that says 修复
    expect(hop(2)).toContain('黄勇→INC-001-D7T1');
    expect(hop(3)).toEqual(expect.arrayContaining(['黄勇→文昌计划', '黄勇→七部增长组']));
    // the passages, best chain first and from its first hop down
    const order = chainOrder(walk.steps).map((i) => walk.steps[i].hop);
    expect(order.slice(0, 3)).toEqual([1, 2, 3]);
    expect(walk.bridges[0].trace?.bridgeEntities).toEqual(expect.arrayContaining(['华鼎零售']));
  });

  it('lets every branch take its best step, so a hub cannot take a hop whole', async () => {
    const walk = await walkRelations(walkStore, '（第二事业部）提出风险R-13的人修复过哪起事故？', ['d2', 'risk'], { maxHops: 2 });
    expect(walk.steps.filter((s) => s.hop === 1).map((s) => s.source)).toEqual(expect.arrayContaining(['钱勇']));
    // the group's six heavier incidents match as well, but the person who raised the risk still takes their own step
    expect(walk.steps.filter((s) => s.hop === 2).map((s) => `${s.source}→${s.target}`)).toContain('钱勇→INC-009-D2T1');
  });
});

describe('catalog guide', () => {
  it('runs every example query it shows the agent', async () => {
    // one claim of the entity read as an attribute with a value, as refine leaves it (docs/design/29)
    const [seed] = await store.query<{ id: string }>(`SELECT c.id FROM claims c JOIN entities e ON e.id = c.subject_id WHERE e.name ILIKE 'Nimbus%' ORDER BY c.id LIMIT 1`);
    await store.query(`UPDATE claims SET attribute = 'revenue', value_num = 12, unit = 'million USD' WHERE id = $1`, [seed.id]);
    try {
      for (const ex of CATALOG_EXAMPLES) {
        const sql = ex.sql.replace("'Acme%'", "'Nimbus%'");
        const r = await catalogQuery(store, sql);
        expect(r.rowCount, ex.question).toBeGreaterThan(0);
      }
    } finally {
      await store.query(`UPDATE claims SET attribute = NULL, value_num = NULL, unit = NULL WHERE id = $1`, [seed.id]);
    }
    expect(catalogGuide()).toContain('v_claims(');
  });

  it('is in the benchmark agent\'s brief, with knode_query among its tools', () => {
    expect(KNODE_AGENT_TOOLS).toContain('knode_query');
    const brief = knodeAgentBrief();
    expect(brief).toContain('knode_query with source="catalog"');
    expect(brief).toContain(CATALOG_EXAMPLES[0].sql);
    expect(brief).not.toContain('shell commands');
  });

  it('routes the brief by the kinds of question the reports run showed to matter, with grep named by the arm', () => {
    const brief = knodeAgentBrief();
    expect(brief).toContain('order="timeline"');
    expect(brief).toContain('v_relations');
    expect(brief).toContain('company-wide');
    expect(brief).toContain('as of a date');
    expect(brief).toContain(CATALOG_EXAMPLES.find((e) => e.sql.includes('FROM v_relations'))!.sql);
    // an arm with a shell over the files and only the structured tools gets the same kinds, with its own grep
    const shell = questionKindGuide({ grep: 'rg -n -C3 in the shell', read: 'cat or sed -n in the shell' });
    expect(shell).not.toMatch(/knode_grep|knode_read|knode_ls/);
    expect(shell).toContain('rg -n -C3 in the shell');
  });
});

describe('rerank stage', () => {
  let server: http.Server;
  let base = '';
  const bodies: unknown[] = [];
  let mode: 'tei' | 'openai' | 'fail' = 'tei';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as { texts?: string[]; documents?: string[] };
        bodies.push({ url: req.url, auth: req.headers.authorization, body });
        const texts = body.texts ?? body.documents ?? [];
        // the passage that names "lidar" first, the others after, in reverse
        const scored = texts.map((t, index) => ({ index, score: t.includes('lidar') ? 0.99 : index / 100 })).sort((a, b) => b.score - a.score);
        if (mode === 'fail') {
          res.writeHead(503).end('busy');
        } else if (mode === 'tei') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(scored));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results: scored.map((s) => ({ index: s.index, relevance_score: s.score })) }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const hit = (id: string, content: string, score: number): SearchResult => ({ chunkId: id, documentId: id, path: `raw/docs/${id}.md`, title: null, content, score, signals: {} });
  const fused = [hit('a', 'alpha', 0.3), hit('b', 'beta', 0.2), hit('c', 'the lidar unit', 0.1), hit('d', 'delta', 0.05)];
  const cfg = (extra: Partial<RerankConfig> = {}): RerankConfig => ({ ...defaultRerankConfig(), enabled: true, url: base, candidates: 3, ...extra });

  it('reorders the fused head by the cross-encoder (TEI style) and leaves the tail in fused order', async () => {
    mode = 'tei';
    const r = await rerankResults(cfg(), 'which unit is lidar', fused);
    expect(r.results.map((x) => x.chunkId)).toEqual(['c', 'b', 'a', 'd']);
    expect(r.results[0].signals.rerank).toBe(0.99);
    expect(r.sent).toBe(3);
    expect(bodies.at(-1)).toMatchObject({ url: '/rerank', body: { query: 'which unit is lidar', texts: ['alpha', 'beta', 'the lidar unit'] } });
  });

  it('speaks the OpenAI-compatible shape with a model and a key', async () => {
    mode = 'openai';
    const r = await rerankResults(cfg({ style: 'openai', model: 'bge-reranker-v2-m3', apiKey: 'test-key', url: `${base}/v1/rerank` }), 'lidar', fused);
    expect(r.results[0].chunkId).toBe('c');
    expect(bodies.at(-1)).toMatchObject({ url: '/v1/rerank', auth: 'Bearer test-key', body: { model: 'bge-reranker-v2-m3', documents: ['alpha', 'beta', 'the lidar unit'], top_n: 3 } });
    expect(parseRerankResponse({ data: [{ index: 0, score: 1 }] })).toEqual([[0, 1]]);
  });

  it('keeps the fused order when the server fails, and runs inside search only when enabled', async () => {
    mode = 'fail';
    const r = await rerankResults(cfg(), 'lidar', fused);
    expect(r.results).toEqual(fused);
    expect(r.error).toMatch(/503/);
    mode = 'tei';
    const n = bodies.length;
    await search(store, embedder, 'depot outage', { k: 3, track: false });
    await search(store, embedder, 'depot outage', { k: 3, track: false, rerank: { ...cfg(), enabled: false } });
    expect(bodies.length).toBe(n);
    const { searchExplained } = await import('../src/search/search.js');
    const on = await searchExplained(store, embedder, 'depot outage', { k: 3, track: false, rerank: cfg({ candidates: 10 }) });
    expect(bodies.length).toBe(n + 1);
    expect(on.channels.rerank).toMatchObject({ hits: 10 });
    expect(on.results).toHaveLength(3);
    expect(on.results.every((x) => typeof x.signals.rerank === 'number')).toBe(true);
  });
});

describe('batched agent tools', () => {
  const dataDir = path.join(tmp, 'data');
  let ctx: AppContext;

  beforeAll(() => {
    const docs = path.join(dataDir, 'raw', 'docs');
    fs.mkdirSync(path.join(docs, 'ops'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(docs, 'ops', 'a.md'), '# A\nline two\nNimbus outage at site 1\nline four\nline five\n');
    fs.writeFileSync(path.join(docs, 'ops', 'b.md'), '# B\n\n## Costs\nThe repair cost 40k.\n\n## Staff\nNimbus outage at site 2 hit the night shift.\n');
    fs.writeFileSync(path.join(docs, 'long.md'), Array.from({ length: 400 }, (_, i) => `long line ${i + 1} ${'x'.repeat(60)}`).join('\n'));
    fs.writeFileSync(path.join(dataDir, 'wiki', 'nimbus.md'), '# Nimbus Freight\nA freight company. Nimbus outage history is in raw/docs/ops.\n');
    ctx = { dataDir, config: defaultConfig() } as unknown as AppContext;
  });

  it('reads several files in one call, short ones whole, a long one cut where it says to read on', async () => {
    const text = await readMany(ctx, [
      { path: 'raw/docs/ops/a.md' },
      { path: 'raw/docs/ops/b.md', section: 'Staff' },
      { path: 'raw/docs/long.md' },
      { path: 'raw/docs/missing.md' },
    ], 4000);
    expect(text).toContain('=== raw/docs/ops/a.md ===\n# A\nline two\nNimbus outage at site 1');
    expect(text).toContain('=== raw/docs/ops/b.md § Staff ===');
    expect(text).toContain('Nimbus outage at site 2 hit the night shift.');
    expect(text).not.toContain('The repair cost 40k.');
    expect(text).toMatch(/=== raw\/docs\/long\.md ===\nlong line 1 x+\n[\s\S]*…\(cut by the batch budget after (\d+) of 400 lines; read on with \{"path": "raw\/docs\/long\.md", "offset": (\d+)\}\)/);
    const m = /after (\d+) of 400 lines; read on with \{"path": "raw\/docs\/long\.md", "offset": (\d+)\}/.exec(text)!;
    expect(Number(m[2])).toBe(Number(m[1]) + 1);
    expect(text).toMatch(/=== raw\/docs\/missing\.md ===\n\(error: /);
    expect(text.length).toBeLessThan(4000 + 600);
    expect(shareBudget([10, 1000, 1000], 1000)).toEqual([10, 495, 495]);
  });

  it('greps several subtrees with context lines grouped by file', () => {
    const text = grepWithContext(ctx, { pattern: 'Nimbus outage', paths: ['raw/docs/ops', 'wiki'], context: 1 });
    expect(text).toContain('== raw/docs/ops/a.md (1 match)\n2- line two\n3: Nimbus outage at site 1\n4- line four');
    expect(text).toContain('== raw/docs/ops/b.md (1 match)\n6- ## Staff\n7: Nimbus outage at site 2 hit the night shift.\n8- ');
    expect(text).toContain('== wiki/nimbus.md (1 match)');
  });

  it('takes the batched forms through the MCP tools, and the single-path forms as before', async () => {
    const tools = new Map<string, { schema: Record<string, z.ZodTypeAny>; handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
    const fake = {
      registerTool: (name: string, config: { inputSchema: Record<string, z.ZodTypeAny> }, handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) => {
        tools.set(name, { schema: config.inputSchema, handler });
      },
    } as unknown as McpServer;
    registerKnodeTools(fake, ctx);
    const call = async (name: string, args: Record<string, unknown>) => {
      const t = tools.get(name)!;
      const parsed = z.object(t.schema).parse(args);
      return (await t.handler(parsed)).content[0].text;
    };
    const many = await call('knode_read', { paths: ['raw/docs/ops/a.md', { path: 'raw/docs/ops/b.md', section: 'Costs' }] });
    expect(many).toContain('=== raw/docs/ops/a.md ===');
    expect(many).toContain('The repair cost 40k.');
    expect(await call('knode_read', { path: 'raw/docs/ops/a.md', offset: 3, limit: 1 })).toContain('Nimbus outage at site 1');
    expect(await call('knode_read', { path: 'raw/docs/ops/a.md' })).toBe('# A\nline two\nNimbus outage at site 1\nline four\nline five\n');
    expect(await call('knode_grep', { pattern: 'site 2', path: 'raw/docs', context: 2 })).toContain('7: Nimbus outage at site 2');
    expect(JSON.parse(await call('knode_grep', { pattern: 'site \\d', path: 'raw/docs' }))).toEqual({
      matches: [
        { path: 'raw/docs/ops/a.md', line: 3, text: 'Nimbus outage at site 1' },
        { path: 'raw/docs/ops/b.md', line: 7, text: 'Nimbus outage at site 2 hit the night shift.' },
      ],
      total: 2,
    });
    expect(tools.get('knode_query')!.schema.source).toBeDefined();
  });
});
