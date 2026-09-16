import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { applySuggestion } from '../src/pack/learn.js';
import { listJobs } from '../src/research/jobs.js';
import { autoAcceptRecommendations, recommendWikiTopics, refreshRecommendations } from '../src/research/recommend.js';
import { listSuggestions, setSuggestionStatus } from '../src/store/queries.js';

/**
 * Recommendations: hot / demanded entities without a page, research pages
 * older than the newest evidence about their subject, recurring questions —
 * filed as wiki suggestions that accept into research jobs.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-recommend-'));
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

describe('wiki recommendations', () => {
  it('ranks entities agents ask about, stale research pages and recurring questions, and accepts into jobs', async () => {
    const dataDir = path.join(tmp, 'ws');
    for (let i = 0; i < 3; i++) {
      write(dataDir, `raw/docs/catl-${i}.md`, `---
title: 宁德时代资料 ${i}
entities:
  - { name: 宁德时代, type: organization, aliases: ["CATL"] }
  - { name: 比亚迪, type: organization }
claims:
  - { subject: 宁德时代, type: revenue, statement: 第 ${i} 份资料的营收数字, eventDate: "2026-0${i + 1}" }
---
宁德时代与比亚迪是动力电池行业的主要厂商（资料 ${i}）。
`);
    }
    // a research page about 比亚迪 written "yesterday" by an agent
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    write(dataDir, 'wiki/entities/比亚迪.md', `---
type: organization
title: 比亚迪
aliases: [BYD]
sources: [raw/docs/catl-0.md]
actor: agent/claude-cli
research: { job: r_old, kind: entity, template: entity, at: "${yesterday}", agent: claude-cli }
---
# 比亚迪

## 概要

比亚迪是新能源汽车与电池厂商（来源：raw/docs/catl-0.md）。
`);
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });

    // demand: agents resolved 宁德时代 three times and asked one question twice
    for (let i = 0; i < 3; i++) {
      await ctx.store.query(
        `INSERT INTO receipts (id, kind, query, entities, gaps) VALUES ($1, 'resolve', $2, $3::jsonb, $4::jsonb)`,
        [`rc_${i}`, i < 2 ? '宁德时代的上游供应商有哪些' : '宁德时代最新营收', JSON.stringify(['宁德时代']), JSON.stringify(i === 0 ? ['no supplier data'] : [])],
      );
    }
    // new evidence about 比亚迪 after its page was written
    write(dataDir, 'raw/docs/byd-new.md', `---
title: 比亚迪新消息
entities:
  - { name: 比亚迪, type: organization }
claims:
  - { subject: 比亚迪, type: sales, statement: 2026 年 8 月销量创新高, eventDate: "2026-08" }
---
比亚迪 2026 年 8 月销量创新高。
`);
    await sync(ctx, { llmGraph: false });

    const recs = await recommendWikiTopics(ctx);
    const catl = recs.find((r) => r.kind === 'entity' && r.target === '宁德时代');
    expect(catl).toBeDefined();
    expect(catl!.reasons.join(' ')).toMatch(/被 agent 问到 3 次/);
    expect(catl!.reasons.join(' ')).toMatch(/还没有页面/);
    const refresh = recs.find((r) => r.kind === 'refresh');
    expect(refresh?.target).toBe('wiki/entities/比亚迪.md');
    expect(refresh!.reasons.join(' ')).toMatch(/之后有新证据/);
    const question = recs.find((r) => r.kind === 'question');
    expect(question?.target).toBe('宁德时代的上游供应商有哪些');
    expect(question!.reasons.join(' ')).toMatch(/2 次被问到/);
    expect(recs[0].score).toBeGreaterThanOrEqual(recs[recs.length - 1].score);

    // filed as suggestions; accepting one queues the job; the recommendation then disappears while the job is open
    const filed = await refreshRecommendations(ctx);
    expect(filed.suggested).toBeGreaterThanOrEqual(3);
    const pending = (await listSuggestions(ctx.store, { status: 'pending' })).filter((s) => s.kind === 'wiki');
    const catlSuggestion = pending.find((s) => (s.payload as { target?: string })?.target === '宁德时代')!;
    expect(catlSuggestion.payload).toMatchObject({ kind: 'entity', target: '宁德时代' });
    await setSuggestionStatus(ctx.store, catlSuggestion.id, 'accepted');
    const applied = await applySuggestion(ctx.store, dataDir, catlSuggestion.id);
    expect(applied.applied).toBe(true);
    expect(applied.job?.kind).toBe('entity');
    const jobs = await listJobs(ctx.store, { status: 'queued' });
    expect(jobs.map((j) => [j.kind, j.target ?? j.query])).toEqual([['entity', '宁德时代']]);
    expect((await recommendWikiTopics(ctx)).some((r) => r.kind === 'entity' && r.target === '宁德时代')).toBe(false);

    // auto mode accepts the best remaining pending recommendations within the daily budget
    const auto = await autoAcceptRecommendations(ctx, 2);
    expect(auto).toBe(2);
    expect((await listJobs(ctx.store, { status: 'queued' })).length).toBe(3);
    expect(await autoAcceptRecommendations(ctx, 2)).toBe(0); // budget spent for today
  });
});
