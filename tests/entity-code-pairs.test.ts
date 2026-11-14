import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { auditDuplicateEntities, codesApartByDigits } from '../src/graph/dedupe.js';
import { LlmClient } from '../src/llm/client.js';

/**
 * Entity pairs a rule settles before the judge (src/graph/dedupe.ts codesApartByDigits).
 * The pairs below are from the 10× and 1× reports benchmark builds (2026-11-14): the
 * judge rejected 551 of its 582 pairs at 10×, 441 of them code pairs this rule rejects
 * without a call; the pairs it called the same are left to it, every one.
 */

const e = (name: string, aliases: string[] = []) => ({ name, aliases });

describe('code-like names that differ only in their numbers', () => {
  it('are two things: incident, risk and ticket codes', () => {
    for (const [a, b] of [
      ['INC-012-D6T2', 'INC-013-D6T2'],
      ['INC-021-T3', 'INC-017-T3'],
      ['INC-004-D6T1', 'INC-006-D4T1'],
      ['INC-001-D2T1', 'INC-001-D7T1'],
      ['R-76', 'R-67'],
      ['D4T3-C2', 'D4T3-C3'],
      ['T1-1124', 'T1-1123'],
      ['inc-012', 'INC-021'],
    ]) expect(codesApartByDigits(e(a), e(b)), `${a} / ${b}`).toBe(true);
  });

  it('leaves alone every pair the benchmark judge called the same, and names that are not codes', () => {
    for (const [a, b] of [
      // judged the same at 10× and 1×: a division prefix more is more than a number
      ['INC-007-D2T1', 'INC-007-T1'],
      ['INC-007-D8T1', 'INC-007-T1'],
      ['D4T3-C2', '新人礼包金额'],
      ['T2-C3', '风控拦截分数线'],
      ['Orion', 'Atlas'],
      ['风控引擎', '天秤'],
      ['INC-015-D7T3', '推送重复事故'],
      // not codes, or one number written two ways
      ['平台组周报 · 第25周', '平台组周报 · 第26周'],
      ['天权中心', '天权中心2'],
      ['INC-012', 'INC-12'],
      ['Windows 10', 'Windows 11'],
      ['GPT-4', 'GPT-4o'],
      ['2024', '2025'],
    ]) expect(codesApartByDigits(e(a), e(b)), `${a} / ${b}`).toBe(false);
    // a name the other lists as an alias is the other signals' to weigh
    expect(codesApartByDigits(e('INC-012', ['INC-021']), e('INC-021'))).toBe(false);
  });
});

describe('the duplicate-entity audit', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-entity-codes-'));
  const dataDir = path.join(tmp, 'ws');
  let ctx: AppContext;
  beforeAll(async () => {
    initDataDir(dataDir);
    ctx = await createContext(dataDir);
  });
  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('does not ask the judge about two numbers of one code', async () => {
    const { store } = ctx;
    // incidents a report names by their description too: each pair shares that alias
    const rows: [string, string, string][] = [
      ['inc-012-t1', 'INC-012-T1', '缓存击穿'],
      ['inc-021-t1', 'INC-021-T1', '缓存击穿'],
      ['inc-007-d2t1', 'INC-007-D2T1', '登录失败'],
      ['inc-007-t1', 'INC-007-T1', '登录失败'],
    ];
    for (const [id, name, alias] of rows) {
      await store.query(`INSERT INTO entities (id, name, type, name_key, aliases) VALUES ($1, $2, 'event', $1, $3::jsonb)`, [id, name, JSON.stringify([alias])]);
      await store.query(`INSERT INTO entity_alias_keys (entity_id, alias_key, kind) VALUES ($1, $2, 'exact')`, [id, alias]);
    }
    const shown: string[] = [];
    const complete = async (messages: { role: string; content: string }[]) => {
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      shown.push([...user.matchAll(/^Entity [AB]: (\S+)/gm)].map((m) => m[1]).sort().join(' | '));
      return JSON.stringify({ same: false, confidence: 0.99, reason: '编号不同' });
    };
    const llm = { enabled: true, label: 'stub', provider: 'openai', model: 'stub', complete } as unknown as LlmClient;
    const config = { ...ctx.config, review: { ...ctx.config.review, llmJudge: 'suggest' as const } };
    const stats = await auditDuplicateEntities({ store, embedder: ctx.embedder, config, llm });
    expect(stats.codesApart).toBe(1);
    expect(shown).toEqual(['INC-007-D2T1 | INC-007-T1']);
    expect(stats.judged).toBe(1);
  });
});
