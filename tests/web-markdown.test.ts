import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A page's own parts in web/markdown.js: the folded frontmatter, footnote
 * markers and their notes, export anchors, workspace paths that open, and
 * the matcher the file view marks entity names with.
 */

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

interface Mention { id: string; name?: string; type?: string; surfaces: string[] }
interface Renderer {
  render: (md: string, opts?: { metadataOpen?: boolean }) => string;
  frontmatterSummary: (yaml: string) => string[];
  mentionMatcher: (mentions: Mention[]) => { empty: boolean; split: (text: string) => { text: string; mention?: Mention }[] };
}

function loadRenderer(): Renderer {
  const require = createRequire(import.meta.url);
  const markedUmd = path.join(path.dirname(require.resolve('marked')), 'marked.umd.js');
  const page = vm.createContext({});
  vm.runInContext(fs.readFileSync(markedUmd, 'utf8'), page);
  vm.runInContext(fs.readFileSync(path.join(webDir, 'markdown.js'), 'utf8'), page);
  return (page as { knodeMarkdown: Renderer }).knodeMarkdown;
}

const md = loadRenderer();

const PAGE = `---
type: person
title: 林舟
aliases: [舟哥, "Lin, Zhou"]
relations:
  authored: ["[[星海笔记]]", "[[断层法|the method]]"]
claims:
  - { statement: "a", type: style }
  - { statement: "b", type: rule }
sources:
  - raw/docs/a/2020-W40.md
  - raw/docs/a/2021-W01.md
  - raw/docs/a/2021-W02.md
research: { kind: entity, at: "2026-10-20" }
---
# 林舟

他常被称为舟哥[^1][^2]，见[^gone]。

- 列表里也引用[^2]

## 来源

[^1]: 知识星球 · 2020-10-21 · \`raw/docs/a/2020-10-21.md#e-f209693e\`
[^2]: 雪球 · **2021-06-20** ·
    \`raw/docs/a/2021-06-20.md#e-a82223fb\`
[^7]: 从未被引用
`;

describe('frontmatter', () => {
  it('folds into a metadata panel with a one-line summary, unfolded only when asked', () => {
    const html = md.render(PAGE);
    expect(html.startsWith('<details class="md-meta"><summary>')).toBe(true);
    expect(html).toContain('<span class="md-meta-sum">person · aliases 2 · relations 2 · claims 2 · sources 3</span>');
    expect(html).not.toContain('<details class="md-meta" open>');
    expect(md.render(PAGE, { metadataOpen: true })).toContain('<details class="md-meta" open>');
    // the body starts after it, as Markdown: no rule and no setext heading made of the YAML
    expect(html).not.toContain('<hr>');
    expect(html).toContain('<h1>林舟</h1>');
  });

  it('keeps the YAML as written, its wikilinks and workspace paths made links', () => {
    const html = md.render(PAGE, { metadataOpen: true });
    expect(html).toContain('<a class="wikilink" href="#" data-wikilink="星海笔记">[[星海笔记]]</a>');
    expect(html).toContain('<a class="wikilink" href="#" data-wikilink="断层法">[[断层法|the method]]</a>');
    expect(html).toContain('  - <a class="path-link" href="#" data-wikilink="raw/docs/a/2021-W01.md">raw/docs/a/2021-W01.md</a>\n');
    expect(html).toContain('research: { kind: entity, at: &quot;2026-10-20&quot; }');
  });

  it('summarises lists, flow lists and maps of lists, and never fails on half-written YAML', () => {
    expect(md.frontmatterSummary('type: "concept"\ntags: []\nsources:\n  - a\n  - b\n    - nested\nrelations:\n  cites: ["[[a]]", "[[b]]"]\n  uses: ["[[c]]"]')).toEqual(['concept', 'sources 2', 'relations 3']);
    expect(md.frontmatterSummary('title: x\naliases: [a, [b, c], "d, e"]')).toEqual(['aliases 3']);
    expect(md.frontmatterSummary('claims:\n  - {\n  - [broken')).toEqual(['claims 2']);
    expect(md.render('---\ntitle: only\n---\ntext')).toContain('<span class="md-meta-sum">1 line</span>');
  });

  it('is only the block that opens the file', () => {
    const html = md.render('text\n\n---\ntype: x\n---\n');
    expect(html).not.toContain('md-meta');
  });
});

describe('footnotes', () => {
  const html = md.render(PAGE);

  it('numbers markers by first citation and links each to its note', () => {
    expect(html).toContain('<sup class="fn-ref"><a href="#" data-fn="1" title="知识星球 · 2020-10-21 · raw/docs/a/2020-10-21.md#e-f209693e">[1]</a></sup>');
    expect(html).toContain('<sup class="fn-ref"><a href="#" data-fn="2" title="雪球 · 2021-06-20 · raw/docs/a/2021-06-20.md#e-a82223fb">[2]</a></sup>');
    // a second citation of the same note shows the same number
    expect(html.match(/data-fn="2"/g)).toHaveLength(2);
    // a marker with no note stays text
    expect(html).toContain('见[^gone]。');
  });

  it('lists the notes where they were written, one per line, sources clickable, each with a way back', () => {
    const list = html.slice(html.indexOf('<h2>来源</h2>'));
    expect(list.startsWith('<h2>来源</h2>\n<section class="footnotes"><ol>')).toBe(true);
    expect(list.match(/<li class="fn"/g)).toHaveLength(3);
    expect(list).toContain('<li class="fn" data-fn-def="1"><span class="fn-num">[1]</span><span class="fn-body">知识星球 · 2020-10-21 · <a class="path-link" href="#" data-wikilink="raw/docs/a/2020-10-21.md#e-f209693e" title="raw/docs/a/2020-10-21.md#e-f209693e"><code>…/a/2020-10-21.md#e-f209693e</code></a></span><a href="#" class="fn-back" data-fn-back="1" title="Back to the text">↩</a></li>');
    // an indented line continues its note, and the note keeps its formatting
    expect(list).toContain('雪球 · <strong>2021-06-20</strong> · <a class="path-link"');
    // a note nothing cites is still listed, last, with no way back
    expect(list).toContain('<li class="fn" data-fn-def="7"><span class="fn-num">[3]</span><span class="fn-body">从未被引用</span></li>');
    expect(html).not.toContain('[^1]:');
  });

  it('gathers notes written apart at the end, as GitHub does', () => {
    const scattered = md.render('A[^a].\n\n[^a]: note a\n\nB.\n\n[^b]: note b');
    expect(scattered).toMatch(/<p>B\.<\/p>\n<section class="footnotes">/);
    expect(scattered.match(/<li class="fn"/g)).toHaveLength(2);
  });

  it('leaves text without notes alone', () => {
    expect(md.render('a [^1] b')).toBe('<p>a [^1] b</p>\n');
    expect(md.render('array[^0]')).toBe('<p>array[^0]</p>\n');
  });
});

describe('workspace paths and anchors', () => {
  it('opens a raw/ or wiki/ path written as code, and leaves other code alone', () => {
    expect(md.render('`wiki/concepts/x.md`')).toContain('<a class="path-link" href="#" data-wikilink="wiki/concepts/x.md" title="wiki/concepts/x.md"><code>wiki/concepts/x.md</code></a>');
    expect(md.render('`npm run raw/x`')).toBe('<p><code>npm run raw/x</code></p>\n');
    expect(md.render('`raw/"onclick=x.md`')).not.toContain('path-link');
  });

  const pathLink = (p: string) => `<a class="path-link" href="#" data-wikilink="${p}">${p}</a>`;

  it('opens a workspace path written as plain text, as research pages cite, and reads as written', () => {
    const a = 'raw/docs/research/五家/files/2026-04-03-www1-hkexnews-hk-2026040801181.pdf';
    const b = 'raw/docs/content-markdown/舒九__d8191118556d/zsxq/唯有业绩永恒__54f6ae47272e/2024/2024-06-19.md';
    expect(md.render(`收入增长。（来源：${a}；${b}）`)).toBe(`<p>收入增长。（来源：${pathLink(a)}；${pathLink(b)}）</p>\n`);
    expect(md.render(`- ${a}\n- ${b}`)).toBe(`<ul>\n<li>${pathLink(a)}</li>\n<li>${pathLink(b)}</li>\n</ul>\n`);
    expect(md.render('Revenue grew (Source: raw/docs/a.md; wiki/research/b.md#e-1f).')).toBe(`<p>Revenue grew (Source: ${pathLink('raw/docs/a.md')}; ${pathLink('wiki/research/b.md#e-1f')}).</p>\n`);
    expect(md.render('| 公司 | 来源 |\n|---|---|\n| 寒武纪 | raw/docs/c.pdf |')).toContain(`<td>${pathLink('raw/docs/c.pdf')}</td>`);
    expect(md.render('见raw/docs/a.md。')).toBe(`<p>见${pathLink('raw/docs/a.md')}。</p>\n`);
  });

  it('splits paths a claim in the metadata lists together', () => {
    const html = md.render('---\nclaims:\n  - {"statement":"x","source":"raw/docs/a.pdf；raw/docs/b.pdf"}\n---\n正文', { metadataOpen: true });
    expect(html).toContain(`&quot;source&quot;:&quot;${pathLink('raw/docs/a.pdf')}；${pathLink('raw/docs/b.pdf')}&quot;}`);
  });

  it('keeps a parenthesis inside a name while its pair is there too', () => {
    const p = 'raw/docs/content-markdown/AI产业链（光+存）__df3dc76c1c5d/2026/2026-W45.md';
    expect(md.render(`（来源：${p}）`)).toBe(`<p>（来源：${pathLink(p)}）</p>\n`);
    expect(md.render('(see raw/docs/report(1).pdf)')).toBe(`<p>(see ${pathLink('raw/docs/report(1).pdf')})</p>\n`);
    // a space ends it, and what comes before is no file
    expect(md.render('(see raw/docs/report (1).pdf)')).not.toContain('path-link');
  });

  it('leaves a path that does not start a word, one already a link, and code alone', () => {
    expect(md.render('x/raw/docs/a.md and xraw/docs/a.md')).toBe('<p>x/raw/docs/a.md and xraw/docs/a.md</p>\n');
    expect(md.render('a raw/derived export and raw/ranked/z-scored data under raw/docs/research/...')).not.toContain('path-link');
    expect(md.render('https://example.com/raw/docs/a.md')).not.toContain('path-link');
    expect(md.render('[raw/docs/a.md](https://example.com/x)')).toBe('<p><a href="https://example.com/x">raw/docs/a.md</a></p>\n');
    expect(md.render('[[raw/docs/a.md]] then raw/')).toBe('<p><a class="wikilink" href="#" data-wikilink="raw/docs/a.md">a</a> then raw/</p>\n');
    expect(md.render('```\nraw/docs/a.md\n```')).not.toContain('path-link');
    expect(md.render('**raw/docs/a.md**')).toBe(`<p><strong>${pathLink('raw/docs/a.md')}</strong></p>\n`);
  });

  it('turns an export entry anchor into a marker a link can land on', () => {
    const html = md.render('---\n\n<a id="e-32817015"></a>\n## 09:06 · 舒九\n\n正文\n\n<a id="e-121bbd7c"></a>\n### 09:10 · 回复\n');
    expect(html).toContain('<span class="md-anchor" data-anchor="e-32817015"></span><h2>09:06 · 舒九</h2>');
    expect(html).toContain('<span class="md-anchor" data-anchor="e-121bbd7c"></span><h3>09:10 · 回复</h3>');
    expect(html).not.toContain('&lt;a id');
  });
});

describe('mentionMatcher', () => {
  const matcher = md.mentionMatcher([
    { id: 'car', surfaces: ['比亚迪汽车'] },
    { id: 'byd', surfaces: ['比亚迪', 'BYD'] },
    { id: 'apple', surfaces: ['Apple'] },
  ]);
  const marked = (text: string) => matcher.split(text).map((p) => (p.mention ? `[${p.text}:${p.mention.id}]` : p.text)).join('');

  it('marks the longest name where several start at one place', () => {
    expect(marked('比亚迪汽车和比亚迪')).toBe('[比亚迪汽车:car]和[比亚迪:byd]');
  });

  it('marks Latin names as whole words only', () => {
    expect(marked('BYD、Pineapple 与 Apple。BYDs')).toBe('[BYD:byd]、Pineapple 与 [Apple:apple]。BYDs');
  });

  it('keeps the text whole and says when it has nothing to look for', () => {
    const text = '没有任何实体 at all';
    expect(matcher.split(text).map((p) => p.text).join('')).toBe(text);
    expect(md.mentionMatcher([]).empty).toBe(true);
    expect(md.mentionMatcher([{ id: 'x', surfaces: [''] }]).empty).toBe(true);
  });
});
