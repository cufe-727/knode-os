import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { auditDuplicateClaims } from '../src/graph/claim-dedupe.js';
import { refreshClaimState } from '../src/graph/claim-state-store.js';
import { RawExtractReply } from '../src/graph/llm-extract.js';
import { claimId } from '../src/graph/store.js';
import { enqueueTier1, runTier1Pass } from '../src/graph/tier1.js';
import { sync } from '../src/ingest/sync.js';
import { readingDay } from '../src/lineage/writer.js';
import { LlmClient } from '../src/llm/client.js';
import { markSupersededClaims } from '../src/wiki/refine.js';

/**
 * A claim's identity (src/graph/store.ts claimId, src/lineage/writer.ts readingDay):
 * one sentence a weekly report repeats about a measure is a reading per week, while a
 * restated text value stays one claim. On the 10× reports benchmark (2026-11-14) 603 of
 * 1,440 weekly metric values had folded into another week's claim.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-claim-identity-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const WEEKS = [99.92, 99.91, 99.92, 99.93];
const monday = (k: number) => new Date(Date.UTC(2025, 0, 6 + k * 7)).toISOString().slice(0, 10);
const friday = (k: number) => new Date(Date.UTC(2025, 0, 10 + k * 7)).toISOString().slice(0, 10);

function fixture(): Map<string, { text: string; reply: RawExtractReply }> {
  const out = new Map<string, { text: string; reply: RawExtractReply }>();
  WEEKS.forEach((v, k) => {
    out.set(`raw/docs/周报/平台组/w${k + 1}.md`, {
      text: `# 平台组周报 · 第${k + 2}周\n\n${monday(k)} ~ ${friday(k)}\n\n本周服务可用性为${v}%。R-70负责人为姜婷。\n`,
      reply: {
        entities: [
          { name: '平台组', type: 'organization', aliases: [] },
          { name: 'R-70', type: 'other', aliases: [] },
          { name: '姜婷', type: 'person', aliases: [] },
        ],
        relations: [],
        claims: [
          // as the benchmark's extraction gave them: the week as the window, the same words every week
          { subject: '平台组', statement: `平台组本周服务可用性为${v}%。`, type: 'other', status: 'fact', kind: 'fact', attribute: '服务可用性', value: v, unit: '%', startDate: monday(k), endDate: friday(k) },
          { subject: 'R-70', object: '姜婷', statement: 'R-70负责人为姜婷。', type: 'risk', status: 'fact', kind: 'fact', attribute: '负责人', value: '姜婷', startDate: monday(k), endDate: friday(k) },
        ],
      },
    });
  });
  return out;
}

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

/** A judge that must not be needed: it counts the pairs it is shown and calls each one the same. */
function countingJudge(count: { pairs: number }): LlmClient {
  const complete = async (messages: { role: string; content: string }[]) => {
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    const n = [...user.matchAll(/^Pair \d+ — /gm)].length;
    count.pairs += n;
    return JSON.stringify({ verdicts: Array.from({ length: n }, (_, i) => ({ pair: i + 1, relation: 'same', confidence: 0.99, reason: '测试' })) });
  };
  return { enabled: true, label: 'stub@judge', provider: 'openai', model: 'stub', complete } as unknown as LlmClient;
}

async function build(name: string): Promise<AppContext> {
  const dataDir = path.join(tmp, name);
  initDataDir(dataDir);
  const docs = fixture();
  for (const [p, d] of docs) {
    fs.mkdirSync(path.dirname(path.join(dataDir, p)), { recursive: true });
    fs.writeFileSync(path.join(dataDir, p), d.text);
  }
  const ctx = await createContext(dataDir);
  await sync(ctx, { llmGraph: false });
  for (const d of await ctx.store.query<{ id: string }>(`SELECT id FROM documents WHERE root = 'docs'`)) await enqueueTier1(ctx.store, d.id);
  (ctx.config.extraction as { entityLlm?: unknown }).entityLlm = undefined;
  const llm = stubExtractor(docs);
  for (let i = 0; i < 10; i++) if ((await runTier1Pass(ctx.store, ctx.config, llm, { batchSize: 64 })).queued === 0) break;
  return ctx;
}

describe('a claim identity', () => {
  it('carries the day of a dated reading of a number, and nothing else', () => {
    const reading = { statement: '平台组本周服务可用性为99.92%。', attribute: '服务可用性', valueNum: 99.92, dateSource: 'stated', validFrom: '2025-01-06T00:00:00.000Z' };
    expect(readingDay(reading)).toBe('2025-01-06');
    expect(readingDay({ ...reading, statement: '七部增长组两周前的周活跃用户为136万。' })).toBe('2025-01-06');
    expect(readingDay({ ...reading, eventAt: '2025-03-03T00:00:00.000Z' })).toBe('2025-03-03');
    expect(readingDay({ ...reading, valueNum: null })).toBeNull();
    expect(readingDay({ ...reading, attribute: null })).toBeNull();
    expect(readingDay({ ...reading, dateSource: 'document' })).toBeNull();
    expect(readingDay({ ...reading, validFrom: null })).toBeNull();
    // a statement that names its own time is one fact however many sources report it on other days
    for (const statement of ['2026Q2 净利润 120 亿元', '平台组2025年第24周服务可用性为99.92%', '10月月报列示四部平台组在岗人数为6人', '2025-06-16当周可用性99.92%', 'FY25 revenue was 3.2bn', '上半年营收12亿元']) {
      expect(readingDay({ ...reading, statement })).toBeNull();
    }
    // without a day the id is what it always was, so claims of existing workspaces keep theirs
    expect(claimId('平台组', 'x')).toBe(claimId('平台组', 'x', null));
    expect(claimId('平台组', 'x', '2025-01-06')).not.toBe(claimId('平台组', 'x', '2025-01-20'));
  });
});

describe('weekly readings of one measure', () => {
  const opened: AppContext[] = [];
  afterAll(async () => {
    for (const ctx of opened) {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });

  it('keep every week, a value that comes back included, and leave a restated owner one claim', async () => {
    const ctx = await build('weeks');
    opened.push(ctx);
    const readings = await ctx.store.query<{ statement: string; valid_from: Date; valid_to: Date; evidence_count: number }>(
      `SELECT statement, valid_from, valid_to, evidence_count FROM claims WHERE subject_id = '平台组' AND attribute = '服务可用性' AND tx_to IS NULL ORDER BY valid_from`,
    );
    // before: three claims, the 99.92% one spanning weeks 1 to 3 over the 99.91% of week 2
    expect(readings.map((r) => [r.statement, r.valid_from.toISOString().slice(0, 10), r.valid_to.toISOString().slice(0, 10), r.evidence_count])).toEqual(
      WEEKS.map((v, k) => [`平台组本周服务可用性为${v}%。`, monday(k), friday(k), 1]),
    );
    const owner = await ctx.store.query<{ evidence_count: number }>(`SELECT evidence_count FROM claims WHERE subject_id = 'r-70' AND tx_to IS NULL`);
    expect(owner).toEqual([{ evidence_count: WEEKS.length }]);

    // the two 99.92% weeks are worded alike; the audit settles them apart without a model and merges nothing
    const judged = { pairs: 0 };
    const stats = await auditDuplicateClaims({ store: ctx.store, embedder: ctx.embedder, config: ctx.config, llm: countingJudge(judged) });
    expect(judged.pairs).toBe(0);
    expect(stats.merged).toBe(0);
    expect(stats.identical).toBe(0);
    const [{ reason }] = await ctx.store.query<{ reason: string }>(
      `SELECT v.reason FROM claim_pair_verdicts v JOIN claims a ON a.id = v.a_id JOIN claims b ON b.id = v.b_id WHERE a.statement = b.statement`,
    );
    expect(reason).toBe('同一说法、不同时点');

    // the history holds all four weeks, the last one current
    await refreshClaimState(ctx.store);
    await markSupersededClaims(ctx.store);
    const series = await ctx.store.query<{ value_num: number; effective_at: Date; superseded_by: string | null }>(
      `SELECT value_num, effective_at, superseded_by FROM claims WHERE subject_id = '平台组' AND attribute = '服务可用性' AND tx_to IS NULL AND canonical_id IS NULL ORDER BY effective_at`,
    );
    expect(series.map((r) => [r.value_num, r.effective_at.toISOString().slice(0, 10), r.superseded_by === null])).toEqual(
      WEEKS.map((v, k) => [v, monday(k), k === WEEKS.length - 1]),
    );
  });
});
