import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectTextLanguage } from '../src/lang/detect.js';
import { protectSpans, restoreSpans } from '../src/lang/protect.js';
import { finishSegment, planTranslation, translationRequest } from '../src/lang/translate.js';
import { segmentText } from '../src/graph/segment.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-translation-code-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const prose = 'The library preserves the source code and translates every paragraph for the reader. ';

function plan(body: string, name = 'example.md') {
  const rel = `raw/docs/${name}`;
  fs.mkdirSync(path.join(root, 'raw/docs'), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
  const work = planTranslation(root, { id: name, path: rel, root: 'docs', sha256: 'test' }, 'zh');
  if (work.kind !== 'work') throw new Error(`unexpected plan: ${work.reason}`);
  return work;
}

describe('translation code boundaries', () => {
  it('protects indented fences without swallowing the prose between list items', () => {
    const text = [
      '1. Configure the library.',
      '',
      '   ```ts',
      '   export const value = "unchanged";',
      '   ```',
      '',
      '2. Translate this paragraph.',
      '',
      '   ~~~sh',
      '   export TOKEN=example',
      '   ~~~~',
      '',
      '3. Keep the final paragraph.',
    ].join('\n');
    const masked = protectSpans(text);
    expect(masked.spans).toHaveLength(2);
    expect(masked.text).toContain('Translate this paragraph.');
    expect(masked.text).toContain('Keep the final paragraph.');
    expect(masked.text).not.toContain('export');
    expect(restoreSpans(masked.text, masked.spans)).toEqual({ text, missing: [] });
  });

  it('keeps shorter nested fence markers inside a longer fenced example', () => {
    const text = '````markdown\n```ts\nconst x = 1;\n```\n`````\n\nThe paragraph outside is translated.';
    const masked = protectSpans(text);
    expect(masked.spans).toHaveLength(1);
    expect(masked.spans[0]).toContain('const x = 1;');
    expect(masked.text).toContain('The paragraph outside is translated.');
    expect(restoreSpans(masked.text, masked.spans).text).toBe(text);
  });

  it('protects bare file citations and leaves ordinary slash-separated prose translatable', () => {
    const text = 'See raw/docs/codebase/openai-codex.md#L7-L15 and packages/core/package.json#L3, or /tmp/example.md; choose and/or combine, then pause/start.Could this work?';
    const masked = protectSpans(text);
    expect(masked.spans).toEqual([
      'raw/docs/codebase/openai-codex.md#L7-L15', 'packages/core/package.json#L3', '/tmp/example.md',
    ]);
    expect(masked.text).toContain('and/or combine');
    expect(masked.text).toContain('pause/start.Could this work?');
    expect(restoreSpans(masked.text, masked.spans)).toEqual({ text, missing: [] });
  });

  it('validates translated prose independently of indented English code', () => {
    const code = `   \`\`\`ts\n${'   const untranslatedIdentifier = "the English code remains unchanged";\n'.repeat(40)}   \`\`\``;
    const source = `${prose.repeat(12)}\n\n${code}\n\n${prose.repeat(12)}`;
    const work = plan(source);
    const segment = work.segments[0];
    const request = translationRequest(work, segment);
    const masked = protectSpans(segment.text.trim());
    const answer = masked.text.replace(/[A-Za-z][A-Za-z'’-]*/g, '译文');
    const finished = finishSegment(work, segment, request.spans, answer);
    expect(finished.ok).toBe(true);
    if (finished.ok) {
      expect(finished.body).toContain('untranslatedIdentifier');
      expect(detectTextLanguage(finished.body)).toBe('zh');
    }
    expect(finishSegment(work, segment, request.spans, masked.text)).toMatchObject({
      ok: false, error: expect.stringContaining('still in English'),
    });
    expect(finishSegment(work, segment, request.spans, answer.replace('⟦1⟧', ''))).toMatchObject({
      ok: false, error: expect.stringContaining('lost 1'),
    });
  });

  it('keeps a large fenced block whole while retaining unrelated segment hashes', () => {
    const before = `# Before\n\n${(prose.repeat(6) + '\n\n').repeat(18)}`;
    const code = `   \`\`\`ts\n${'   const source = "do not translate or split this protected code";\n'.repeat(220)}   \`\`\``;
    const after = `\n\n# After\n\n${(prose.repeat(6) + '\n\n').repeat(18)}`;
    const source = before + code + after;
    const work = plan(source, 'large.md');
    const indexedBody = work.segments.map((s) => s.text).join('');
    const codeStart = indexedBody.indexOf('   ```ts');
    const codeEnd = codeStart + code.length;
    expect(indexedBody.replace(/^\n/, '')).toBe(source);
    expect(work.segments.some((s) => s.text.includes(code))).toBe(true);
    expect(work.segments.every((s) => !(codeStart < s.end && s.end < codeEnd))).toBe(true);
    const unchanged = segmentText(indexedBody, 8_000).filter((s) => s.end <= codeStart || s.start >= codeEnd);
    expect(unchanged.length).toBeGreaterThan(0);
    expect(unchanged.every((s) => work.segments.some((next) => next.sha === s.sha))).toBe(true);
    expect(work.segments.filter((s) => s.end <= codeStart).length).toBeGreaterThan(0);
    for (const segment of work.segments) {
      const masked = protectSpans(segment.text.trim());
      expect(restoreSpans(masked.text, masked.spans).missing).toEqual([]);
      if (segment.text.includes(code)) expect(masked.text).not.toContain('const source');
    }
  });

  it('accepts translated bibliography titles while retaining Latin author names', () => {
    const authors = 'Shaoyou Lu, Shijie Li, Shuang Li, Shuxun Yang, Sibo Yi, Tianshu Yu, Wei Tian, Weihan Wang. ';
    const source = Array.from({ length: 12 }, (_, i) =>
      `[${i + 1}] ${authors}The authors present the design of the agent and the results of the evaluation.\n`).join('');
    const work = plan(source, 'references.md');
    const segment = work.segments[0];
    const request = translationRequest(work, segment);
    const translated = Array.from({ length: 12 }, (_, i) =>
      `[${i + 1}] ${authors}作者介绍了智能体的设计与评估结果。\n`).join('');
    expect(detectTextLanguage(translated)).toBe('en');
    expect(finishSegment(work, segment, request.spans, translated).ok).toBe(true);
    const unchanged = protectSpans(segment.text.trim()).text;
    expect(finishSegment(work, segment, request.spans,
      '参考文献与智能体研究设计及评估结果的完整中文说明\n\n' + unchanged)).toMatchObject({
      ok: false, error: expect.stringContaining('still in English'),
    });
  });

  it('accepts translated headers in a table made entirely of model identifiers', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `| GPT Model ${i} | gpt-${i}.1-sol |`).join('\n');
    const work = plan(`| Model | Model ID |\n| --- | --- |\n${rows}`, 'models.md');
    const segment = work.segments[0];
    const request = translationRequest(work, segment);
    expect(finishSegment(work, segment, request.spans,
      `| 模型 | 模型 ID |\n| --- | --- |\n${rows}`).ok).toBe(true);
  });

  it('does not count Python keywords as untranslated grammar in a fetched source listing', () => {
    const body = Array.from({ length: 12 }, (_, i) =>
      `if item_${i} is not None:\n    for value in values:\n        result_${i} = value\n        # The value is saved for the reader and the result is retained.\n`).join('\n');
    const work = plan(body, 'source.md');
    const segment = work.segments[0];
    const request = translationRequest(work, segment);
    const answer = segment.text.replace(/# The value is saved for the reader and the result is retained\./g,
      '# 为读者保存数值，并保留处理结果。');
    expect(finishSegment(work, segment, request.spans, answer).ok).toBe(true);
    expect(finishSegment(work, segment, request.spans,
      '这份代码展示了完整的处理流程与结果保存方式。\n' + segment.text)).toMatchObject({
      ok: false, error: expect.stringContaining('still in English'),
    });
  });

  it('recognizes numbered code listings extracted from papers', () => {
    const body = Array.from({ length: 12 }, (_, i) =>
      `${i * 3 + 1} from typing import Optional, List, Dict\n` +
      `${i * 3 + 2} final_response = {key: value for key, value in response.items() if value is not None}\n` +
      `${i * 3 + 3} # The response is retained and the output is available to the reader.\n`).join('\n');
    const work = plan(body, 'numbered-source.md');
    const segment = work.segments[0];
    const request = translationRequest(work, segment);
    const answer = segment.text.replace(/# The response is retained and the output is available to the reader\./g,
      '# 保留响应内容，并将输出提供给读者。');
    expect(finishSegment(work, segment, request.spans, answer).ok).toBe(true);
  });

  it('does not send unchanged code-only segments through the language test', () => {
    const work = plan(`${prose.repeat(3)}\n\n${'result = values.mean()\nreturn result\n\n'.repeat(8)}`, 'code-tail.md');
    const segment = { ...work.segments[0], text: 'def alpha_013(self):\nresult=((self.high-self.low)**0.5)-self.avg_price\nalpha=result.iloc[-1,:]\nreturn alpha.dropna()\n' };
    const request = translationRequest(work, segment);
    expect(finishSegment(work, segment, request.spans, segment.text).ok).toBe(true);
    expect(finishSegment(work, segment, request.spans, segment.text.replace('dropna()', 'fillna()'))).toMatchObject({ ok: false });
  });

  it('does not let repeated Latin filler turn a Chinese digest into English', () => {
    expect(detectTextLanguage('今天市场波动较大，请注意风险。\n\n' + 'ima'.repeat(4000))).toBe('zh');
  });

  it('reads Chinese commentary around flattened notebook code cells', () => {
    const code = '# %%frame = input.with_columns(column.cast(dtype));' + ' result = data.evaluate(model);'.repeat(80);
    expect(detectTextLanguage('这篇学习笔记解释宏观变量与市场状态，命名是断言而不是估计。\n\n' + code)).toBe('zh');
    expect(detectTextLanguage('# %% [markdown]# The market data is processed by the model and the analysis is available to the reader.')).toBe('en');
  });
});
