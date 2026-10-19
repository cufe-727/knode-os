import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { auditDuplicateClaims, claimPairId } from '../src/graph/claim-dedupe.js';
import { auditDuplicateEntities, mergeSuggestionId } from '../src/graph/dedupe.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { sync } from '../src/ingest/sync.js';
import { LlmClient } from '../src/llm/client.js';
import { sourcesOf } from '../src/store/claims.js';

/**
 * The duplicate audits at the sizes a real workspace reaches: a nightly run
 * over every claim (or entity) brings up more candidate pairs than one
 * statement can bind (Postgres and PGlite both stop at 65,535 parameters), so
 * id lists go to the database as one array parameter.
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

/** A judge that answers nothing and records the pairs it was shown. */
function recordingJudge(shown: string[]): LlmClient {
  const completeJson = async (messages: { role: string; content: string }[]) => {
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    for (const m of user.matchAll(/Pair \d+ — subject: [^\n]*\nA: "([^"]*)"[\s\S]*?\nB: "([^"]*)"/g)) shown.push(pairLabel(m[1], m[2]));
    return { verdicts: [] };
  };
  return { enabled: true, label: 'stub', provider: 'openai', model: 'stub', completeJson } as unknown as LlmClient;
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
