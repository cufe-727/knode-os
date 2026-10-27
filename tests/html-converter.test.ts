import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { convertDocumentToMarkdown, isConvertibleFile } from '../src/ingest/convert.js';
import { captureComment, htmlToMarkdown, readCaptureComment } from '../src/ingest/converters/html.js';

/**
 * The HTML converter (src/ingest/converters/html.ts): a saved page or an SEC
 * filing as readable Markdown — main content only, tables as grids with the
 * financial-statement cell splits folded back, links absolute — and what the
 * page says about itself in the frontmatter.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-html-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ARTICLE = `<!doctype html><html lang="en"><head><title>Anthropic files | News Co</title>
<meta property="og:title" content="Anthropic files for an IPO"><meta property="og:site_name" content="News Co">
<script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","datePublished":"2026-06-01T12:00:00Z","author":{"name":"A. Reporter"}}]}</script>
<link rel="canonical" href="/news/anthropic-ipo"><style>.x{}</style></head>
<body><header class="site-header"><nav>Home | Markets</nav></header><div class="cookie-banner">We use cookies to improve your experience</div>
<article><header><h1>Anthropic files for an IPO</h1></header>
<p>Anthropic <b>confidentially</b> submitted a <a href="/docs/s1">draft S-1</a> to the <a href="https://www.sec.gov">SEC</a>, see <a href="//cdn.example.com/x">x</a>.<br>Second line.</p>
<ul><li>One<ol><li>One.a</li></ol></li><li>Two <a href="javascript:alert(1)">bad</a></li></ul>
<blockquote><p>A quote here.</p></blockquote><pre><code>let x = 1;
  y();</code></pre>
</article><footer>© News Co</footer><script>track()</script></body></html>`;

describe('htmlToMarkdown', () => {
  it('keeps the article, drops the chrome, and reads the page\'s own metadata', () => {
    const r = htmlToMarkdown(ARTICLE, { baseUrl: 'https://news.example.com/a/b' });
    expect(r.markdown).toContain('# Anthropic files for an IPO');
    expect(r.markdown).toContain('Anthropic **confidentially** submitted a [draft S-1](https://news.example.com/docs/s1) to the [SEC](https://www.sec.gov/), see [x](https://cdn.example.com/x).  \nSecond line.');
    expect(r.markdown).toContain('- One\n  1. One.a\n- Two bad');
    expect(r.markdown).toContain('> A quote here.');
    expect(r.markdown).toContain('```\nlet x = 1;\n  y();\n```');
    for (const gone of ['Home | Markets', 'cookies', '© News Co', 'track()', '.x{}', 'javascript']) expect(r.markdown).not.toContain(gone);
    expect(r.meta).toMatchObject({ title: 'Anthropic files for an IPO', author: 'A. Reporter', siteName: 'News Co', canonical: 'https://news.example.com/news/anthropic-ipo', lang: 'en' });
    expect(r.meta.published).toMatch(/^2026-06-01/);
    expect(r.outline).toEqual([{ level: 1, text: 'Anthropic files for an IPO', line: 1 }]);
    expect(r.links).toBe(3);
  });

  it('turns tables into grids and folds the cells a financial statement splits a number into', () => {
    const r = htmlToMarkdown(`<table><thead><tr><th>Year</th><th colspan="2">Revenue</th></tr></thead><tbody>
      <tr><td>2024</td><td>$</td><td>0.9</td></tr><tr><td>2025</td><td>$</td><td>4.5</td></tr><tr><td>Net loss</td><td>(12</td><td>)</td></tr></tbody></table>
      <table><tr><td>Name</td><td>Role</td></tr><tr><td>A | B</td><td>CEO</td></tr></table>
      <table><tr><td>Only one column</td></tr><tr><td>Second row of the same column</td></tr></table>`);
    expect(r.markdown).toContain('| Year | Revenue |\n| --- | --- |\n| 2024 | $0.9 |\n| 2025 | $4.5 |\n| Net loss | (12) |');
    expect(r.markdown).toContain('| Name | Role |\n| --- | --- |\n| A \\| B | CEO |');
    expect(r.markdown).toContain('Only one column\n\nSecond row of the same column');
    expect(r.tables).toBe(2);
  });

  it('reads an SEC-style filing: the hidden XBRL header out, inline XBRL in, bullet tables as lists', () => {
    const r = htmlToMarkdown(`<html><body><div style="display: none"><ix:header><ix:references>dei:EntityCentralIndexKey 0001</ix:references></ix:header></div>
      <p style="text-align:center"><b>PROSPECTUS SUMMARY</b><p>Revenue was <ix:nonFraction name="us-gaap:Revenues">1,234</ix:nonFraction> million&#160;in&nbsp;2025 &amp; grew.
      <table><tr><td></td><td>Year Ended</td><td></td></tr><tr><td>Revenue</td><td>$</td><td>1,234</td><td></td></tr><tr><td>Net loss</td><td>(</td><td>567</td><td>)</td></tr></table>
      <table><tr><td>•</td><td>We face competition.</td></tr><tr><td>•</td><td>Compute is costly.</td></tr></table></div></body></html>`);
    expect(r.markdown).not.toContain('EntityCentralIndexKey');
    // a page with no headings of its own: a bold one-line paragraph is a section title
    expect(r.markdown).toContain('## PROSPECTUS SUMMARY');
    expect(r.markdown).toContain('Revenue was 1,234 million in 2025 & grew.');
    expect(r.markdown).toContain('|   | Year Ended |\n| --- | --- |\n| Revenue | $1,234 |\n| Net loss | (567) |');
    expect(r.markdown).toContain('- We face competition.\n- Compute is costly.');
  });

  it('joins a filing printed to HTML line by line back into paragraphs, its bold lines into headings', () => {
    const line = (top: number, ...runs: [string, boolean?][]) => `<div style="font-size:12pt;line-height:7.18pt;position:absolute;top:${top}pt;width:612pt">${runs
      .map(([t, bold], i) => `<font style="font-size:9.5pt;font-weight:${bold ? 'bold' : 'normal'};left:${72 + i * 100}pt;position:absolute;white-space:pre">${t}</font>`).join('')}</div>`;
    const page = `<!DOCUMENT>\n<TYPE>S-1\n<TEXT>\n<html><body><div style="--position:absolute;font-size:0;height:792pt;position:relative;width:612pt"><div>
      ${line(100, ['How We Generate Revenue', true])}
      ${line(124, ['“', false], ['Run-Rate Revenue', true], ['” is an operating metric that refers to the estimated annualized value of our revenue-', false])}
      ${line(135.4, ['generating activity as of a measurement date.', false])}
      ${line(159.8, ['A second paragraph starts after a wider gap.', false])}
      ${line(171.2, ['2025', true])}
      </div></div></body></html>`;
    const r = htmlToMarkdown(page);
    expect(r.markdown).toContain('### How We Generate Revenue');
    expect(r.markdown).toContain('“**Run-Rate Revenue**” is an operating metric that refers to the estimated annualized value of our revenue-generating activity as of a measurement date.');
    expect(r.markdown).toContain('\n\nA second paragraph starts after a wider gap.');
    expect(r.markdown).not.toContain('## 2025');
    expect(r.markdown).not.toMatch(/TYPE|S-1\n/);
    expect(r.outline.map((h) => h.text)).toEqual(['How We Generate Revenue']);
  });

  it('escapes text that would read as Markdown structure, and decodes entities', () => {
    const r = htmlToMarkdown('<p>1. Not a list</p><p># not a heading</p><p>- not a bullet</p><p>&lt;b&gt; &eacute;t&eacute; &#x2014; &#8217; &copy;</p>');
    expect(r.markdown).toContain('1\\. Not a list');
    expect(r.markdown).toContain('\\# not a heading');
    expect(r.markdown).toContain('\\- not a bullet');
    expect(r.markdown).toContain('<b> été — ’ ©');
  });

  it('says when a page is an empty shell rendered by script', () => {
    const r = htmlToMarkdown('<html><head><title>App</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    expect(r.markdown).toBe('');
    expect(r.warnings.join(' ')).toMatch(/app shell/);
  });

  it('converts a few megabytes of filing in well under a few seconds', () => {
    const big = `<html><body><table>${Array.from({ length: 20_000 }, (_, i) => `<tr><td>Row ${i}</td><td>$</td><td>${i * 3},000</td><td>note &amp; more</td></tr>`).join('')}</table>${'<p>Paragraph text of the filing.</p>'.repeat(20_000)}</body></html>`;
    expect(big.length).toBeGreaterThan(1_500_000);
    const t0 = Date.now();
    const r = htmlToMarkdown(big);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.markdown).toContain('| Row 19999 | $59997,000 | note & more |');
  });
});

describe('the capture record', () => {
  it('round-trips, cannot be closed early, and reads a browser\'s saved-from mark', () => {
    const c = { url: 'https://www.sec.gov/x', fetched: '2026-10-27T00:00:00.000Z', by: 'agent/codex-cli', why: 'the S-1 --> really' };
    const line = captureComment(c);
    expect(line.endsWith(' -->\n')).toBe(true);
    expect(line.slice(0, -5)).not.toContain('-->');
    expect(readCaptureComment(`${line}<html></html>`)).toEqual(c);
    expect(readCaptureComment('<!-- saved from url=(0023)https://example.com/ -->\n<html>')).toEqual({ url: 'https://example.com/' });
    expect(readCaptureComment('<html><body>no record</body></html>')).toBeNull();
  });
});

describe('the converter', () => {
  it('is how a .html original under raw/docs becomes Markdown, with its provenance', async () => {
    expect(isConvertibleFile('raw/docs/a.htm')).toBe(true);
    expect(isConvertibleFile('raw/docs/a.html')).toBe(true);
    const file = path.join(tmp, 'a.html');
    fs.writeFileSync(file, captureComment({ url: 'https://news.example.com/a/b', fetched: '2026-10-27T01:02:03.000Z', by: 'agent/codex-cli' }) + ARTICLE);
    const r = await convertDocumentToMarkdown(file, 'raw/docs/research/x/web/a.html');
    expect(r.kind).toBe('html-readable');
    expect(r.markdown).toMatch(/^---\ntitle: "Anthropic files for an IPO"\nsource: "raw\/docs\/research\/x\/web\/a.html"\nsource_type: "html"\nconversion: "html-readable"\nconversion_model: "knode-html"\n/);
    expect(r.markdown).toContain('url: "https://news.example.com/a/b"');
    expect(r.markdown).toContain('fetched: "2026-10-27T01:02:03.000Z"');
    expect(r.markdown).toMatch(/published: "2026-06-01/);
    expect(r.markdown).toContain('[draft S-1](https://news.example.com/docs/s1)');
  });
});
