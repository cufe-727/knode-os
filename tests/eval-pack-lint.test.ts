import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lintBeforeRun, lintPack, LINT_RULES } from '../src/eval/lint.js';
import { loadPack } from '../src/eval/pack.js';
import { recipe } from '../src/eval/packs/index.js';
import '../src/eval/packs/recipes.js';
import { PackWriter } from '../src/eval/packs/writer.js';

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-lint-'));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A small pack with one planted fault per rule, and a clean twin of each faulty question. */
function plantedPack(dir: string) {
  const w = new PackWriter(dir, {
    id: 'lint-planted', version: 1, title: 'lint', domain: 'fixture', languages: ['zh'], description: 'planted lint faults', builder: { recipe: 'test' },
    lint: { families: { hop: 2, aggregate: 1 }, strata: { h5: 1 } },
  });
  const weekly = (i: number, text: string) => w.addDoc({ path: `周报/平台组/${String(i).padStart(2, '0')}.md`, kind: 'weekly-report', lang: 'zh' }, text);
  for (let i = 1; i <= 12; i++) weekly(i, `# 平台组周报 第${i}周\n\n本周服务可用性稳定，值守正常。\n${i === 3 ? '王芳修复了缓存击穿，复盘人老K。\n' : ''}${i === 5 ? '二部平台组的李强调往增长组。\n' : ''}`);
  for (let i = 1; i <= 4; i++) w.addDoc({ path: `周报/增长组/${i}.md`, kind: 'weekly-report', lang: 'zh' }, `# 增长组周报\n\n周活跃用户持平。\n`);
  for (let i = 1; i <= 3; i++) w.addDoc({ path: `月报/pmo-${i}.md`, kind: 'pmo-summary', lang: 'zh' }, `# 项目管理办公室月报\n\n第三事业部各组在岗人数如下。\n`);
  w.addAlias({ canonical: '平台组', aliases: ['平台组'], kind: 'team' });
  w.addAlias({ canonical: '二部平台组', aliases: ['二部平台组'], kind: 'team' });
  w.addAlias({ canonical: '王芳', aliases: ['王芳', '老K'], kind: 'person' });
  const ev = (n: number) => [{ doc: `周报/平台组/${String(n).padStart(2, '0')}.md` }];
  // class-word: "事业部" is only in the PMO summaries, the evidence is a weekly report
  w.addTask({ id: 'class', suite: 'usage', type: 'single-hop', lang: 'zh', question: '（第三事业部）缓存击穿是谁修复的？', scoring: 'value', answer: '王芳', evidence: ev(3) });
  // ambiguous-subject: "平台组" is one team's name and inside another's
  w.addTask({ id: 'ambiguous', suite: 'update', type: 'update', lang: 'zh', question: '平台组现在在岗多少人？', scoring: 'value', answer: '7', evidence: ev(12) });
  w.addTask({ id: 'unambiguous', suite: 'update', type: 'update', lang: 'zh', question: '二部平台组现在在岗多少人？', scoring: 'value', answer: '6', evidence: ev(12) });
  // file-names: four files in the folder the question names
  w.addAlias({ canonical: '增长组', aliases: ['增长组'], kind: 'team' });
  w.addTask({ id: 'files', suite: 'usage', type: 'structured', lang: 'zh', question: '增长组一共写了几份周报？', scoring: 'count', answer: '4', evidence: [1, 2, 3, 4].map((i) => ({ doc: `周报/增长组/${i}.md` })), meta: { family: 'aggregate' } });
  // duplicate-text: same question, different gold
  w.addTask({ id: 'dup-a', suite: 'usage', type: 'single-hop', lang: 'zh', question: '李强调往哪个组？', scoring: 'value', answer: '增长组', evidence: ev(5) });
  w.addTask({ id: 'dup-b', suite: 'usage', type: 'single-hop', lang: 'zh', question: '李强调往哪个组？', scoring: 'value', answer: '支付组', evidence: ev(5) });
  // hop-shortcut: the answer stands beside the question's rare word "复盘"
  w.addTask({ id: 'shortcut', suite: 'usage', type: 'deep-hop', lang: 'zh', question: '复盘人老K的那次事故，是谁修复的？', scoring: 'value', answer: '王芳', evidence: [ev(3)[0], ev(5)[0], ev(7)[0]], meta: { hops: 3, stratum: 'h3', family: 'hop' } });
  w.finish();
  return loadPack(dir);
}

describe('pack lint', () => {
  it('finds each planted fault, and only those', () => {
    const r = lintPack(plantedPack(path.join(tmp, 'planted')));
    const by = (rule: string) => r.findings.filter((f) => f.rule === rule).map((f) => f.task ?? f.message);
    expect(by('class-word')).toEqual(['class']);
    expect(by('ambiguous-subject')).toEqual(['ambiguous']);
    expect(by('file-names')).toEqual(['files']);
    expect(by('duplicate-text')).toEqual(['dup-a']);
    expect(by('hop-shortcut')).toEqual(['shortcut']);
    // one hop of the two asked for, no h5 at all
    expect(by('family-minimum').sort()).toEqual(['family hop has 1 questions, fewer than 2', 'stratum h5 has 0 questions, fewer than 1']);
    expect(Object.keys(r.counts)).toEqual([...LINT_RULES]);
  });

  it('flags the v2 10× pack\'s update questions that name a team ten divisions share', async () => {
    const out = path.join(tmp, 'v2x10');
    await recipe('synthetic-reports-zh').build(out, { seed: 0, log: () => {}, options: { size: 10 } });
    const r = lintPack(loadPack(out));
    const amb = r.findings.filter((f) => f.rule === 'ambiguous-subject').map((f) => f.task!);
    expect(amb.filter((t) => t.startsWith('upd-')).length).toBeGreaterThan(0);
    // the second division's questions name "二部平台组" in full: not ambiguous
    expect(amb.filter((t) => t.startsWith('d2-upd'))).toEqual([]);
  });

  it('stops a run before anything is spent when a pack has findings', async () => {
    const bad = lintBeforeRun([loadPack(path.join(tmp, 'planted'))]);
    expect(bad.ok).toBe(false);
    expect(bad.report).toMatch(/--no-lint/);
  });
});
