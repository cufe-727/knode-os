import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { auditDuplicateClaims, claimPairId, ClaimRelation } from '../src/graph/claim-dedupe.js';
import { auditDuplicateEntities, mergeSuggestionId } from '../src/graph/dedupe.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { sync } from '../src/ingest/sync.js';
import { LlmClient } from '../src/llm/client.js';
import { sourcesOf } from '../src/store/claims.js';

/**
 * The duplicate audits at the sizes a real workspace reaches: a nightly run
 * over every claim (or entity) brings up more candidate pairs than one
 * statement can bind (Postgres and PGlite both stop at 65,535 parameters), so
 * id lists go to the database as one array parameter. It also brings up more
 * pairs than one night can judge, so the claim audit judges at most
 * review.claimMergeMaxJudgedPerRun of them, the most promising first; with real
 * vectors, a pair that only shares a number needs a cosine of 0.7 as well.
 */

const MAX_PARAMS = 65_535;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-dedupe-scale-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** A document declaring `statements` as claims about `subject`. */
const claimsDoc = (subject: string, statements: string[]) =>
  [
    '---',
    `title: ${subject}`,
    'entities:',
    `  - { name: ${subject}, type: organization }`,
    'claims:',
    ...statements.map((s) => `  - { subject: ${subject}, statement: ${JSON.stringify(s)} }`),
    '---',
    `# ${subject}`,
    '',
  ].join('\n');

/** Every pair among `ids`, keyed the way the audit keys it. */
function everyPair(ids: string[], key: (a: string, b: string) => string): { id: string; a: string; b: string }[] {
  const out: { id: string; a: string; b: string }[] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) out.push({ id: key(ids[i], ids[j]), a: ids[i], b: ids[j] });
  return out;
}

const pairLabel = (a: string, b: string) => [a, b].sort().join(' | ');

/**
 * A judge that records the pairs it was shown (`calls`: call by call) and answers nothing, or `relation` for every
 * pair. The audit sends its calls through a JudgeRunner (src/work/judge.ts), which reads complete()'s reply as JSON.
 */
function recordingJudge(shown: string[], opts: { relation?: ClaimRelation; calls?: string[][] } = {}): LlmClient {
  const complete = async (messages: { role: string; content: string }[]) => {
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    const pairs = [...user.matchAll(/Pair \d+ — subject: [^\n]*\nA: "([^"]*)"[\s\S]*?\nB: "([^"]*)"/g)].map((m) => pairLabel(m[1], m[2]));
    shown.push(...pairs);
    opts.calls?.push(pairs);
    return JSON.stringify({ verdicts: opts.relation ? pairs.map((_, i) => ({ pair: i + 1, relation: opts.relation, confidence: 0.3, reason: '测试' })) : [] });
  };
  return { enabled: true, label: 'stub', provider: 'openai', model: 'stub', complete } as unknown as LlmClient;
}

describe('the duplicate-claim audit at scale', () => {
  const dataDir = path.join(tmp, 'claims');
  let ctx: AppContext;
  // one number in every statement: each of the n(n-1)/2 pairs is a candidate
  const n = 370;
  const statement = (i: number) => `第${i}项业务收入同比增长20%`;

  beforeAll(async () => {
    initDataDir(dataDir);
    write(dataDir, 'raw/docs/jia.md', claimsDoc('甲公司', Array.from({ length: n }, (_, i) => statement(i))));
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
  });
  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
  });

  it('judges no more of a backlog than one run may, and leaves the rest for later', async () => {
    // the first night after a long outage: no pair has a verdict yet. The stub
    // answers nothing, so `judged` stays 0 and the next test finds no verdicts.
    const total = (n * (n - 1)) / 2;
    const calls: string[][] = [];
    const lines: string[] = [];
    const stats = await auditDuplicateClaims({ store: ctx.store, embedder: ctx.embedder, config: ctx.config, llm: recordingJudge([], { calls }) }, { onProgress: (m) => lines.push(m) });
    expect(ctx.config.review.claimMergeMaxJudgedPerRun).toBe(1200);
    expect(stats).toMatchObject({ candidates: total, deferred: total - 1200 });
    expect(calls).toHaveLength(100);
    expect(new Set(calls.flat()).size).toBe(1200);
    expect(lines).toContain(`claims: 0 merged, 0 merge suggestions, 0 contradictions (${total} pairs, 0 judged, ${total - 1200} left for later)`);
  });

  it('looks up the decided pairs among more candidates than one statement can bind', async () => {
    const { store } = ctx;
    const rows = await store.query<{ id: string; statement: string }>(`SELECT id, statement FROM claims WHERE tx_to IS NULL`);
    expect(rows).toHaveLength(n);
    const idOf = new Map(rows.map((r) => [r.statement, r.id]));
    const all = everyPair(rows.map((r) => r.id), claimPairId);
    expect(all.length).toBeGreaterThan(MAX_PARAMS);

    // earlier runs settled every pair but two: half by a remembered verdict, half by a person's answer
    const open = new Set([claimPairId(idOf.get(statement(0))!, idOf.get(statement(1))!), claimPairId(idOf.get(statement(2))!, idOf.get(statement(3))!)]);
    const decided = all.filter((p) => !open.has(p.id));
    const judged = decided.filter((_, i) => i % 2 === 0);
    const answered = decided.filter((_, i) => i % 2 === 1);
    await store.query(
      `INSERT INTO claim_pair_verdicts (pair_id, a_id, b_id, relation, confidence, reason, model)
       SELECT pair_id, a_id, b_id, 'unrelated', 0.9, '不同业务', 'earlier-run' FROM unnest($1::text[], $2::text[], $3::text[]) AS t(pair_id, a_id, b_id)`,
      [judged.map((p) => p.id), judged.map((p) => p.a), judged.map((p) => p.b)],
    );
    await store.query(
      `INSERT INTO suggestions (id, kind, title, body, status)
       SELECT id, 'claim-merge', '合并重复断言: 甲公司', '', 'rejected' FROM unnest($1::text[]) AS id`,
      [answered.map((p) => p.id)],
    );

    const shown: string[] = [];
    const stats = await auditDuplicateClaims({ store, embedder: ctx.embedder, config: ctx.config, llm: recordingJudge(shown) });
    expect(stats.candidates).toBe(all.length);
    expect(stats).toMatchObject({ identical: 0, differentTime: 0, merged: 0, suggested: 0, conflicts: 0 });
    expect(shown.sort()).toEqual([pairLabel(statement(0), statement(1)), pairLabel(statement(2), statement(3))].sort());
  });

  it('compares a subject\'s claims by embedding with the whole subject bound as one array', async () => {
    const { store } = ctx;
    const others = Array.from({ length: 40 }, (_, i) => `乙公司第${i}家门店开业`);
    const twins = ['乙公司计划扩大海外产能', '乙公司打算扩充在海外的生产能力'];
    write(dataDir, 'raw/docs/yi.md', claimsDoc('乙公司', [...others, ...twins]));
    await sync(ctx, { llmGraph: false });
    const focus = (await store.query<{ id: string }>(`SELECT id FROM claims WHERE subject_id = '乙公司' AND tx_to IS NULL`)).map((r) => r.id);
    expect(focus).toHaveLength(others.length + twins.length);

    // the two wordings of the overseas plan share a vector; every other claim has its own
    const dim = store.embeddingDim;
    const slots = new Map<string, number>();
    const embedder: EmbeddingProvider = {
      model: 'test-vectors',
      dimensions: dim,
      embed: async (texts) =>
        texts.map((t) => {
          const key = t.includes('海外') ? '海外' : t;
          if (!slots.has(key)) slots.set(key, slots.size);
          return Array.from({ length: dim }, (_, i) => (i === slots.get(key) ? 1 : 0));
        }),
    };
    const config = { ...ctx.config, embedding: { ...ctx.config.embedding, provider: 'openai' as const } };

    const spy = vi.spyOn(store, 'query');
    const shown: string[] = [];
    try {
      const stats = await auditDuplicateClaims({ store, embedder, config, llm: recordingJudge(shown) }, { focus });
      expect(stats).toMatchObject({ embedded: focus.length, candidates: 1 });
      expect(shown).toEqual([pairLabel(twins[0], twins[1])]);
      // two parameters per claim however many claims its subject has: the claim, and the rest of the subject as one array
      const similarity = spy.mock.calls.filter(([sql]) => sql.includes('JOIN claim_embeddings b'));
      expect(similarity).toHaveLength(focus.length);
      for (const [, params] of similarity) {
        expect(params).toHaveLength(2);
        expect(params?.[1]).toHaveLength(focus.length - 1);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('looks up the sources of more claims than one statement can bind', async () => {
    const [claim] = await ctx.store.query<{ id: string }>(`SELECT id FROM claims WHERE statement = $1`, [statement(0)]);
    const ids = [claim.id, ...Array.from({ length: 70_000 }, (_, i) => `claim-${i}`)];
    expect(ids.length).toBeGreaterThan(MAX_PARAMS);
    expect(await sourcesOf(ctx.store, ids)).toEqual(new Map([[claim.id, ['raw/docs/jia.md']]]));
  });
});

describe('the claim audit\'s per-run judge limit', () => {
  const dataDir = path.join(tmp, 'judge-limit');
  let ctx: AppContext;
  // all share 20%: pairs only the judge can settle, and tied on every signal
  const statement = (i: number) => `第${i}项业务收入同比增长20%`;
  const limited = (max: number) => ({ ...ctx.config, review: { ...ctx.config.review, claimMergeMaxJudgedPerRun: max } });
  const realVectors = () => ({ ...ctx.config, embedding: { ...ctx.config.embedding, provider: 'openai' as const } });
  /** `v` along axis `k` and the rest along `rest`: cosine `v` with the unit vector along `k`. */
  const vector = (k: number, v = 1, rest = -1) => Array.from({ length: ctx.store.embeddingDim }, (_, i) => (i === k ? v : i === rest ? Math.sqrt(1 - v * v) : 0));

  beforeAll(async () => {
    initDataDir(dataDir);
    // the rules settle two more pairs: one revenue figure for two years, and a buyback plan
    // whose twin, identical once normalized, comes in the later document
    write(dataDir, 'raw/docs/old.md', claimsDoc('丙公司', [...Array.from({ length: 6 }, (_, i) => statement(i)), '丙公司2024年营收100亿元', '丙公司2025年营收100亿元', '丙公司计划回购股份。']));
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
    // written later: these are the newest claims
    write(dataDir, 'raw/docs/new.md', claimsDoc('丙公司', [statement(6), statement(7), '丙公司 计划回购股份']));
    await sync(ctx, { llmGraph: false });
  });
  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
  });

  it('settles rule pairs whatever the limit, and judges the rest over several runs, newest claims first', async () => {
    const { store, embedder } = ctx;
    const shown: string[] = [];
    const run = async (max: number) => {
      const calls: string[][] = [];
      const lines: string[] = [];
      const stats = await auditDuplicateClaims({ store, embedder, config: limited(max), llm: recordingJudge(shown, { relation: 'unrelated', calls }) }, { onProgress: (m) => lines.push(m) });
      return { stats, calls, lines };
    };

    // with no judge calls allowed, the rule pairs still settle
    const first = await run(0);
    expect(first.stats).toMatchObject({ candidates: 30, identical: 1, differentTime: 1, merged: 1, judged: 0, deferred: 28 });
    expect(first.calls).toEqual([]);
    expect(first.lines).toContain('claims: 1 merged, 0 merge suggestions, 0 contradictions (30 pairs, 0 judged, 28 left for later)');

    // the 13 pairs with a claim of the later document go first
    const second = await run(13);
    expect(second.stats).toMatchObject({ candidates: 29, identical: 0, differentTime: 0, judged: 13, deferred: 15 });
    expect(second.calls.map((c) => c.length)).toEqual([12, 1]);
    const newer = [statement(6), statement(7)];
    for (const label of second.calls.flat()) expect(newer.some((s) => label.split(' | ').includes(s))).toBe(true);
    expect(second.lines).toContain('claims: 0 merged, 0 merge suggestions, 0 contradictions (29 pairs, 13 judged, 15 left for later)');

    // what was left comes up again until every pair has a verdict, and none is judged twice
    expect((await run(13)).stats).toMatchObject({ judged: 13, deferred: 2 });
    expect((await run(13)).stats).toMatchObject({ judged: 2, deferred: 0 });
    const last = await run(13);
    expect(last.stats).toMatchObject({ judged: 0, deferred: 0 });
    expect(last.calls).toEqual([]);
    expect(last.lines).toEqual([]);
    expect(shown).toHaveLength(28);
    expect(new Set(shown)).toEqual(new Set(everyPair(Array.from({ length: 8 }, (_, i) => statement(i)), pairLabel).map((p) => p.id)));
  });

  it('sends the most promising pairs first', async () => {
    const { store } = ctx;
    const same = ['丁公司计划扩大海外产能', '丁公司打算扩充在海外的生产能力'];
    const close = ['丁公司今年将新开十家门店', '丁公司年内准备开设十家新店'];
    const negated = ['丁公司会提高分红比例', '丁公司不会提高分红比例'];
    const numbers = ['丁公司毛利率为30%，净利率为12%', '丁公司销售费用率30%，研发费用率12%', '丁公司海外收入占比30%', '丁公司员工持股比例12%'];
    write(dataDir, 'raw/docs/ding.md', claimsDoc('丁公司', [...same, ...negated, numbers[0], numbers[1]]));
    await sync(ctx, { llmGraph: false });
    // newer, so the newest-claim rule would take these first if similarity and shared numbers did not come before it
    write(dataDir, 'raw/docs/ding-later.md', claimsDoc('丁公司', [...close, numbers[2], numbers[3]]));
    await sync(ctx, { llmGraph: false });
    const focus = (await store.query<{ id: string }>(`SELECT id FROM claims WHERE subject_id = '丁公司' AND tx_to IS NULL`)).map((r) => r.id);
    expect(focus).toHaveLength(10);

    // cosine 1 for the first and the negated pair, 0.9 for the second. Of the claims that share a number, the first has
    // cosine 0.82 with the fourth and 0.8 with the second and third; the second has less than 0.7 with the third and fourth
    const vectors = new Map<string, number[]>([
      [same[0], vector(0)], [same[1], vector(0)],
      [close[0], vector(1)], [close[1], vector(1, 0.9, 2)],
      [negated[0], vector(3)], [negated[1], vector(3)],
      [numbers[0], vector(4)], [numbers[1], vector(4, 0.8, 5)], [numbers[2], vector(4, 0.8, 6)], [numbers[3], vector(4, 0.82, 7)],
    ]);
    const embedder: EmbeddingProvider = { model: 'test-vectors', dimensions: store.embeddingDim, embed: async (texts) => texts.map((t) => vectors.get(t.slice(t.indexOf('：') + 1))!) };
    const config = realVectors();

    const shown: string[] = [];
    const all = await auditDuplicateClaims({ store, embedder, config, llm: recordingJudge(shown) }, { focus });
    expect(all).toMatchObject({ embedded: 10, candidates: 6, deferred: 0 });
    // alike in meaning before sharing a number; free to merge before guarded (the negation); closer; among the pairs that
    // only share a number, the higher cosine, then more numbers in common before the newer claim. The second claim's
    // pairs with the third and fourth share a number but stay under cosine 0.7, so they never come up.
    expect(shown).toEqual([
      pairLabel(same[0], same[1]), pairLabel(close[0], close[1]), pairLabel(negated[0], negated[1]),
      pairLabel(numbers[0], numbers[3]), pairLabel(numbers[0], numbers[1]), pairLabel(numbers[0], numbers[2]),
    ]);

    // the stub remembered nothing, so a limited run starts from the same pairs
    const firstTwo: string[] = [];
    const limitedRun = await auditDuplicateClaims({ store, embedder, config: { ...config, review: { ...config.review, claimMergeMaxJudgedPerRun: 2 } }, llm: recordingJudge(firstTwo) }, { focus });
    expect(limitedRun).toMatchObject({ candidates: 6, deferred: 4 });
    expect(firstTwo).toEqual(shown.slice(0, 2));
  });

  it('brings up a pair that only shares a number once both claims have vectors', async () => {
    const { store } = ctx;
    const twins = ['戊公司2025年营收120亿元', '戊公司全年收入达到120亿元'];
    write(dataDir, 'raw/docs/wu.md', claimsDoc('戊公司', twins));
    await sync(ctx, { llmGraph: false });
    const focus = (await store.query<{ id: string }>(`SELECT id FROM claims WHERE subject_id = '戊公司' AND tx_to IS NULL`)).map((r) => r.id);
    expect(focus).toHaveLength(2);
    const run = async (embedder: EmbeddingProvider, config: AppContext['config']) => {
      const shown: string[] = [];
      const lines: string[] = [];
      const stats = await auditDuplicateClaims({ store, embedder, config, llm: recordingJudge(shown) }, { focus, onProgress: (m) => lines.push(m) });
      return { stats, shown, lines };
    };

    // without real vectors the shared figure is enough
    const local = await run(ctx.embedder, ctx.config);
    expect(local.stats).toMatchObject({ candidates: 1 });
    expect(local.shown).toEqual([pairLabel(twins[0], twins[1])]);

    // with them it needs cosine 0.7 as well (these have 0.8), so while the embedding pool is out the pair waits
    let out = true;
    const embedder: EmbeddingProvider = {
      model: 'test-vectors',
      dimensions: store.embeddingDim,
      embed: async (texts) => {
        if (out) throw new Error('daily quota reached');
        return texts.map((t) => (t.includes('营收') ? vector(8) : vector(8, 0.8, 9)));
      },
    };
    const waiting = await run(embedder, realVectors());
    expect(waiting.lines).toContain('claims: embedding batch failed: daily quota reached');
    expect(waiting.stats).toMatchObject({ embedded: 0, candidates: 0 });
    expect(waiting.shown).toEqual([]);

    out = false;
    const later = await run(embedder, realVectors());
    expect(later.stats).toMatchObject({ embedded: 2, candidates: 1 });
    expect(later.shown).toEqual([pairLabel(twins[0], twins[1])]);
  });
});

describe('the duplicate-entity audit at scale', () => {
  const dataDir = path.join(tmp, 'entities');
  let ctx: AppContext;

  beforeAll(async () => {
    initDataDir(dataDir);
    ctx = await createContext(dataDir);
  });
  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
  });

  it('looks up the decided pairs among more candidates than one statement can bind', async () => {
    const { store } = ctx;
    // one bare name for all of them: each of the n(n-1)/2 pairs is a candidate
    const n = 370;
    await store.query(
      `INSERT INTO entities (id, name, type, name_key)
       SELECT 'dup-' || g, '重复公司' || g, 'organization', '重复公司' FROM generate_series(1, $1::int) AS g`,
      [n],
    );
    const all = everyPair(Array.from({ length: n }, (_, i) => `dup-${i + 1}`), mergeSuggestionId);
    expect(all.length).toBeGreaterThan(MAX_PARAMS);

    // a person already rejected every pair but two
    const open = new Set([mergeSuggestionId('dup-1', 'dup-2'), mergeSuggestionId('dup-3', 'dup-4')]);
    await store.query(
      `INSERT INTO suggestions (id, kind, title, body, status)
       SELECT id, 'merge', '合并重复实体', '', 'rejected' FROM unnest($1::text[]) AS id`,
      [all.filter((p) => !open.has(p.id)).map((p) => p.id)],
    );

    const stats = await auditDuplicateEntities({ store, embedder: ctx.embedder, config: ctx.config });
    expect(stats).toMatchObject({ candidates: all.length, suggested: 2 });
    const pending = await store.query<{ id: string }>(`SELECT id FROM suggestions WHERE kind = 'merge' AND status = 'pending'`);
    expect(new Set(pending.map((r) => r.id))).toEqual(open);
  });
});
