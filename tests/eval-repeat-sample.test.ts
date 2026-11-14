import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { buildReportData, renderReport, repeatPairsOf } from '../src/eval/report.js';
import { repeatSampleOf, runEval } from '../src/eval/run.js';
import { RunStore } from '../src/eval/runstore.js';
import { emptyUsage, type AnswerRecord, type ScoreRecord, type Task } from '../src/eval/types.js';
import { ScriptedBackend, scriptedJudge } from './helpers/eval-scripted.js';

/* Repeats on a seeded subsample (`--repeat 3 --repeat-sample n`, docs/design/33 §6.4) and the report's spread. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repeat-sample-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const task = (id: string, type: Task['type']): Task => ({ id, suite: 'usage', type, question: '?', scoring: 'judge', evidence: [] });

describe('repeat sample', () => {
  it('is stratified by task type, seeded, and off without a size', () => {
    const pool = [
      ...Array.from({ length: 50 }, (_, i) => task(`f${i}`, 'fact')),
      ...Array.from({ length: 30 }, (_, i) => task(`m${i}`, 'multi-hop')),
      ...Array.from({ length: 4 }, (_, i) => task(`s${i}`, 'stale')),
    ];
    const sample = repeatSampleOf(pool, 15, 0)!;
    const byType = (ids: Set<string>) => [...ids].reduce<Record<string, number>>((acc, id) => ((acc[id[0]] = (acc[id[0]] ?? 0) + 1), acc), {});
    // round-robin across types: the small type gives all it has, the others share the rest
    expect(byType(sample)).toEqual({ f: 6, m: 5, s: 4 });
    expect([...repeatSampleOf(pool, 15, 0)!]).toEqual([...sample]);
    expect([...repeatSampleOf(pool, 15, 1)!]).not.toEqual([...sample]);
    expect(repeatSampleOf(pool, undefined, 0)).toBeNull();
    expect(repeatSampleOf(pool.slice(0, 3), 15, 0)!.size).toBe(3);
  });

  it('repeats only the sample, the same tasks for every repeated system, and the report says so', async () => {
    const packDir = path.join(tmp, 'pack');
    buildFixturePack(packDir);
    const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false });
    const res = await runEval({
      packs: [packDir], systems: ['closed-book', 'rag-hybrid'], runDir: path.join(tmp, 'run'), quota: false, suites: ['usage'],
      repeat: 3, repeatSample: 4, judgeAudit: 0, overrides: { chat: new ScriptedBackend(), judge: scriptedJudge(), embedder },
    });
    const store = new RunStore(res.runDir);
    const answers = store.allAnswers();
    const first = (s: string) => new Set(answers.filter((a) => a.system === s && !a.repeat && !a.batch).map((a) => a.taskId));
    const repeated = (s: string, r: number) => new Set(answers.filter((a) => a.system === s && a.repeat === r && !a.batch).map((a) => a.taskId));
    expect(first('closed-book').size).toBeGreaterThan(4);
    for (const s of ['closed-book', 'rag-hybrid']) {
      expect(repeated(s, 2).size).toBe(4);
      expect(repeated(s, 3)).toEqual(repeated(s, 2));
    }
    expect(repeated('rag-hybrid', 2)).toEqual(repeated('closed-book', 2));
    expect(store.meta()!.repeat).toMatchObject({ n: 3, sample: 4 });

    const data = buildReportData(res.runDir);
    const pack = Object.keys(data.variance ?? {})[0];
    expect(data.variance![pack]['closed-book'].tasks).toBe(4);
    expect(data.repeatPairs![pack]).toHaveLength(1);
    expect(data.repeatPairs![pack][0]).toMatchObject({ a: 'closed-book', b: 'rag-hybrid', tasks: 4 });
    const md = renderReport(data);
    expect(md).toContain('seeded sample of 4 tasks');
    expect(md).toContain('#### Paired differences against the run-to-run spread');
  }, 120_000);

  it('tells a difference within the run-to-run spread from one outside it', () => {
    const scores: ScoreRecord[] = [];
    const answers: AnswerRecord[] = [];
    const put = (system: string, taskId: string, repeat: number, value: number) => {
      answers.push({ key: `${system}${taskId}${repeat}`, pack: 'p', system, taskId, at: '', text: '', finalAnswer: '', citations: [], retrieved: [], toolCalls: 0, usage: emptyUsage(), ms: 1, ...(repeat ? { repeat } : {}) });
      scores.push({ key: `s${system}${taskId}${repeat}`, pack: 'p', system, suite: 'usage', taskId, metric: 'correctness', value, at: '', ...(repeat ? { repeat } : {}) });
    };
    // four tasks, three repeats; a is right on 3–4 of them, b on 1–2: a steady difference of about 0.5
    const a = [[1, 1, 1, 0], [1, 1, 1, 1], [1, 1, 0, 1]];
    const b = [[1, 0, 0, 0], [0, 1, 0, 0], [1, 1, 0, 0]];
    // c is a run-to-run coin flip against a: sometimes ahead, sometimes behind
    const c = [[1, 1, 1, 1], [1, 1, 1, 0], [0, 1, 1, 0]];
    [0, 2, 3].forEach((r, i) => [0, 1, 2, 3].forEach((t) => {
      put('agent-grep', `t${t}`, r, a[i][t]);
      put('b', `t${t}`, r, b[i][t]);
      put('c', `t${t}`, r, c[i][t]);
    }));
    const pairs = repeatPairsOf(answers, scores).p;
    const ab = pairs.find((x) => x.a === 'agent-grep' && x.b === 'b')!;
    const ac = pairs.find((x) => x.a === 'agent-grep' && x.b === 'c')!;
    expect(ab.perRepeat.map((x) => +x.toFixed(2))).toEqual([0.5, 0.75, 0.25]);
    expect(ab.withinSpread).toBe(false);
    expect(ac.perRepeat.map((x) => +x.toFixed(2))).toEqual([-0.25, 0.25, 0.25]);
    expect(ac.withinSpread).toBe(true);
  });
});
