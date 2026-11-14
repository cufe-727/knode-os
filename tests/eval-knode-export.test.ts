import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { Meter } from '../src/eval/meter.js';
import { loadPack, stageCorpus } from '../src/eval/pack.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { QuotaGuard } from '../src/eval/quota.js';
import { runEval } from '../src/eval/run.js';
import { RunStore } from '../src/eval/runstore.js';
import { startShim, type ChatRequest } from '../src/eval/shim.js';
import { claimWindow, knodeAsk } from '../src/eval/systems/knode.js';
import type { SystemEnv } from '../src/eval/systems/types.js';
import type { KnowledgeUnit } from '../src/eval/types.js';
import { ScriptedBackend, scriptedJudge } from './helpers/eval-scripted.js';

/**
 * What the knode adapter hands the scorers (src/eval/systems/knode.ts), on one
 * small build: the units it exports for the generation suite.
 */

/** The fixture's extraction, with a period on the claim read off the offer email. */
class DatedBackend extends ScriptedBackend {
  async complete(req: ChatRequest) {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const user = req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    if (!system.includes('knowledge-graph extraction engine') || !user.includes('岗位为高级数据工程师')) return super.complete(req);
    this.calls++;
    const text = JSON.stringify({
      entities: [
        { name: '林晓', type: 'person', description: '数据工程师', aliases: [] },
        { name: '澜舟科技', type: 'organization', description: '林晓的新公司', aliases: ['澜舟'] },
      ],
      relations: [{ source: '林晓', target: '澜舟科技', type: 'works_at', description: '入职' }],
      claims: [{ subject: '林晓', statement: '林晓在澜舟科技的试用期', type: 'event', status: 'fact', kind: 'fact', startDate: '2026-04-01', endDate: '2026-06-30' }],
    });
    return { text, usage: { inputTokens: 100, cachedInputTokens: 40, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 0 }, model: 'scripted' };
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-eval-export-'));
const packDir = path.join(tmp, 'packs', 'fixture-life');
const base = path.join(tmp, 'runs', 'base');
const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false });
// a zone ahead of UTC, where the end of a day in UTC is the next morning: a date cut in local time is a day late
const zone = process.env.TZ;

let env: SystemEnv;
let closeEnv: () => Promise<void>;
let units: KnowledgeUnit[];
const sys = knodeAsk();

beforeAll(async () => {
  process.env.TZ = 'Asia/Shanghai';
  buildFixturePack(packDir);
  await runEval({ packs: [packDir], systems: ['knode-ask'], runDir: base, quota: false, suites: ['usage'], limit: 1, skipScoring: true, overrides: { chat: new DatedBackend(), judge: scriptedJudge(), embedder } });
  const pack = loadPack(packDir);
  const staged = stageCorpus(pack);
  const meter = new Meter();
  const shim = await startShim({ backend: new DatedBackend(), embedder, meter });
  env = {
    runId: 'export', pack, staged, workDir: new RunStore(base).workDir(pack.manifest.id, 'knode'), shim, meter,
    quota: new QuotaGuard({ enabled: false }), models: { model: '', buildEffort: 'low', answerEffort: 'medium' }, log: () => {},
  };
  closeEnv = async () => {
    await sys.release!(env);
    await shim.close();
    staged.cleanup();
  };
  await sys.reopen!(env);
  units = await sys.exportKnowledge!(env);
}, 180_000);
afterAll(async () => {
  await closeEnv?.();
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('exported claims', () => {
  it('say the period they hold for in ISO dates, the end day as stored', () => {
    const dated = units.filter((u) => u.kind === 'claim' && u.text.includes('试用期'));
    expect(dated).toHaveLength(1);
    expect(dated[0].text).toBe('林晓在澜舟科技的试用期 (2026-04-01 – 2026-06-30)');
    expect(dated[0].sources).toEqual(['email/2026-03-05.md']);
    // every date a claim unit carries is a whole one: no weekday-and-month cut of a Date
    for (const u of units.filter((x) => x.kind === 'claim')) expect(u.text).not.toMatch(/\((Mon|Tue|Wed|Thu|Fri|Sat|Sun) /);
  });

  it('reads a period from what either driver returns, with open sides', () => {
    // the stored instants: a day's start and a day's end in UTC (src/store/dates.ts)
    expect(claimWindow(new Date('2025-11-03T00:00:00.000Z'), new Date('2025-11-07T23:59:59.999Z'))).toBe(' (2025-11-03 – 2025-11-07)');
    expect(claimWindow('2025-11-03T00:00:00.000Z', '2025-11-07T23:59:59.999Z')).toBe(' (2025-11-03 – 2025-11-07)');
    expect(claimWindow(new Date('2025-11-03T00:00:00.000Z'), null)).toBe(' (2025-11-03 – )');
    expect(claimWindow(null, new Date('2025-11-07T23:59:59.999Z'))).toBe(' (? – 2025-11-07)');
    expect(claimWindow(null, null)).toBe('');
  });
});
