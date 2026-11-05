import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { LlmClient } from '../src/llm/client.js';
import { loadPack } from '../src/eval/pack.js';
import { finishDocpack } from '../src/eval/packs/docpack.js';
import { extractFacts, oracleCheck } from '../src/eval/packs/gold.js';
import { parseAtom } from '../src/eval/packs/research.js';
import { makeScript } from '../src/eval/packs/synthetic.js';
import { PackWriter } from '../src/eval/packs/writer.js';

/** docs/design/23 §2: the pieces pack recipes are built from. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-eval-packs-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** An author that answers by what its system prompt asks for. */
function author(reply: (system: string, user: string) => unknown): LlmClient {
  return {
    label: 'fake-author', model: 'fake', enabled: true,
    async completeJson<T>(messages: { role: string; content: string }[]): Promise<T> {
      return reply(messages.find((m) => m.role === 'system')?.content ?? '', messages.find((m) => m.role === 'user')?.content ?? '') as T;
    },
  } as unknown as LlmClient;
}

describe('pack builders', () => {
  it('writes the same synthetic life for the same seed', () => {
    const a = makeScript('zh', 7);
    const b = makeScript('zh', 7);
    expect(a.cast).toEqual(b.cast);
    expect(a.events.map((e) => e.phrase)).toEqual(b.events.map((e) => e.phrase));
    expect(makeScript('zh', 8).cast.me.name === a.cast.me.name && makeScript('zh', 8).cast.rent === a.cast.rent).toBe(false);
    expect(a.needs.some((n) => n.signal === 'latent')).toBe(true);
    expect(a.gapDays).toBeGreaterThan(0);
    for (const e of a.events) expect(e.fact.length).toBeGreaterThan(5);
  });

  it('reads arXiv Atom entries', () => {
    const xml = `<feed><entry><id>http://arxiv.org/abs/2507.01234v2</id><title>Agents  that
      plan</title><summary>We study agents.</summary><published>2025-07-03T10:00:00Z</published><author><name>A. One</name></author><author><name>B. Two</name></author></entry></feed>`;
    expect(parseAtom(xml)).toEqual([{ id: '2507.01234v2', title: 'Agents that plan', summary: 'We study agents.', published: '2025-07-03', authors: ['A. One', 'B. Two'] }]);
  });

  it('keeps only facts whose quote is in their document', async () => {
    const docs = [{ path: 'a.md', text: '澜舟科技的入职日期为 2026 年 4 月 1 日。' }];
    const facts = await extractFacts(author(() => ({ facts: [
      { doc: 'a.md', text: '入职日期是 4 月 1 日', quote: '入职日期为 2026 年 4 月 1 日' },
      { doc: 'a.md', text: '月薪三万', quote: '月薪为 30000 元' },
    ] })), docs, { lang: 'zh' });
    expect(facts.map((f) => f.quote)).toEqual(['入职日期为 2026 年 4 月 1 日']);
  });

  it('drops tasks the oracle does not answer the way the gold does', async () => {
    const drafts = [
      { id: 't1', suite: 'usage' as const, type: 'single-hop' as const, question: 'q1', answer: 'a1', scoring: 'judge' as const, evidence: [{ doc: 'a.md' }] },
      { id: 't2', suite: 'usage' as const, type: 'single-hop' as const, question: 'q2', answer: 'a2', scoring: 'judge' as const, evidence: [{ doc: 'a.md' }] },
    ];
    const kept = await oracleCheck(author(() => ({ verdicts: [{ i: 0, consistent: true }, { i: 1, consistent: false }] })), drafts, new Map([['a.md', 'text']]), 'English');
    expect(kept.map((t) => t.id)).toEqual(['t1']);
  });

  it('finishes a document pack with recipe tasks and drafted gold', async () => {
    const dir = path.join(tmp, 'docpack');
    const writer = new PackWriter(dir, { id: 'docpack-test', version: 1, title: 't', domain: 'fixture', languages: ['en'], description: 'd', builder: { recipe: 'test' } });
    const issues = await finishDocpack({
      writer,
      lang: 'en',
      docs: [{ path: 'x.md', lang: 'en', text: 'The board approved the merger on May 2, 2025.' }],
      tasks: [{ id: 'own', suite: 'usage', type: 'single-hop', question: 'When was the merger approved?', answer: 'May 2, 2025', scoring: 'exact', evidence: [{ doc: 'x.md', quote: 'approved the merger on May 2, 2025' }] }],
    }, { log: () => {}, options: {}, author: author(() => ({ facts: [{ doc: 'x.md', text: 'The merger was approved on May 2, 2025.', quote: 'approved the merger on May 2, 2025' }] })) });
    expect(issues.errors).toEqual([]);
    const pack = loadPack(dir);
    expect(pack.facts).toHaveLength(1);
    expect(pack.tasks.map((t) => t.id)).toEqual(['own']);
  });
});
