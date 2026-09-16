import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { reviewClaims } from '../src/graph/claim-review.js';
import { auditDuplicateEntities, mergeSuggestionId } from '../src/graph/dedupe.js';
import { sync } from '../src/ingest/sync.js';
import { LlmClient } from '../src/llm/client.js';
import { applyIdentityVerdicts, networkAllowed } from '../src/research/runner.js';
import { RunWorkspace } from '../src/research/workspace.js';
import { listSuggestions } from '../src/store/queries.js';

/**
 * The review layers with a scripted LLM: write-time resolution is exact by
 * default, the duplicate audit asks the judge (suggest / auto / reject), open
 * disputes get a claim verdict, and a verify page's sameAs / notSameAs become
 * merge decisions.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-review-'));
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

/** An LLM that answers from a script keyed on what the user message mentions. */
function scriptedLlm(script: (user: string) => object): LlmClient {
  return {
    enabled: true,
    label: 'stub-llm',
    provider: 'openai',
    model: 'stub',
    async complete(messages: { role: string; content: string }[]) {
      return JSON.stringify(script(messages[messages.length - 1].content));
    },
    async completeJson(messages: { role: string; content: string }[]) {
      return script(messages[messages.length - 1].content);
    },
  } as unknown as LlmClient;
}

describe('review layers', () => {
  it('judges duplicate candidates, remembers rejections, auto-merges when allowed, reviews disputes, applies identity verdicts', async () => {
    const dataDir = path.join(tmp, 'ws');
    write(dataDir, 'raw/docs/a.md', `---
title: 腾讯控股
entities:
  - { name: 腾讯控股, type: organization, description: 港股上市的互联网公司 }
  - { name: 苹果公司, type: organization, description: 消费电子公司 }
claims:
  - { subject: 腾讯控股, type: hq, statement: 总部位于深圳 }
---
腾讯控股总部位于深圳。苹果公司发布了新手机。
`);
    write(dataDir, 'raw/docs/b.md', `---
title: 腾讯与苹果
entities:
  - { name: 腾讯, type: organization, description: 微信和游戏的运营方 }
  - { name: 苹果, type: concept, description: 一种水果 }
  - { name: 比亚迪, type: organization }
---
腾讯的游戏业务增长；苹果是一种水果；比亚迪造车。
`);
    write(dataDir, 'raw/docs/c-agent.md', `---
title: agent 笔记
actor: agent/claude-cli
entities:
  - { name: 腾讯控股, type: organization }
claims:
  - { subject: 腾讯控股, type: hq, statement: 总部位于上海 }
---
据称腾讯控股总部位于上海。
`);
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });

    // exact resolution: 腾讯 and 腾讯控股 stay separate entities (a suffix-only match is the audit's business)
    const ids = (await ctx.store.query<{ id: string }>(`SELECT id FROM entities WHERE tx_to IS NULL AND canonical_id IS NULL AND id IN ('腾讯', '腾讯控股', '苹果', '苹果公司') ORDER BY id`)).map((r) => r.id);
    expect([...ids].sort()).toEqual(['苹果', '苹果公司', '腾讯', '腾讯控股'].sort());

    // the judge: same for the Tencent pair, different for the apple pair
    const judge = scriptedLlm((user) => (/Entity [AB]: 腾讯/.test(user) ? { same: true, confidence: 0.97, reason: '腾讯是腾讯控股的简称' } : { same: false, confidence: 0.9, reason: '一个是公司，一个是水果' }));
    ctx.config.review.llmJudge = 'suggest';
    const first = await auditDuplicateEntities({ ...ctx, llm: judge }, {});
    expect(first.judged).toBe(2);
    expect(first.llmRejected).toBe(1);
    expect(first.autoMerged).toBe(0);
    const tencentId = mergeSuggestionId('腾讯', '腾讯控股');
    const appleId = mergeSuggestionId('苹果', '苹果公司');
    const all = await listSuggestions(ctx.store, {});
    expect(all.find((s) => s.id === tencentId)).toMatchObject({ status: 'pending', kind: 'merge' });
    expect((all.find((s) => s.id === tencentId)!.payload as { llm: { same: boolean } }).llm.same).toBe(true);
    expect(all.find((s) => s.id === appleId)).toMatchObject({ status: 'rejected' });

    // auto mode merges the confident pair; the rejected pair is never re-judged
    ctx.config.review.llmJudge = 'auto';
    const second = await auditDuplicateEntities({ ...ctx, llm: judge }, {});
    expect(second.autoMerged).toBe(1);
    expect(second.judged).toBe(1);
    expect(await ctx.store.query(`SELECT canonical_id FROM entities WHERE id = '腾讯'`)).toEqual([{ canonical_id: '腾讯控股' }]);
    expect((await listSuggestions(ctx.store, {})).find((s) => s.id === tencentId)?.status).toBe('accepted');

    // claim review: the quarantined note contradicts the trusted headquarters claim → a dispute → a verdict
    const disputes = await ctx.store.query<{ id: string }>(`SELECT id FROM disputes WHERE status = 'open'`);
    expect(disputes.length).toBeGreaterThanOrEqual(1);
    const reviewer = scriptedLlm(() => ({ verdict: 'b', confidence: 0.8, reason: '年报说明总部在深圳', action: 'demote_source' }));
    const reviewed = await reviewClaims({ store: ctx.store, llm: reviewer, config: ctx.config }, {});
    expect(reviewed.suggested).toBeGreaterThanOrEqual(1);
    const verdicts = (await listSuggestions(ctx.store, { status: 'pending' })).filter((s) => (s.payload as { kind?: string })?.kind === 'claim-review');
    expect(verdicts.length).toBeGreaterThanOrEqual(1);
    expect(verdicts[0].body).toContain('支持 B');
    expect(verdicts[0].body).toContain('降级来源');
    expect((await reviewClaims({ store: ctx.store, llm: reviewer, config: ctx.config }, {})).suggested).toBe(0);

    // external verification policy
    ctx.config.review.external = 'verify';
    expect(networkAllowed(ctx.config, 'verify')).toBe(true);
    expect(networkAllowed(ctx.config, 'entity')).toBe(false);
    ctx.config.review.external = 'research';
    expect(networkAllowed(ctx.config, 'entity')).toBe(true);
    ctx.config.review.external = 'off';
    expect(networkAllowed(ctx.config, 'verify')).toBe(false);

    // a verify page's identity verdicts become a merge candidate and a remembered rejection
    const ws = { outputPath: 'wiki/reviews/苹果公司.md', actor: 'agent/claude-cli' } as RunWorkspace;
    await applyIdentityVerdicts(ctx, ws, { title: '核实：苹果公司', sameAs: ['[[苹果]]'], notSameAs: ['比亚迪'] }, () => {});
    const after = await listSuggestions(ctx.store, {});
    expect(after.find((s) => s.id === appleId)).toMatchObject({ status: 'pending' }); // the page's evidence re-opens the pair for a person
    expect(after.find((s) => s.id === mergeSuggestionId('苹果公司', '比亚迪'))).toMatchObject({ status: 'rejected' });
  });
});
