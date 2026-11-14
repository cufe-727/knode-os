import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { auditDuplicateClaims, claimSubjectBatches, ClaimRelation } from '../src/graph/claim-dedupe.js';
import { supersedeByAttribute } from '../src/graph/claim-state-store.js';
import { packSubjectBatches } from '../src/graph/subject-batches.js';
import { LlmClient } from '../src/llm/client.js';
import { Store } from '../src/store/db.js';
import { auditClaims, markSupersededClaims } from '../src/wiki/refine.js';

/**
 * What the nightly tier-2 pass and the review after extraction hold in memory.
 * Both used to read every live claim into one array — the duplicate-claim audit
 * (also for a review of a few hundred claims), the claim audit, supersession —
 * and the duplicate-claim audit kept its array while the judge answered. On
 * finance (2026-11-13: 1,105,684 claims) one such array is about 1 GB of heap;
 * the review held one, the nightly pass started beside it, and the server died
 * at its 4 GB heap limit. Now each reads whole subjects a batch at a time, or
 * lets the database count: these tests hold them to that by the rows a single
 * query brings back, and to the same results as one batch gives.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-tier2-memory-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The most rows any one query has brought back since `watch` was called. */
function watchRows(store: Store): { max: () => number; stop: () => void } {
  const original = store.query.bind(store);
  let max = 0;
  (store as unknown as { query: unknown }).query = async (sql: string, params?: unknown[]) => {
    const rows = await original(sql, params);
    max = Math.max(max, (rows as unknown[]).length);
    return rows;
  };
  return { max: () => max, stop: () => { (store as unknown as { query: unknown }).query = original; } };
}

const pairLabel = (a: string, b: string) => [a, b].sort().join(' | ');

/** A judge that records the pairs it was shown and answers `relation` for each. */
function recordingJudge(shown: string[], relation: ClaimRelation): LlmClient {
  const complete = async (messages: { role: string; content: string }[]) => {
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    const pairs = [...user.matchAll(/Pair \d+ — subject: [^\n]*\nA: "([^"]*)"[\s\S]*?\nB: "([^"]*)"/g)].map((m) => pairLabel(m[1], m[2]));
    shown.push(...pairs);
    return JSON.stringify({ verdicts: pairs.map((_, i) => ({ pair: i + 1, relation, confidence: 0.3, reason: '测试' })) });
  };
  return { enabled: true, label: 'stub', provider: 'openai', model: 'stub', complete } as unknown as LlmClient;
}

describe('packing subjects into batches', () => {
  it('keeps a canonical subject whole, in id order, and gives a large one a batch alone', () => {
    const batches = packSubjectBatches(
      [
        { subject_id: 'c', subject: 'c', n: 2 },
        { subject_id: 'a', subject: 'a', n: 3 },
        { subject_id: 'a-old', subject: 'a', n: 1 },
        { subject_id: 'b', subject: 'b', n: 9 },
        { subject_id: 'd', subject: 'd', n: 2 },
      ],
      5,
    );
    expect(batches.map((b) => [[...b.subjects], b.subjectIds, b.claims])).toEqual([
      [['a'], ['a', 'a-old'], 4],
      [['b'], ['b'], 9],
      [['c', 'd'], ['c', 'd'], 4],
    ]);
    expect(packSubjectBatches([], 5)).toEqual([]);
  });
});

describe('the duplicate-claim audit a batch of subjects at a time', () => {
  const subjects = 30;
  const perSubject = 42;
  const name = (i: number) => `甲${String.fromCodePoint(0x6000 + i)}公司`;
  let unique = 0;
  // three characters no other statement has: it shares only its subject's bigrams with another
  const own = () => {
    const i = unique++;
    return String.fromCodePoint(...[0, 1, 2].map((k) => 0x4e00 + 3 * i + k));
  };

  /** The same workspace each time: per subject two wordings of one plan, two claims that share only a figure, and filler. */
  async function seed(dir: string): Promise<AppContext> {
    unique = 0;
    const ctx = await createContext(path.join(tmp, dir));
    const { store } = ctx;
    await store.query(`INSERT INTO entities (id, name, type, name_key) SELECT k, k, 'organization', k FROM unnest($1::text[]) AS k`, [Array.from({ length: subjects }, (_, i) => name(i))]);
    const rows: { subject: string; object: string | null; statement: string }[] = [];
    for (let i = 0; i < subjects; i++) {
      const s = name(i);
      rows.push({ subject: s, object: null, statement: `${s}计划回购股份。` }, { subject: s, object: null, statement: `${s} 计划回购股份` });
      rows.push({ subject: s, object: null, statement: `${own()}收入增长20%` }, { subject: s, object: null, statement: `${own()}利润增长20%` });
      for (let k = 4; k < perSubject; k++) rows.push({ subject: s, object: null, statement: `${s}${own()}` });
    }
    // one agreement told from both sides: each claim is in the other's swapped group, and in another batch
    rows.push({ subject: name(0), object: name(subjects - 1), statement: '双方签署合作协议。' }, { subject: name(subjects - 1), object: name(0), statement: '双方 签署合作协议' });
    await store.query(
      `INSERT INTO claims (id, subject_id, object_id, statement, evidence_count)
       SELECT 'claim-' || lpad(i::text, 5, '0'), s, o, t, 1 FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY AS x(s, o, t, i)`,
      [rows.map((r) => r.subject), rows.map((r) => r.object), rows.map((r) => r.statement)],
    );
    return ctx;
  }
  const contexts: AppContext[] = [];
  const open = async (dir: string) => {
    const ctx = await seed(dir);
    contexts.push(ctx);
    return ctx;
  };
  afterAll(async () => {
    for (const ctx of contexts) {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });

  const total = subjects * perSubject + 2;
  const merges = async (store: Store) =>
    (await store.query<{ statement: string; canonical: string }>(`SELECT c.statement, r.statement AS canonical FROM claims c JOIN claims r ON r.id = c.canonical_id`))
      .map((r) => pairLabel(r.statement, r.canonical)).sort();

  it('finds what one batch finds, and never reads more than a batch', async () => {
    const limited = (ctx: AppContext) => ({ ...ctx.config, review: { ...ctx.config.review, claimMergeMaxJudgedPerRun: 7 } });
    const whole = await open('whole');
    const shownWhole: string[] = [];
    const one = await auditDuplicateClaims({ store: whole.store, embedder: whole.embedder, config: limited(whole), llm: recordingJudge(shownWhole, 'unrelated') });
    // per subject the two wordings merge and the shared figure waits for the judge; the agreement merges across subjects, once
    expect(one).toMatchObject({ candidates: 2 * subjects + 1, identical: subjects + 1, merged: subjects + 1, judged: 7, deferred: subjects - 7 });

    const batched = await open('batched');
    expect((await claimSubjectBatches(batched.store, { size: 45 })).map((b) => b.claims)).toEqual([43, ...Array.from({ length: subjects - 2 }, () => 42), 43]);
    const shown: string[] = [];
    const rows = watchRows(batched.store);
    const many = await auditDuplicateClaims({ store: batched.store, embedder: batched.embedder, config: limited(batched), llm: recordingJudge(shown, 'unrelated') }, { claimsPerBatch: 45 });
    rows.stop();
    expect(many).toEqual(one);
    expect(shown.sort()).toEqual(shownWhole.sort());
    expect(await merges(batched.store)).toEqual(await merges(whole.store));
    expect(await merges(batched.store)).toContain(pairLabel('双方签署合作协议。', '双方 签署合作协议'));
    // 1,262 claims in all: a query brings back a batch (and the one mirrored claim), never the table
    expect(total).toBe(1262);
    expect(rows.max()).toBeLessThanOrEqual(45);
  });

  it('counts a pair left for the judge once, however many batches bring it up', async () => {
    // three subjects whose claims all share one figure: over a thousand pairs each that only the judge can settle
    // (more than a run keeps between batches), and one pair across two subjects, which both their batches bring up
    const seedShared = async (dir: string): Promise<AppContext> => {
      unique = 0;
      const ctx = await createContext(path.join(tmp, dir));
      contexts.push(ctx);
      const names = [name(0), name(1), name(2)];
      await ctx.store.query(`INSERT INTO entities (id, name, type, name_key) SELECT k, k, 'organization', k FROM unnest($1::text[]) AS k`, [names]);
      const rows: { subject: string; object: string | null; statement: string }[] = [];
      for (const s of names) for (let k = 0; k < 46; k++) rows.push({ subject: s, object: null, statement: `${own()}增长20%` });
      rows.push({ subject: names[0], object: names[2], statement: `${own()}增长20%` }, { subject: names[2], object: names[0], statement: `${own()}增长20%` });
      await ctx.store.query(
        `INSERT INTO claims (id, subject_id, object_id, statement, evidence_count)
         SELECT 'claim-' || lpad(i::text, 5, '0'), s, o, t, 1 FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY AS x(s, o, t, i)`,
        [rows.map((r) => r.subject), rows.map((r) => r.object), rows.map((r) => r.statement)],
      );
      return ctx;
    };
    const pairsOf = (n: number) => (n * (n - 1)) / 2;
    const all = pairsOf(47) + pairsOf(46) + pairsOf(47) + 1;
    const limited = (ctx: AppContext) => ({ ...ctx.config, review: { ...ctx.config.review, claimMergeMaxJudgedPerRun: 7 } });
    const run = async (dir: string, claimsPerBatch?: number) => {
      const ctx = await seedShared(dir);
      const shown: string[] = [];
      const stats = await auditDuplicateClaims({ store: ctx.store, embedder: ctx.embedder, config: limited(ctx), llm: recordingJudge(shown, 'unrelated') }, { claimsPerBatch });
      return { stats, shown: shown.sort() };
    };
    const whole = await run('shared-whole');
    expect(whole.stats).toMatchObject({ candidates: all, judged: 7, deferred: all - 7 });
    const batched = await run('shared-batched', 50);
    expect(batched.stats).toEqual(whole.stats);
    expect(batched.shown).toEqual(whole.shown);
  });

  it('reads only the subjects of the claims in focus for a review after extraction', async () => {
    const ctx = await open('focus');
    const [{ id }] = await ctx.store.query<{ id: string }>(`SELECT id FROM claims WHERE subject_id = $1 AND statement LIKE '%收入增长20\\%'`, [name(5)]);
    const shown: string[] = [];
    const rows = watchRows(ctx.store);
    const stats = await auditDuplicateClaims({ store: ctx.store, embedder: ctx.embedder, config: ctx.config, llm: recordingJudge(shown, 'unrelated') }, { focus: [id] });
    rows.stop();
    expect(stats).toMatchObject({ candidates: 1, judged: 1, merged: 0 });
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatch(/收入增长20%.*利润增长20%|利润增长20%.*收入增长20%/);
    // its subject's 42 claims, not all 1,262
    expect(rows.max()).toBeLessThanOrEqual(perSubject);
    // a claim in focus that is gone is no subject at all
    expect(await claimSubjectBatches(ctx.store, { focus: ['no-such-claim'] })).toEqual([]);
    expect(await auditDuplicateClaims({ store: ctx.store, embedder: ctx.embedder, config: ctx.config }, { focus: ['no-such-claim'] })).toMatchObject({ candidates: 0 });
  });
});

describe('the claim audit without reading every claim', () => {
  let ctx: AppContext;
  const lines: string[] = [];
  beforeAll(async () => {
    ctx = await createContext(path.join(tmp, 'audit'));
    await ctx.store.query(`INSERT INTO entities (id, name, type, name_key) SELECT k, k, 'organization', k FROM unnest($1::text[]) AS k`, [['丙公司', '丁公司', '戊公司', '己公司']]);
  });
  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
  });
  const titles = async () => (await ctx.store.query<{ title: string }>(`SELECT title FROM suggestions WHERE kind = 'knowledge' ORDER BY title`)).map((r) => r.title);

  it('counts every finding in the database and reads only the twenty it files', async () => {
    const { store } = ctx;
    // 30 facts of 丙公司 whose window closed, and one forecast that is no stale fact
    await store.query(
      `INSERT INTO claims (id, subject_id, statement, evidence_count, valid_from, valid_to, kind)
       SELECT 'old-' || lpad(i::text, 2, '0'), '丙公司', '丙公司第' || i || '期债券存续', 1, '2019-01-01', '2020-01-01', CASE WHEN i = 31 THEN 'prediction' ELSE 'fact' END
       FROM generate_series(1, 31) AS i`,
    );
    // 丁公司: one fact and one disputed claim of the same type and (no) object
    await store.query(
      `INSERT INTO claims (id, subject_id, statement, evidence_count, status, primary_scope_id) VALUES
       ('clash-a', '丁公司', '丁公司已完成对目标公司的收购', 1, 'fact', 'scope-1'),
       ('clash-b', '丁公司', '丁公司已完成对目标公司的收购。', 1, 'disputed', 'scope-2')`,
    );
    const rows = watchRows(store);
    expect(await auditClaims(store, (m) => lines.push(m), { nearDuplicates: false })).toBe(31);
    rows.stop();
    expect(lines).toContain('claim audit: 31 issues queued as suggestions');
    // twenty filed, the oldest claims first: all of them expired facts
    const filed = await titles();
    expect(filed).toHaveLength(20);
    expect(new Set(filed)).toEqual(new Set(['断言可能已过期: 丙公司']));
    expect(rows.max()).toBeLessThanOrEqual(20);
    // the same findings the next night: nothing new is filed
    expect(await auditClaims(store, () => {}, { nearDuplicates: false })).toBe(31);
    expect(await titles()).toHaveLength(20);
  });

  it('files a contradiction once the expired facts leave room, and near-duplicates a page of claims at a time', async () => {
    const { store } = ctx;
    await store.query(`DELETE FROM suggestions`);
    await store.query(`DELETE FROM claims WHERE id > 'old-03' AND id LIKE 'old-%'`);
    // 戊公司: one plan in two wordings from two documents, its other claims between them in id order;
    // 己公司: twenty claims that are alike with nothing. Seven claims a page: 戊公司 spans pages.
    await store.query(
      `INSERT INTO claims (id, subject_id, statement, evidence_count, primary_scope_id) VALUES
       ('wu-00', '戊公司', '戊公司今年将在华东新开十家直营门店', 1, 'scope-1'),
       ('wu-99', '戊公司', '戊公司今年将在华东新开十家直营门店。', 1, 'scope-2')`,
    );
    const own = (i: number) => String.fromCodePoint(...[0, 1, 2].map((k) => 0x5200 + 3 * i + k));
    await store.query(
      `INSERT INTO claims (id, subject_id, statement, evidence_count, primary_scope_id)
       SELECT 'wu-' || lpad(i::text, 2, '0'), '戊公司', t, 1, 'scope-' || i FROM unnest($1::text[]) WITH ORDINALITY AS x(t, i)`,
      [Array.from({ length: 10 }, (_, i) => `戊公司${own(i)}`)],
    );
    await store.query(
      `INSERT INTO claims (id, subject_id, statement, evidence_count, primary_scope_id)
       SELECT 'ji-' || lpad(i::text, 2, '0'), '己公司', t, 1, 'scope-' || i FROM unnest($1::text[]) WITH ORDINALITY AS x(t, i)`,
      [Array.from({ length: 20 }, (_, i) => `己公司${own(100 + i)}`)],
    );
    const rows = watchRows(store);
    // 3 expired, the clash of 丁公司 (whose two wordings are not also a near-duplicate), the plan of 戊公司
    expect(await auditClaims(store, () => {}, { nearDuplicates: true, pageSize: 7 })).toBe(5);
    rows.stop();
    expect(await titles()).toEqual(['多来源相似断言待核对: 戊公司', '断言可能已过期: 丙公司', '断言可能已过期: 丙公司', '断言可能已过期: 丙公司', '检测到矛盾的断言: 丁公司'].sort());
    expect(rows.max()).toBeLessThanOrEqual(7);
    // without the near-duplicate check (duplicate-claim merging on) the plan is the judge's
    await store.query(`DELETE FROM suggestions`);
    expect(await auditClaims(store, () => {}, { nearDuplicates: false })).toBe(4);
    expect(await titles()).not.toContain('多来源相似断言待核对: 戊公司');
  });
});

describe('supersession without reading every series', () => {
  let ctx: AppContext;
  beforeAll(async () => {
    ctx = await createContext(path.join(tmp, 'supersession'));
    await ctx.store.query(
      `INSERT INTO entities (id, name, type, name_key, canonical_id) SELECT k, k, 'project', k, CASE WHEN k = '项目F旧名' THEN '项目F' END FROM unnest($1::text[]) AS k`,
      [['项目A', '项目B', '项目C', '项目D', '项目E', '项目F', '项目F旧名', '宁德时代', '时代上汽', '时代吉利']],
    );
  });
  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
  });
  const marks = async (like: string) =>
    Object.fromEntries((await ctx.store.query<{ id: string; superseded_by: string | null }>(`SELECT id, superseded_by FROM claims WHERE id LIKE $1 ORDER BY id`, [like])).map((r) => [r.id, r.superseded_by]));

  it('marks an attribute series a batch of subjects at a time, a renamed subject with its new name', async () => {
    const { store } = ctx;
    // 完成度 of each project on four days; 项目F's first two reports are under its old name
    await store.query(
      `INSERT INTO claims (id, subject_id, statement, evidence_count, attribute, value_num, unit, effective_at, state_v)
       SELECT 'p-' || p || '-' || d, CASE WHEN p = 'F' AND d <= 2 THEN '项目F旧名' ELSE '项目' || p END, '项目' || p || '完成度' || (d * 20) || '%', 1,
              '完成度', d * 20, '%', ('2026-03-0' || d)::timestamptz, 1
       FROM unnest($1::text[]) AS p, generate_series(1, 4) AS d`,
      [['A', 'B', 'C', 'D', 'E', 'F']],
    );
    const rows = watchRows(store);
    expect(await supersedeByAttribute(store, { claimsPerBatch: 5 })).toBe(18);
    rows.stop();
    for (const p of ['A', 'B', 'C', 'D', 'E', 'F']) {
      expect(await marks(`p-${p}-%`)).toEqual({ [`p-${p}-1`]: `p-${p}-2`, [`p-${p}-2`]: `p-${p}-3`, [`p-${p}-3`]: `p-${p}-4`, [`p-${p}-4`]: null });
    }
    // 24 claims with an attribute: a batch holds one project's four (seven entity rows list the subjects)
    expect(rows.max()).toBeLessThanOrEqual(7);
    expect(await supersedeByAttribute(store, { claimsPerBatch: 5 })).toBe(0);
    expect(await supersedeByAttribute(store)).toBe(0);
  });

  it('marks the measure-like types without an attribute in the database, each claim by the next of its series', async () => {
    const { store } = ctx;
    await store.query(
      `INSERT INTO claims (id, subject_id, object_id, type, statement, evidence_count, valid_from, valid_to, tx_from) VALUES
       ('h-1', '宁德时代', '时代上汽', 'holding', '持有时代上汽 49% 股权', 1, '2017-01-01', NULL, '2026-01-01'),
       ('h-2', '宁德时代', '时代上汽', 'holding', '持有时代上汽 51% 股权', 1, '2019-01-01', '2024-03-01', '2026-01-01'),
       ('h-3', '宁德时代', '时代上汽', 'holding', '持有时代上汽 70% 股权', 1, '2024-03-01', NULL, '2026-01-01'),
       -- another holding: a series of its own, whose older window still covers the newer start
       ('g-1', '宁德时代', '时代吉利', 'holding', '持有时代吉利 49% 股权', 1, '2020-01-01', '2030-01-01', '2026-01-01'),
       ('g-2', '宁德时代', '时代吉利', 'holding', '持有时代吉利 51% 股权', 1, '2024-01-01', NULL, '2026-01-01'),
       -- no object: two statements from one day replace neither, a later one replaces the one folded last
       ('n-1', '宁德时代', NULL, 'earnings', '2025 年营收 3000 亿元', 1, '2025-01-01', NULL, '2026-01-01'),
       ('n-2', '宁德时代', NULL, 'earnings', '2025 年营业收入 3000 亿元', 1, '2025-01-01', NULL, '2026-01-02'),
       ('n-3', '宁德时代', NULL, 'earnings', '2026 年营收 4000 亿元', 1, '2026-01-01', NULL, '2026-01-03'),
       -- a management fact is never replaced by a later one
       ('m-1', '宁德时代', NULL, 'management', '曾毓群担任董事长', 1, '2011-01-01', NULL, '2026-01-01'),
       ('m-2', '宁德时代', NULL, 'management', '李平担任副董事长', 1, '2015-01-01', NULL, '2026-01-01')`,
    );
    expect(await markSupersededClaims(store)).toBe(3);
    expect(await marks('h-%')).toEqual({ 'h-1': 'h-2', 'h-2': 'h-3', 'h-3': null });
    expect(await marks('g-%')).toEqual({ 'g-1': null, 'g-2': null });
    expect(await marks('n-%')).toEqual({ 'n-1': null, 'n-2': 'n-3', 'n-3': null });
    expect(await marks('m-%')).toEqual({ 'm-1': null, 'm-2': null });
    expect(await markSupersededClaims(store)).toBe(0);
    // a mark whose superseder is gone is cleared
    await store.query(`UPDATE claims SET tx_to = now() WHERE id = 'h-3'`);
    expect(await markSupersededClaims(store)).toBe(1);
    expect(await marks('h-%')).toEqual({ 'h-1': 'h-2', 'h-2': null, 'h-3': null });
  });
});
