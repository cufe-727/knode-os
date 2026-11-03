import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, defaultRoutedLlmConfig, LlmConnection } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { runDocumentPass } from '../src/ingest/background.js';
import { sync } from '../src/ingest/sync.js';
import { ensureDefaultAgents } from '../src/research/agents.js';
import { startFakeOpenAi, type ChatRequest, type FakeOpenAi } from './helpers/fake-openai.js';

/** A claim cites the chunk its statement came from, in Chinese as in English. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-claim-grounding-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p as { text?: string })?.text ?? '').join('') : '';
const systemOf = (r: ChatRequest) => textOf(r.messages?.find((m) => m.role === 'system')?.content);

function fakeModel(url: string): LlmConnection {
  return { id: 'connection-1', label: 'fake', provider: 'openai', baseUrl: url, apiKey: 'sk-test', protocol: 'chat', model: 'fake-model', cliPath: '', effort: 'default', cliTimeoutMs: 30_000 };
}

/** Three sections, each longer than a chunk, so each claim's source sits in a different chunk. */
const DOC = [
  '# 盘后笔记',
  '',
  '## 电池',
  '',
  `宁德时代公布新一代钠离子电池量产计划，市场关注储能订单的放量节奏。${'电池板块整体震荡，资金在储能与动力之间轮动。'.repeat(8)}`,
  '',
  '## 汽车',
  '',
  `比亚迪十月销量环比回落，海外工厂的产能爬坡慢于预期。${'整车板块成交清淡，价格战的影响仍在发酵。'.repeat(8)}`,
  '',
  '## 光模块',
  '',
  `中际旭创三季度营收同比增长百分之八十，800G 光模块出货占比继续提升。${'算力链情绪回暖，光模块龙头放量上涨。'.repeat(8)}`,
  '',
  '## Notes',
  '',
  `Innolight raised its 1.6T transceiver shipment guidance for next year. ${'Optical names rallied on the update. '.repeat(8)}`,
  '',
].join('\n');

const CLAIMS = [
  { subject: '中际旭创', statement: '中际旭创三季度营收同比增长约八成，800G 产品出货占比提升', type: 'earnings', status: 'fact' },
  { subject: '比亚迪', statement: '比亚迪10月销量环比下滑，海外工厂产能爬坡偏慢', type: 'event', status: 'fact' },
  { subject: 'Innolight', statement: 'Innolight raised 1.6T transceiver shipment guidance', type: 'guidance', status: 'fact' },
];

describe('grounding claims to their chunk', () => {
  const dataDir = path.join(tmp, 'ws');
  let fake: FakeOpenAi;
  let ctx: AppContext;

  beforeAll(async () => {
    fake = await startFakeOpenAi({
      answer: (request) => {
        const system = systemOf(request);
        if (system.includes('Summarize the document')) return 'Summary.\n\n## Key points\n\n- 内容';
        if (!system.includes('knowledge-graph extraction engine')) return JSON.stringify({});
        return JSON.stringify({
          entities: [
            { name: '中际旭创', type: 'organization', aliases: [] },
            { name: '比亚迪', type: 'organization', aliases: [] },
            { name: 'Innolight', type: 'organization', aliases: [] },
          ],
          relations: [],
          claims: CLAIMS,
        });
      },
    });
    const base = defaultConfig();
    const route = { ...defaultRoutedLlmConfig(), use: 'connection-1' };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'knode.config.json'), JSON.stringify({
      ...base,
      connections: [fakeModel(fake.url)],
      llmUse: 'connection-1',
      ingest: { ...base.ingest, chunkSize: 300, chunkOverlap: 30 },
      extraction: { ...base.extraction, entityLlm: route, documentLlm: route, summaryLlm: route, judgeLlm: route },
    }));
    ensureDefaultAgents(dataDir);
    fs.mkdirSync(path.join(dataDir, 'raw/docs'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'raw/docs/notes.md'), DOC);
    ctx = await createContext(dataDir);
    await sync(ctx, {});
    for (let i = 0; i < 5 && (await runDocumentPass(ctx)).queued > 0; i++);
  });

  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
    await fake?.close();
  });

  const citedChunk = async (statement: string) => {
    const rows = await ctx.store.query<{ content: string; seq: number }>(
      `SELECT ch.content, ch.seq FROM claims c JOIN chunks ch ON ch.id = c.chunk_id WHERE c.statement = $1`,
      [statement],
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  it('splits the document into several chunks', async () => {
    const [{ n }] = await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM chunks`);
    expect(n).toBeGreaterThanOrEqual(4);
  });

  it('cites the chunk a Chinese statement paraphrases, not the first one', async () => {
    const optics = await citedChunk(CLAIMS[0].statement);
    expect(optics.content).toContain('中际旭创三季度营收');
    expect(optics.seq).toBeGreaterThan(0);
    const autos = await citedChunk(CLAIMS[1].statement);
    expect(autos.content).toContain('比亚迪十月销量');
  });

  it('still grounds an English statement by its words', async () => {
    const notes = await citedChunk(CLAIMS[2].statement);
    expect(notes.content).toContain('Innolight raised');
  });
});
