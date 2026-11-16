import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildReportData, discriminationOf, knodeToolsOf, LADDER_DIFFERENCES, ladderOf, renderReport } from '../src/eval/report.js';
import { emptyUsage, type AnswerRecord, type ScoreRecord } from '../src/eval/types.js';

/**
 * The report's ladder (docs/design/33 §2, §5): the five declared differences,
 * paired, Holm-corrected, for correctness and cost with each one's MDE, shown
 * for the rows whose arms the run has; the discrimination table; cost per
 * correct answer beside correctness; and knode's tools against correctness.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-report-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const TYPES = ['fact', 'multi-hop'] as const;

function answer(system: string, i: number, over: Partial<AnswerRecord> = {}): AnswerRecord {
  return {
    key: `a-${system}-${i}`, pack: 'p', system, taskId: `t${i}`, at: '', text: '', finalAnswer: '', citations: [], retrieved: [], toolCalls: 4,
    usage: { ...emptyUsage(), weightedTokens: 1000, costUsd: 0.05 }, ms: 30_000, ...over,
  };
}
function score(system: string, i: number, value: number): ScoreRecord {
  return { key: `s-${system}-${i}`, pack: 'p', system, suite: 'usage', taskId: `t${i}`, taskType: TYPES[i % 2], metric: 'correctness', value, at: '' };
}

/** 40 questions: A right on 20, B on 30 at twice A's tokens, C as A, D right on 36 with knode tools on half. */
function records(arms: string[]) {
  const answers: AnswerRecord[] = [];
  const scores: ScoreRecord[] = [];
  for (let i = 0; i < 40; i++) {
    const right: Record<string, number> = { 'agent-grep': i < 20 ? 1 : 0, 'agent-rag': i < 30 ? 1 : 0, 'agent-knode-wiki-sources': i < 20 ? 1 : 0, 'agent-knode-full': i < 36 ? 1 : i < 38 ? 0.5 : 0 };
    for (const arm of arms) {
      const over: Partial<AnswerRecord> = arm === 'agent-rag' ? { usage: { ...emptyUsage(), weightedTokens: 2000, costUsd: 0.1 } }
        : arm === 'agent-knode-full' ? { commands: i % 2 ? ['mcp:knode.knode_claims {"subject":"x"}', 'mcp:knode.knode_claims {}', 'rg -n x .'] : ['rg -n x .'] } : {};
      answers.push(answer(arm, i, over));
      scores.push(score(arm, i, right[arm]));
    }
  }
  return { answers, scores };
}

const correctnessOf = (scores: ScoreRecord[]) => new Map(scores.map((s) => [`${s.system}\u0000${s.pack}\u0000${s.taskId}`, s.value!]));

describe('the ladder table', () => {
  it('pairs each declared difference over the same questions, for correctness and cost, with its MDE and Holm', () => {
    const { answers, scores } = records(['agent-grep', 'agent-rag', 'agent-knode-wiki-sources', 'agent-knode-full']);
    const rows = ladderOf(answers, correctnessOf(scores));
    expect(rows.map((r) => r.name)).toEqual(LADDER_DIFFERENCES.map((d) => d.name));
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by['B − A'].n).toBe(40);
    expect(by['B − A'].metrics.correctness.diff).toBeCloseTo(0.25, 9);
    expect(by['B − A'].metrics.correctness.meanA).toBeCloseTo(0.75, 9);
    expect(by['B − A'].metrics.tokens.diff).toBe(1000);
    expect(by['B − A'].metrics.usd.diff).toBeCloseTo(0.05, 9);
    expect(by['B − A'].metrics.seconds.diff).toBe(0);
    // C ties A exactly: nothing to detect, never significant
    expect(by['C − A'].metrics.correctness.diff).toBe(0);
    expect(by['C − A'].metrics.correctness.significant).toBe(false);
    expect(by['D − A'].metrics.correctness.diff).toBeCloseTo((16 + 1) / 40, 9);
    expect(by['D − A'].metrics.correctness.significant).toBe(true);
    // an MDE for every metric that varies; the paired spread of D − A gives (z.975 + z.8) · sd / √n
    const d = Array.from({ length: 40 }, (_, i) => (i < 20 ? 0 : i < 36 ? 1 : i < 38 ? 0.5 : 0));
    const m = d.reduce((x, y) => x + y, 0) / 40;
    const sd = Math.sqrt(d.reduce((x, y) => x + (y - m) ** 2, 0) / 39);
    expect(by['D − A'].metrics.correctness.mde).toBeCloseTo(2.8016 * sd / Math.sqrt(40), 3);
  });

  it('shows only the rows whose two arms the run answered with', () => {
    const { answers, scores } = records(['agent-grep', 'agent-knode-wiki-sources']);
    expect(ladderOf(answers, correctnessOf(scores)).map((r) => r.name)).toEqual(['C − A']);
    const one = records(['agent-grep']);
    expect(ladderOf(one.answers, correctnessOf(one.scores))).toEqual([]);
  });

  it('pairs first answers only, over questions both were scored on', () => {
    const { answers, scores } = records(['agent-grep', 'agent-rag']);
    // a repeat, and a question one arm was not scored on, are left out
    answers.push(answer('agent-rag', 0, { key: 'r2', repeat: 2, usage: { ...emptyUsage(), weightedTokens: 999_999 } }));
    const kept = scores.filter((s) => !(s.system === 'agent-grep' && s.taskId === 't39'));
    const [row] = ladderOf(answers, correctnessOf(kept));
    expect(row.n).toBe(39);
    expect(row.metrics.tokens.diff).toBe(1000);
  });
});

describe('the discrimination table', () => {
  it('counts the questions every agent got fully right, none did, and the rest, per type', () => {
    const { scores } = records(['agent-grep', 'agent-rag', 'agent-knode-full']);
    const typeOf = new Map(scores.map((s) => [`${s.pack}\u0000${s.taskId}`, s.taskType!]));
    const d = discriminationOf(['agent-grep', 'agent-rag', 'agent-knode-full'], correctnessOf(scores), typeOf)!;
    // all right below 20; none right from 38 (D's 0.5s at 36–37 are not fully right, and A and B are wrong there)
    expect(d.overall).toEqual({ n: 40, allRight: 20, noneRight: 4, rest: 16 });
    expect(d.byType.fact).toEqual({ n: 20, allRight: 10, noneRight: 2, rest: 8 });
    expect(d.byType['multi-hop'].n).toBe(20);
    expect(discriminationOf(['agent-grep'], correctnessOf(scores), typeOf)).toBeNull();
  });
});

describe('knode tools against correctness', () => {
  it('counts each tool\'s calls and compares the answers that used it with the rest', () => {
    const { answers, scores } = records(['agent-grep', 'agent-knode-full']);
    const out = knodeToolsOf(answers, correctnessOf(scores));
    expect(Object.keys(out.p)).toEqual(['agent-knode-full']);
    const [claims] = out.p['agent-knode-full'];
    expect(claims.tool).toBe('knode_claims');
    expect(claims.calls).toBe(40);
    expect(claims.perAnswer).toBe(1);
    expect(claims.used.n).toBe(20);
    expect(claims.unused.n).toBe(20);
    // odd questions used it: right on 18 of the 20 below 36, 0.5 on 37 and 0 on 39
    expect(claims.used.value).toBeCloseTo((18 + 0.5) / 20, 9);
  });
});

describe('the report', () => {
  it('opens with the ladder and the discrimination table, and puts cost per correct answer beside correctness', () => {
    const dir = path.join(tmp, 'run');
    fs.mkdirSync(dir, { recursive: true });
    const { answers, scores } = records(['agent-grep', 'agent-rag', 'agent-knode-wiki-sources', 'agent-knode-full']);
    fs.writeFileSync(path.join(dir, 'answers.jsonl'), answers.map((a) => JSON.stringify(a)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'scores.jsonl'), scores.map((s) => JSON.stringify(s)).join('\n') + '\n');
    const data = buildReportData(dir);
    expect(data.ladder).toHaveLength(5);
    expect(data.discrimination!.systems).toEqual(['agent-grep', 'agent-knode-full', 'agent-knode-wiki-sources', 'agent-rag']);
    const md = renderReport(data);
    const at = (h: string) => md.indexOf(h);
    expect(at('## The ladder')).toBeGreaterThan(0);
    expect(at('## The ladder')).toBeLessThan(at('## Which questions tell the agents apart'));
    expect(at('## Which questions tell the agents apart')).toBeLessThan(at('## Pooled correctness against agent-grep'));
    expect(md).toMatch(/\| B − A \(agent-rag − agent-grep\) \| semantic search over the sources \| 40 \| 0\.750 \| 0\.500 \| \+0\.250 \|/);
    expect(md).toMatch(/\| B − A \| 40 \| \+1000 \(0\) \* \|/);
    expect(md).toContain('| system | correctness | USD / correct | tokens / correct |');
    // A: 20 correct for 40 × $0.05
    expect(md).toMatch(/\| agent-grep \| 0\.50 \[[^\]]+\] \| 0\.1000 \| 2000 \|/);
    expect(md).toContain('### knode tools and correctness');
    expect(md).toMatch(/\| agent-knode-full \| knode_claims \| 40 \| 1\.00 \| 20 \|/);
  });

  it('renders a run with no ladder arms as before, without the ladder', () => {
    const dir = path.join(tmp, 'old');
    fs.mkdirSync(dir, { recursive: true });
    const { answers, scores } = records(['agent-grep']);
    // records from before outputs (and traces) were kept
    fs.writeFileSync(path.join(dir, 'answers.jsonl'), answers.map((a) => JSON.stringify(a)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'scores.jsonl'), scores.map((s) => JSON.stringify(s)).join('\n') + '\n');
    const data = buildReportData(dir);
    expect(data.ladder).toBeUndefined();
    expect(data.discrimination).toBeUndefined();
    expect(data.knodeTools).toBeUndefined();
    const md = renderReport(data);
    expect(md).not.toContain('## The ladder');
    expect(md).not.toContain('## Which questions tell the agents apart');
    expect(md).toContain('### Use: answering');
  });
});
