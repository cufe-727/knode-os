import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Charts in Markdown (web/chart.js): a ```chart block's JSON read leniently,
 * drawn as a figure the page's policy allows — every string escaped, no
 * inline style, handler or id — with its numbers in a table, and wired into
 * web/markdown.js. Loaded the way the page loads them: plain scripts sharing
 * one global, next to marked.
 */

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

interface Series { name: string; values: (number | null)[] }
interface Spec { type: string; title: string; subtitle: string; unit: string; x: string[]; series: Series[]; source: string; note: string }
interface Chart {
  parse: (text: string) => { spec: Spec | null; errors: string[] };
  render: (text: string) => string;
  hydrate: (root?: unknown) => void;
}

function load(withChart = true): { chart: Chart; md: { render: (text: string) => string } } {
  const require = createRequire(import.meta.url);
  const markedUmd = path.join(path.dirname(require.resolve('marked')), 'marked.umd.js');
  const page = vm.createContext({});
  vm.runInContext(fs.readFileSync(markedUmd, 'utf8'), page);
  if (withChart) vm.runInContext(fs.readFileSync(path.join(webDir, 'chart.js'), 'utf8'), page);
  vm.runInContext(fs.readFileSync(path.join(webDir, 'markdown.js'), 'utf8'), page);
  const g = page as { knodeChart: Chart; knodeMarkdown: { render: (text: string) => string } };
  return { chart: g.knodeChart, md: g.knodeMarkdown };
}

const { chart, md } = load();
const spec = (o: Record<string, unknown>) => JSON.stringify({ title: 'T', ...o });
/** A plain copy of what the vm context returned, so equality does not trip over the other realm's prototypes. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const count = (html: string, re: RegExp) => html.match(re)?.length ?? 0;

/** The geometry render hands `hydrate`, read back off the SVG. */
function geometry(html: string): { k: string; plot: [number, number, number, number]; at: number[]; y?: (number | null)[][] } {
  return JSON.parse(unescape(/ data-kc="([^"]*)"/.exec(html)![1]));
}
const viewBox = (html: string) => / viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(html)!.slice(1).map(Number);

/** The extent of a bar's path (M, L, H, V, A and Z, all absolute). */
function pathBox(d: string): { x0: number; y0: number; x1: number; y1: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [, cmd, args] of d.matchAll(/([MLHVAZ])([^MLHVAZ]*)/g)) {
    const n = (args.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/g) ?? []).map(Number);
    if (cmd === 'M' || cmd === 'L') { xs.push(n[0]); ys.push(n[1]); }
    if (cmd === 'H') xs.push(n[0]);
    if (cmd === 'V') ys.push(n[0]);
    if (cmd === 'A') { xs.push(n[5]); ys.push(n[6]); }
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

interface Label { cls: string; x: number; y: number; anchor: string; text: string }
function labels(html: string, cls: string): Label[] {
  return [...html.matchAll(/<text class="([^"]*)" x="([^"]*)" y="([^"]*)"(?: text-anchor="([^"]*)")?>([^<]*)/g)]
    .filter((m) => m[1].split(' ').includes(cls))
    .map((m) => ({ cls: m[1], x: Number(m[2]), y: Number(m[3]), anchor: m[4] ?? 'start', text: unescape(m[5]) }));
}
/** How wide a label sets, about: half an em per Latin character, a full em for CJK, at the chart's 11px. */
const setWidth = (s: string) => [...s].reduce((w, ch) => w + (/[ᄀ-￿]/.test(ch) ? 11 : 5.5), 0);
function extent(l: Label): [number, number] {
  const w = setWidth(l.text);
  return l.anchor === 'middle' ? [l.x - w / 2, l.x + w / 2] : l.anchor === 'end' ? [l.x - w, l.x] : [l.x, l.x + w];
}

/** Every attribute name in the markup, tag by tag. */
function attributeNames(html: string): string[] {
  const names: string[] = [];
  for (const [, attrs] of html.matchAll(/<[a-zA-Z][\w-]*((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g)) {
    for (const [, name] of attrs.matchAll(/\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g)) names.push(name.toLowerCase());
  }
  return names;
}

const REVENUE = {
  type: 'bar',
  title: 'Annualized revenue run-rate',
  subtitle: 'USD billions, company statements',
  unit: 'USD bn',
  x: ['2024-12', '2025-05', '2025-08', '2026-03'],
  series: [{ name: 'Run-rate', values: [1, 3, 5, 19] }],
  source: 'raw/docs/research/a.html; https://example.com/report',
  note: 'Run-rate = latest month × 12.',
};
const MONTHS = ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12'];
const TYPES = ['bar', 'line', 'area', 'stacked-bar', 'hbar', 'share', 'scatter', 'waterfall', 'timeline'];

/** A memory-industry comparison, in the four types made for it. */
const DRAM = {
  type: 'share', title: 'DRAM revenue share', unit: '%', x: ['2024', '2025'],
  series: [{ name: 'Samsung', values: [41.1, 34.1] }, { name: 'SK hynix', values: [34.4, 36.5] }, { name: 'Micron', values: [21.5, 23.5] }, { name: 'Others', values: [3, 5.9] }],
  source: 'raw/docs/research/memory/files/trendforce.pdf',
};
const SHARE_USD = {
  type: 'share', title: 'HBM revenue, as shares', unit: 'USD bn', x: ['2024', '2025'],
  series: [{ name: 'SK hynix', values: [10.5, 22] }, { name: 'Samsung', values: [5.2, 8.4] }, { name: 'Micron', values: [1.6, 6.1] }],
  source: 'raw/docs/x.pdf',
};
const VALUATION = {
  type: 'scatter', title: 'Valuation against growth', x: ['SK hynix', 'Samsung', 'Micron', 'Kioxia', 'CXMT'],
  series: [{ name: 'Revenue growth, %', values: [48, 22, 41, 30, null] }, { name: 'Forward P/E, ×', values: [7.5, 11.2, 9.8, 12.5, 30] }],
  source: 'raw/docs/research/memory/files/consensus.csv',
};
const BRIDGE = {
  type: 'waterfall', title: 'Gross margin walk', unit: 'pp', x: ['Q2 2026', 'DRAM price', 'NAND price', 'Costs', 'Q3 2026'],
  series: [{ name: 'Gross margin', values: [38.5, 6.2, -1.4, -0.9, 42.4] }],
  source: 'raw/docs/research/memory/files/q3.pdf',
};
const HBM = {
  type: 'timeline', title: 'HBM generations', x: ['HBM3E', 'HBM4', 'HBM4E'],
  series: [{ name: 'SK hynix', values: ['2024-03', '2025-Q4', 2027] }, { name: 'Samsung', values: ['2024-Q4', '2026-H1', null] }],
  source: 'raw/docs/research/memory/web/roadmaps.html',
};

describe('parse', () => {
  it('normalizes a valid spec: type defaulted, categories as text, numeric strings as numbers, unknown keys ignored', () => {
    const { spec: got, errors } = chart.parse(`\n  ${JSON.stringify({
      title: '  Run-rate ', unit: 'USD bn', x: [2024, '2025'], series: [{ name: 'A', values: [1, '12'] }], colour: 'red',
    })}  \n`);
    expect(errors).toEqual([]);
    expect(plain(got)).toEqual({
      type: 'bar', title: 'Run-rate', subtitle: '', unit: 'USD bn', x: ['2024', '2025'],
      series: [{ name: 'A', values: [1, 12] }], source: '', note: '',
    });
    expect(chart.parse(spec({ type: ' Stacked-Bar ', x: ['a'], series: [{ name: 'A', values: [1] }] })).spec?.type).toBe('stacked-bar');
  });

  it('draws an unknown type as a bar chart, and says so', () => {
    const { spec: got, errors } = chart.parse(spec({ type: 'pie', x: ['a', 'b'], series: [{ name: 'A', values: [1, 2] }] }));
    expect(got?.type).toBe('bar');
    expect(errors.join('\n')).toMatch(/"type" "pie" is not one of bar, line, area, stacked-bar, hbar/);
  });

  it('pads a short series with gaps and trims a long one, and says so', () => {
    const { spec: got, errors } = chart.parse(spec({ x: ['a', 'b', 'c'], series: [{ name: 'Short', values: [1] }, { name: 'Long', values: [1, 2, 3, 4] }] }));
    expect(plain(got?.series)).toEqual([{ name: 'Short', values: [1, null, null] }, { name: 'Long', values: [1, 2, 3] }]);
    expect(errors).toContain('Series "Short" has 1 value for 3 categories; the missing ones are gaps.');
    expect(errors).toContain('Series "Long" has 4 values for 3 categories; the extra ones are left out.');
  });

  it('keeps eight series at most: a ninth colour is never invented', () => {
    const series = Array.from({ length: 10 }, (_, k) => ({ name: `S${k + 1}`, values: [k] }));
    const { spec: got, errors } = chart.parse(spec({ x: ['a'], series }));
    expect(got?.series.map((s) => s.name)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
    expect(errors).toContain('A chart holds at most 8 series; the last 2 are left out.');
  });

  it('coerces numeric strings as the server\'s validator does, and shows anything else that is not a number as a gap', () => {
    const { spec: got, errors } = chart.parse(spec({
      x: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
      series: [{ name: 'Mixed', values: ['12', ' 3.5 ', '-1e3', '1,234.5', '', 'abc', true, {}, '12%'] }],
    }));
    expect(plain(got?.series[0].values)).toEqual([12, 3.5, -1000, 1234.5, null, null, null, null, null]);
    // an empty string is a gap, as null is; the rest are reported
    expect(errors).toEqual(['Series "Mixed": values 6, 7, 8, 9 are not numbers, shown as gaps.']);
    // JSON's own overflow is not a finite number either
    expect(chart.parse(spec({ x: ['a', 'b'], series: [{ name: 'A', values: [1e999, 2] }] })).spec?.series[0].values[0]).toBeNull();
  });

  it('wants a title, and still draws without one', () => {
    const { spec: got, errors } = chart.parse(JSON.stringify({ x: ['a'], series: [{ name: 'A', values: [1] }] }));
    expect(got).not.toBeNull();
    expect(errors).toEqual(['The chart has no "title".']);
  });

  it('draws nothing without categories, series or values, and says why', () => {
    const cases: [string, RegExp][] = [
      ['', /empty/],
      ['{"title": "T", "x": [1], ', /not valid JSON/],
      ['[1, 2]', /must be one JSON object/],
      [spec({ x: [], series: [{ name: 'A', values: [] }] }), /"x" is empty/],
      [spec({ series: [{ name: 'A', values: [1] }] }), /has no "x"/],
      [spec({ x: ['a'] }), /has no "series"/],
      [spec({ x: ['a'], series: [] }), /"series" is empty/],
      [spec({ x: ['a'], series: ['nope'] }), /nothing to draw/],
      [spec({ x: ['a', 'b'], series: [{ name: 'A', values: [null, 'x'] }] }), /Every value is empty/],
    ];
    for (const [text, why] of cases) {
      const { spec: got, errors } = chart.parse(text);
      expect(got, text).toBeNull();
      expect(errors.join('\n'), text).toMatch(why);
    }
  });
});

describe('render', () => {
  it('draws one thin bar per category in the series colour, with the numbers as a table', () => {
    const html = chart.render(JSON.stringify(REVENUE));
    expect(html.startsWith('<figure class="kchart kchart-bar"')).toBe(true);
    expect(count(html, /<path class="kc-bar kc-s1"/g)).toBe(4);
    expect(html).toContain('role="img" aria-label="Bar chart: Annualized revenue run-rate, 4 categories, 1 series"');
    expect(html).toContain('<title>Annualized revenue run-rate</title><desc>4 categories, 2024-12 to 2026-03. Run-rate 1 to 19 USD bn.</desc>');
    expect(html).toContain('<span class="kchart-title">Annualized revenue run-rate</span><span class="kchart-subtitle">USD billions, company statements</span>');
    expect(html).toContain('<p class="kchart-source"><span class="kchart-label">Source</span> raw/docs/research/a.html; https://example.com/report</p>');
    expect(html).toContain('<p class="kchart-note"><span class="kchart-label">Note</span> Run-rate = latest month × 12.</p>');
    // one series needs no legend: the title names it
    expect(html).not.toContain('kchart-legend');
    // the table: a header row, then a row per category, every value in full
    const table = html.slice(html.indexOf('<details class="kchart-data">'));
    expect(table).toContain('<summary>Data</summary>');
    expect(table).toContain('<caption>Values in USD bn</caption><thead><tr><th scope="col">Category</th><th scope="col" class="kc-num">Run-rate</th></tr></thead>');
    expect(count(table, /<tr><th scope="row">/g)).toBe(4);
    expect(table).toContain('<tr><th scope="row">2026-03</th><td class="kc-num">19</td></tr>');
    // labelled sparingly: the last value, which is also the largest, and nothing else
    expect(labels(html, 'kc-value').map((l) => l.text)).toEqual(['19']);
  });

  it('rounds a bar\'s data end and keeps its baseline end square', () => {
    const html = chart.render(spec({ x: ['up', 'down'], series: [{ name: 'A', values: [4, -2] }] }));
    const [up, down] = [...html.matchAll(/<path class="kc-bar kc-s1"[^>]* d="([^"]*)"/g)].map((m) => m[1]);
    const { plot } = geometry(html);
    const zeroY = Number(/<line class="kc-axis" x1="[^"]*" x2="[^"]*" y1="([^"]*)"/.exec(html)![1]);
    expect(zeroY).toBeGreaterThan(plot[1]);
    expect(zeroY).toBeLessThan(plot[3]);
    // the positive bar starts square at the baseline and rounds its top; the negative one hangs from it
    expect(up).toMatch(new RegExp(`^M[\\d.]+,${zeroY}V`));
    expect(up).toContain('A4,4 0 0 1');
    expect(pathBox(up).y1).toBe(zeroY);
    expect(down).toMatch(new RegExp(`^M[\\d.]+,${zeroY}H`));
    expect(pathBox(down).y0).toBe(zeroY);
  });

  it('groups two series, adjacent bars a 2px surface gap apart, with a legend', () => {
    const html = chart.render(JSON.stringify({ ...REVENUE, series: [...REVENUE.series, { name: 'Peer', values: [2, 4, 6, 8] }] }));
    expect(html).toContain('<ul class="kchart-legend" aria-label="Legend"><li><span class="kchart-key kchart-key-box kc-s1" aria-hidden="true"></span>Run-rate</li><li><span class="kchart-key kchart-key-box kc-s2" aria-hidden="true"></span>Peer</li></ul>');
    expect(count(html, /class="kc-bar kc-s1"/g)).toBe(4);
    expect(count(html, /class="kc-bar kc-s2"/g)).toBe(4);
    const a = pathBox(/class="kc-bar kc-s1" data-i="0"[^>]* d="([^"]*)"/.exec(html)![1]);
    const b = pathBox(/class="kc-bar kc-s2" data-i="0"[^>]* d="([^"]*)"/.exec(html)![1]);
    expect(Math.round((b.x0 - a.x1) * 10) / 10).toBe(2);
    expect(a.x1 - a.x0).toBeLessThanOrEqual(24);
    // grouped bars carry no number on each bar: the legend, the tooltip and the table do
    expect(labels(html, 'kc-value')).toEqual([]);
    expect(count(html, /<tr><th scope="row">/g)).toBe(4);
  });

  it('stacks segments a 2px gap apart, rounds only the top one, and leaves negatives out with a note', () => {
    const html = chart.render(spec({ type: 'stacked-bar', x: ['2024', '2025', '2026'], series: [{ name: 'Cloud', values: [20, 30, 40] }, { name: 'Ads', values: [10, -5, 12] }] }));
    expect(count(html, /class="kc-bar kc-s1"/g)).toBe(3);
    expect(count(html, /class="kc-bar kc-s2"/g)).toBe(2);
    const bottom = /class="kc-bar kc-s1" data-i="0"[^>]* d="([^"]*)"/.exec(html)![1];
    const top = /class="kc-bar kc-s2" data-i="0"[^>]* d="([^"]*)"/.exec(html)![1];
    expect(bottom).not.toContain('A'); // square: the stack goes on above it
    expect(top).toContain('A'); // the data end of the whole stack
    expect(Math.round((pathBox(bottom).y0 - pathBox(top).y1) * 10) / 10).toBe(2);
    // where the negative was left out, the remaining segment is the top and rounds
    expect(/class="kc-bar kc-s1" data-i="1"[^>]* d="([^"]*)"/.exec(html)![1]).toContain('A');
    expect(html).toContain('<p class="kchart-note">1 negative value is left out of the stacks; the data table lists it.</p>');
    expect(html).toContain('<td class="kc-num">' + (-5).toLocaleString() + '</td>');
    // two to four series also wear their names beside the last column
    expect(labels(html, 'kc-name').map((l) => l.text)).toEqual(['Cloud', 'Ads']);
    expect(geometry(html)).toMatchObject({ k: 'stacked-bar' });
  });

  it('lifts a line at a gap and starts it again after', () => {
    const html = chart.render(spec({ type: 'line', x: ['a', 'b', 'c', 'd', 'e'], series: [{ name: 'A', values: [1, 2, null, 4, 5] }] }));
    const d = /<path class="kc-line kc-s1" d="([^"]*)"/.exec(html)![1];
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d).toMatch(/^M[\d.]+,[\d.]+L[\d.]+,[\d.]+M[\d.]+,[\d.]+L[\d.]+,[\d.]+$/);
    expect(geometry(html).y?.[0][2]).toBeNull();
    // the last point wears an end dot and its value
    expect(count(html, /<circle class="kc-dot kc-s1"/g)).toBe(1);
    expect(labels(html, 'kc-value').map((l) => l.text)).toEqual(['5']);
    // a point alone between gaps draws no line, so it gets a dot of its own
    const lone = chart.render(spec({ type: 'line', x: ['a', 'b', 'c', 'd'], series: [{ name: 'A', values: [1, null, 3, null] }] }));
    expect(count(lone, /<circle class="kc-dot kc-s1"/g)).toBe(2);
  });

  it('washes an area down to zero under each unbroken run, and names two to four series at their ends', () => {
    const html = chart.render(spec({ type: 'area', x: MONTHS.slice(0, 5), series: [{ name: 'In', values: [3, 4, null, 2, 5] }, { name: 'Out', values: [1, 2, 2, 1, 2] }] }));
    expect(count(html, /<path class="kc-area kc-s1"/g)).toBe(2);
    expect(count(html, /<path class="kc-area kc-s2"/g)).toBe(1);
    expect(count(html, /<path class="kc-line kc-s/g)).toBe(2);
    expect(labels(html, 'kc-name').map((l) => l.text)).toEqual(['In', 'Out']);
    expect(html).toContain('<span class="kchart-key kchart-key-box kc-s1"');
    // a line chart's legend keys are lines
    expect(chart.render(spec({ type: 'line', x: ['a'], series: [{ name: 'A', values: [1] }, { name: 'B', values: [2] }] }))).toContain('kchart-key-line kc-s2');
  });

  it('lays an hbar out in rows that grow with its categories, long labels cut and whole in the table', () => {
    const long = 'Contemporary Amperex Technology Co., Limited (宁德时代新能源科技股份有限公司)';
    const rows = (n: number) => chart.render(spec({ type: 'hbar', x: [long, ...Array.from({ length: n - 1 }, (_, i) => `Fund ${i + 1}`)], series: [{ name: 'Weight', values: Array.from({ length: n }, (_, i) => 10 - i * 0.5) }] }));
    const three = rows(3);
    const twelve = rows(12);
    expect(viewBox(three)[0]).toBe(640);
    expect(viewBox(twelve)[1]).toBeGreaterThan(viewBox(three)[1] + 9 * 20);
    expect(three).toContain('aria-label="Horizontal bar chart: T, 3 categories, 1 series"');
    expect(count(three, /<path class="kc-bar kc-s1"/g)).toBe(3);
    // right-ended bars from a left baseline
    const bar = pathBox(/class="kc-bar kc-s1" data-i="0"[^>]* d="([^"]*)"/.exec(three)![1]);
    expect(bar.y1 - bar.y0).toBeLessThanOrEqual(24);
    const rowLabels = labels(three, 'kc-row');
    expect(rowLabels).toHaveLength(3);
    expect(rowLabels[0].text.endsWith('…')).toBe(true);
    expect(rowLabels[0].text.length).toBeLessThan(long.length);
    expect(three).toContain(`<th scope="row">${long}</th>`);
  });

  it('formats the axis compactly and the table in full', () => {
    const html = chart.render(spec({ x: ['a', 'b', 'c'], series: [{ name: 'A', values: [1234.5, 12000, 23456] }] }));
    expect(labels(html, 'kc-tick').filter((l) => !l.cls.includes('kc-cat')).map((l) => l.text)).toEqual(['0', '5K', '10K', '15K', '20K', '25K']);
    expect(labels(html, 'kc-value').map((l) => l.text)).toEqual(['23.5K']);
    expect(html).toContain(`<td class="kc-num">${(1234.5).toLocaleString()}</td>`);
    const negative = chart.render(spec({ x: ['a', 'b'], series: [{ name: 'A', values: [-3, 7] }] }));
    expect(labels(negative, 'kc-tick').filter((l) => !l.cls.includes('kc-cat')).map((l) => l.text)).toEqual(['−4', '−2', '0', '2', '4', '6', '8']);
  });

  it('starts a line\'s axis near its values only over a narrow band of positive ones', () => {
    const ticksOf = (values: number[]) => labels(chart.render(spec({ type: 'line', x: values.map(String), series: [{ name: 'A', values }] })), 'kc-tick')
      .filter((l) => !l.cls.includes('kc-cat')).map((l) => l.text);
    expect(ticksOf([95, 101, 108, 118])[0]).toBe('90');
    expect(ticksOf([1, 3, 5, 19])[0]).toBe('0');
    expect(ticksOf([-2, 3, 5])).toContain('0');
    // bars always stand on zero
    expect(labels(chart.render(spec({ x: ['a', 'b'], series: [{ name: 'A', values: [95, 118] }] })), 'kc-tick')[0].text).toBe('0');
  });

  it('escapes every string from the spec, wherever it lands', () => {
    const evil = '<script>alert(1)</script>"\' onmouseover="alert(2)" &amp;';
    for (const type of TYPES) {
      // a timeline's values are dates; a waterfall names its levels by label
      const [a, b] = type === 'timeline' ? [[2024, '2025-Q2'], ['2024-06', 2026]] : [[1, 2], [2, 1]];
      const html = chart.render(JSON.stringify({
        type, title: evil, subtitle: evil, unit: evil, source: evil, note: evil,
        x: [evil, 'b'], series: [{ name: evil, values: a }, { name: 'B', values: b }],
        ...(type === 'waterfall' ? { totals: [evil, 'nowhere <b>'] } : {}),
      }));
      expect(html, type).toContain('<figure class="kchart');
      expect(html).not.toMatch(/<script|<b>/i);
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39; onmouseover=&quot;alert(2)&quot; &amp;amp;');
      // every attribute is one the renderer writes itself: geometry, classes, data-, ARIA; never a handler, style, id or link
      const allowed = new Set(['class', 'data-kchart', 'aria-label', 'aria-hidden', 'viewbox', 'width', 'height', 'preserveaspectratio',
        'role', 'data-kc', 'x1', 'x2', 'y1', 'y2', 'x', 'y', 'text-anchor', 'd', 'data-i', 'data-s', 'cx', 'cy', 'r', 'scope', 'data-unit']);
      expect(attributeNames(html).filter((n) => !allowed.has(n))).toEqual([]);
    }
    // a problem quoting the spec is escaped too
    const problems = chart.render(JSON.stringify({ type: '<img src=x onerror=alert(1)>', title: 'T', x: ['a'], series: [{ name: 'A', values: [1] }] }));
    expect(problems).not.toMatch(/<img/i);
    expect(problems).toContain('&quot;type&quot; &quot;&lt;img src=x onerror=alert(1)&gt;&quot; is not one of');
  });

  it('emits nothing the page policy forbids: no inline style, handler, script, id or link', () => {
    const outputs = ['bar', 'line', 'area', 'stacked-bar', 'hbar', 'share', 'scatter', 'waterfall'].map((type) => chart.render(JSON.stringify({ ...REVENUE, type, series: [...REVENUE.series, { name: 'Peer', values: [2, null, 6, 8] }] })));
    outputs.push(chart.render(JSON.stringify(HBM)), chart.render(JSON.stringify(SHARE_USD)), chart.render(JSON.stringify(BRIDGE)));
    outputs.push(chart.render('{ not json'), chart.render(spec({ type: 'pie', x: ['a'], series: [{ name: 'A', values: ['x', 1] }] })));
    for (const html of outputs) {
      expect(html).not.toContain(' style="');
      expect(html).not.toMatch(/ on[a-z]+=/);
      expect(html).not.toMatch(/ id=|<script|javascript:|href=|<foreignObject/i);
    }
  });

  it('lists the problems of a spec it could still draw under the chart', () => {
    const html = chart.render(spec({ type: 'pie', x: ['a', 'b'], series: [{ name: 'S', values: [1, 'two', 3] }] }));
    expect(html).toContain('<div class="kchart-issues"><p class="kchart-issues-title"><span aria-hidden="true">⚠</span> Drawn from a spec with problems</p><ul>');
    expect(html).toContain('<li>Series &quot;S&quot;: value 2 is not a number, shown as a gap.</li>');
    expect(count(html, /class="kc-bar kc-s1"/g)).toBe(1);
  });
});

describe('a block that cannot be drawn', () => {
  it('says why above its JSON, escaped as written', () => {
    const source = '{ "title": "<b>bold</b> & co", "x": [1],\n\n';
    const html = chart.render(source);
    expect(html.startsWith('<div class="kchart-error"><p class="kchart-error-title">Chart not drawn</p><ul><li>The chart is not valid JSON: ')).toBe(true);
    expect(html).toContain('<pre><code class="language-chart">{ &quot;title&quot;: &quot;&lt;b&gt;bold&lt;/b&gt; &amp; co&quot;, &quot;x&quot;: [1],</code></pre></div>');
    expect(html).not.toContain('<b>');
    expect(chart.render(spec({ x: [], series: [] }))).toContain('<li>&quot;x&quot; is empty: list at least one category.</li>');
  });
});

describe('through web/markdown.js', () => {
  it('draws a ```chart block and leaves every other block as code', () => {
    const html = md.render(`# Revenue\n\n\`\`\`chart\n${JSON.stringify({ ...REVENUE, type: 'line' }, null, 2)}\n\`\`\`\n\n\`\`\`json\n{ "a": 1 }\n\`\`\`\n`);
    expect(html).toContain('<h1>Revenue</h1>');
    expect(html).toContain('<figure class="kchart kchart-line"');
    expect(html).toContain('<pre><code class="language-json">{ &quot;a&quot;: 1 }\n</code></pre>');
    // the info string's first word decides, in any case
    expect(md.render('```Chart  {.wide}\n{"title":"T","x":["a"],"series":[{"name":"A","values":[1]}]}\n```')).toContain('<figure class="kchart kchart-bar"');
    expect(md.render('```chart\nnot json\n```')).toContain('<div class="kchart-error">');
  });

  it('keeps a ```chart block as code when chart.js is not loaded', () => {
    const bare = load(false).md;
    expect(bare.render('```chart\n{"x": []}\n```')).toBe('<pre><code class="language-chart">{&quot;x&quot;: []}\n</code></pre>\n');
  });
});

describe('geometry', () => {
  const inside = (html: string) => {
    const [left, top, right, bottom] = geometry(html).plot;
    for (const [, d] of html.matchAll(/<path class="kc-bar[^"]*"[^>]* d="([^"]*)"/g)) {
      const b = pathBox(d);
      expect(b.x0).toBeGreaterThanOrEqual(left - 0.5);
      expect(b.x1).toBeLessThanOrEqual(right + 0.5);
      expect(b.y0).toBeGreaterThanOrEqual(top - 0.5);
      expect(b.y1).toBeLessThanOrEqual(bottom + 0.5);
    }
  };
  const apart = (list: Label[]) => {
    const spans = list.map(extent).sort((a, b) => a[0] - b[0]);
    for (const [x0, x1] of spans) {
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(640);
    }
    for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBeGreaterThan(spans[i - 1][1]);
  };

  it('keeps every bar inside the plot, negatives and stacks included', () => {
    inside(chart.render(spec({ x: ['a', 'b', 'c', 'd'], series: [{ name: 'A', values: [3, -7, 12.5, 0] }, { name: 'B', values: [-1, 4, null, 9] }] })));
    inside(chart.render(spec({ type: 'stacked-bar', x: MONTHS, series: [1, 2, 3, 4, 5].map((k) => ({ name: `S${k}`, values: MONTHS.map((_, i) => (i * k) % 7) })) })));
    inside(chart.render(spec({ type: 'hbar', x: ['one', 'two', 'three'], series: [{ name: 'A', values: [-4, 9, 2] }, { name: 'B', values: [5, -2, 7] }] })));
    const many = Array.from({ length: 80 }, (_, i) => `c${i}`);
    inside(chart.render(spec({ x: many, series: [1, 2, 3, 4, 5, 6, 7, 8].map((k) => ({ name: `S${k}`, values: many.map((_, i) => i * k) })) })));
  });

  it('thins and cuts category labels so no two overlap', () => {
    const days = Array.from({ length: 90 }, (_, i) => `2026-${String(1 + Math.floor(i / 30)).padStart(2, '0')}-${String(1 + (i % 30)).padStart(2, '0')}`);
    const daily = chart.render(spec({ type: 'line', x: days, series: [{ name: 'A', values: days.map((_, i) => Math.sin(i / 9) * 50 + 60) }] }));
    const shown = labels(daily, 'kc-cat');
    expect(shown.length).toBeGreaterThan(3);
    expect(shown.length).toBeLessThan(15);
    expect(shown.some((l) => l.text === days[89])).toBe(true); // the latest always shows
    apart(shown);

    const names = ['Contemporary Amperex Technology', 'Kweichow Moutai', 'BYD Company Limited', '中国平安保险(集团)股份有限公司', 'Tencent'];
    const bars = chart.render(spec({ x: names, series: [{ name: 'A', values: [9, 8, 7, 6, 5] }] }));
    const cut = labels(bars, 'kc-cat');
    apart(cut);
    // a cut label keeps its whole text in a <title> and in the table
    expect(bars).toContain('<title>Contemporary Amperex Technology</title>');
    expect(bars).toContain('<th scope="row">中国平安保险(集团)股份有限公司</th>');

    apart(labels(chart.render(spec({ type: 'area', x: MONTHS, series: [{ name: 'A', values: MONTHS.map((_, i) => i) }] })), 'kc-cat'));
  });

  it('keeps direct labels apart and inside the chart', () => {
    for (const type of ['line', 'area', 'stacked-bar']) {
      const html = chart.render(spec({ type, x: MONTHS, series: [
        { name: 'Alpha series with a long name', values: MONTHS.map((_, i) => 10 + i) },
        { name: 'Beta', values: MONTHS.map((_, i) => 10.2 + i) },
        { name: 'Gamma', values: MONTHS.map((_, i) => 30 - i) },
      ] }));
      const [w] = viewBox(html);
      const placed = [...labels(html, 'kc-name'), ...labels(html, 'kc-value')];
      for (const l of placed) {
        const [x0, x1] = extent(l);
        expect(x0).toBeGreaterThanOrEqual(0);
        expect(x1).toBeLessThanOrEqual(w);
      }
      // two lines ending 0.2 apart cannot both be named there: one name gives way to the legend
      if (type !== 'stacked-bar') expect(labels(html, 'kc-name').length).toBe(2);
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const [a0, a1] = extent(placed[i]);
          const [b0, b1] = extent(placed[j]);
          const overlapX = a0 < b1 && b0 < a1;
          expect(overlapX && Math.abs(placed[i].y - placed[j].y) < 11).toBe(false);
        }
      }
    }
  });

  it('fits an hbar\'s category labels in their column', () => {
    const html = chart.render(spec({ type: 'hbar', x: ['A rather long fund name that goes on and on', '短', 'Mid-length name'], series: [{ name: 'A', values: [3, 2, 1] }] }));
    const [left] = geometry(html).plot;
    for (const l of labels(html, 'kc-row')) {
      expect(l.anchor).toBe('end');
      expect(l.x - setWidth(l.text)).toBeGreaterThanOrEqual(0);
      expect(l.x).toBeLessThan(left);
    }
  });
});

describe('the comparison types', () => {
  /** Every bar's extent, by series class, for one category. */
  const segments = (html: string, i: number) => [...html.matchAll(new RegExp(`<path class="kc-bar ([^"]*)" data-i="${i}"[^>]* d="([^"]*)"`, 'g'))].map((m) => ({ cls: m[1], ...pathBox(m[2]) }));
  const dots = (html: string, cls = 'kc-mark') => [...html.matchAll(/<circle class="([^"]*)" data-i="(\d+)"(?: data-s="(\d+)")? cx="([^"]*)" cy="([^"]*)"/g)]
    .filter((m) => m[1].split(' ').includes(cls))
    .map((m) => ({ cls: m[1], i: Number(m[2]), s: m[3] === undefined ? null : Number(m[3]), cx: Number(m[4]), cy: Number(m[5]) }));
  const table = (html: string) => html.slice(html.indexOf('<details class="kchart-data">'));

  it('parses a timeline\'s dates and a waterfall\'s levels, and wants two series for a scatter', () => {
    const t = chart.parse(JSON.stringify(HBM)).spec as Spec & { series: (Series & { texts: string[] })[] };
    expect(plain(t.series[0].values)).toEqual([2024 + 2 / 12, 2025.75, 2027]);
    expect(plain(t.series[0].texts)).toEqual(['2024-03', '2025-Q4', '2027']);
    expect(plain(t.series[1].texts)).toEqual(['2024-Q4', '2026-H1', '']);
    const odd = chart.parse(JSON.stringify({ ...HBM, series: [{ name: 'A', values: ['Q2 2025', '2025 h2', 'soon'] }] }));
    expect(plain((odd.spec?.series[0] as Series & { texts: string[] }).texts)).toEqual(['2025-Q2', '2025-H2', '']);
    expect(odd.errors).toEqual(['Series "A": value 3 is not a date (a year, "2025-03", "2025-Q4" or "2026-H1"), shown as a gap.']);

    expect(plain((chart.parse(JSON.stringify(BRIDGE)).spec as Spec & { totals: number[] }).totals)).toEqual([0, 4]);
    const named = chart.parse(JSON.stringify({ ...BRIDGE, totals: ['Q2 2026', 'Costs', 'Nowhere'], series: [...BRIDGE.series, { name: 'Extra', values: [1, 2, 3, 4, 5] }] }));
    expect(plain((named.spec as Spec & { totals: number[] }).totals)).toEqual([0, 3]);
    expect(named.errors).toEqual(['A waterfall takes one series; the last one is left out.', '"totals" names "Nowhere", which is not an x label; it is left out.']);

    const lonely = chart.parse(JSON.stringify({ ...VALUATION, series: [VALUATION.series[0]] }));
    expect(lonely.spec).toBeNull();
    expect(lonely.errors).toEqual(['A scatter needs two series: the horizontal measure, then the vertical one.']);
    expect(chart.render(JSON.stringify({ ...VALUATION, series: [VALUATION.series[0]] }))).toContain('<div class="kchart-error">');
    const three = chart.parse(JSON.stringify({ ...VALUATION, series: [...VALUATION.series, { name: 'Margin', values: [1, 2, 3, 4, 5] }] }));
    expect(three.spec?.series.map((s) => s.name)).toEqual(['Revenue growth, %', 'Forward P/E, ×']);
  });

  it('draws a share chart\'s columns as 100% each, its latest shares beside the last one', () => {
    const html = chart.render(JSON.stringify(DRAM));
    const { plot } = geometry(html);
    const [, top, , bottom] = plot;
    for (const i of [0, 1]) {
      const column = segments(html, i);
      expect(column).toHaveLength(4);
      // the stack fills the plot from the baseline to the top, 2px gaps between its segments
      expect(Math.min(...column.map((b) => b.y0))).toBeCloseTo(top, 0);
      expect(Math.max(...column.map((b) => b.y1))).toBeCloseTo(bottom, 0);
    }
    expect(labels(html, 'kc-tick').filter((l) => !l.cls.includes('kc-cat')).map((l) => l.text)).toEqual(['0%', '25%', '50%', '75%', '100%']);
    // the shares ride in the names' labels, nothing above the plot: the ticks carry the unit
    expect(html).toContain('>Samsung<tspan class="kc-value"> 34.1%</tspan></text>');
    expect(labels(html, 'kc-unit')).toEqual([]);
    // values that are the shares already: the table shows them as given, the geometry says so
    expect(geometry(html)).toMatchObject({ k: 'share', pc: 1 });
    expect(table(html)).toContain('<caption>Values in %</caption>');
    expect(table(html)).not.toContain('kc-pct');
    expect(html).toContain('<ul class="kchart-legend" aria-label="Legend">');
  });

  it('works out a share chart\'s shares from amounts, and shows them beside the values', () => {
    const html = chart.render(JSON.stringify(SHARE_USD));
    expect(geometry(html)).not.toHaveProperty('pc');
    expect(table(html)).toContain('<caption>Values in USD bn; in brackets, each value&#39;s share of its column</caption>');
    // 22 of 36.5 is 60.3%
    expect(table(html)).toContain('<td class="kc-num"><span class="kc-v">22</span><span class="kc-pct"> (60.3%)</span></td>');
    expect(labels(html, 'kc-name').map((l) => l.text)).toEqual(['SK hynix', 'Samsung', 'Micron']);
    // percentages that fall short of 100 are stretched, and say by how much
    const short = chart.render(JSON.stringify({ ...DRAM, series: DRAM.series.slice(0, 3) }));
    expect(table(short)).toContain('<span class="kc-pct"> (42.4%)</span>');
    // a negative value has no share: left out, with a note; a column with nothing in it is left empty
    const odd = chart.render(spec({ type: 'share', x: ['a', 'b'], series: [{ name: 'A', values: [3, null] }, { name: 'B', values: [-1, 0] }] }));
    expect(odd).toContain('1 negative value is left out of the stacks');
    expect(odd).toContain('&quot;b&quot; has no positive value, so its column is left empty.');
    expect(segments(odd, 1)).toEqual([]);
  });

  it('places a scatter\'s points on two measures, one hue, named where the names fit', () => {
    const html = chart.render(JSON.stringify(VALUATION));
    expect(html).toContain('aria-label="Scatter plot: Valuation against growth, 4 points"');
    const pts = dots(html, 'kc-pt');
    expect(pts.map((d) => d.i)).toEqual([0, 1, 2, 3]); // CXMT has no growth figure: in the table, not on the plot
    expect(new Set(pts.map((d) => d.cls))).toEqual(new Set(['kc-dot kc-pt kc-mark kc-s1']));
    const at = (i: number) => pts.find((d) => d.i === i)!;
    // more growth sits further right; a higher P/E sits higher (a smaller y)
    expect(at(0).cx).toBeGreaterThan(at(2).cx);
    expect(at(2).cx).toBeGreaterThan(at(3).cx);
    expect(at(3).cy).toBeLessThan(at(1).cy);
    expect(at(1).cy).toBeLessThan(at(0).cy);
    // the axes are named after the series; no legend, since there is one hue
    expect(labels(html, 'kc-axis-title').map((l) => l.text)).toEqual(['Forward P/E, ×', 'Revenue growth, %']);
    expect(html).not.toContain('kchart-legend');
    const names = labels(html, 'kc-name');
    expect(names.map((l) => l.text).sort()).toEqual(['Kioxia', 'Micron', 'SK hynix', 'Samsung']);
    // no name sits on another, and every one is inside the chart
    for (let i = 0; i < names.length; i++) {
      const [a0, a1] = extent(names[i]);
      expect(a0).toBeGreaterThanOrEqual(0);
      expect(a1).toBeLessThanOrEqual(640);
      for (let j = i + 1; j < names.length; j++) {
        const [b0, b1] = extent(names[j]);
        expect(a0 < b1 && b0 < a1 && Math.abs(names[i].y - names[j].y) < 11).toBe(false);
      }
    }
    expect(table(html)).toContain('<thead><tr><th scope="col">Point</th><th scope="col" class="kc-num">Revenue growth, %</th><th scope="col" class="kc-num">Forward P/E, ×</th></tr></thead>');
    expect(table(html)).toContain('<tr><th scope="row">CXMT</th><td class="kc-num kc-gap">—</td><td class="kc-num">30</td></tr>');
    expect(geometry(html)).toMatchObject({ k: 'scatter' });
    expect((geometry(html) as unknown as { pt: unknown[] }).pt[4]).toBeNull();
  });

  it('builds a waterfall from its levels and the changes between them', () => {
    const html = chart.render(JSON.stringify(BRIDGE));
    const zeroY = Number(/<line class="kc-axis" x1="[^"]*" x2="[^"]*" y1="([^"]*)"/.exec(html)![1]);
    const [start, price, nand, costs, end] = [0, 1, 2, 3, 4].map((i) => segments(html, i)[0]);
    // levels stand on zero in the series' hue; a rise floats from the level before it, a fall hangs from it
    expect(start.cls).toBe('kc-s1');
    expect(start.y1).toBeCloseTo(zeroY, 0);
    expect(end.cls).toBe('kc-s1');
    expect(price.cls).toBe('kc-up');
    expect(price.y1).toBeCloseTo(start.y0, 0);
    expect(nand.cls).toBe('kc-down');
    expect(nand.y0).toBeCloseTo(price.y0, 0);
    expect(costs.y0).toBeCloseTo(nand.y1, 0);
    expect(end.y0).toBeCloseTo(costs.y1, 0);
    // a dotted line carries each level on to the next bar
    expect(count(html, /<line class="kc-link"/g)).toBe(4);
    expect(labels(html, 'kc-value').map((l) => l.text)).toEqual(['38.5', '+6.2', '−1.4', '−0.9', '42.4']);
    expect(html).toContain('<li><span class="kchart-key kchart-key-box kc-s1" aria-hidden="true"></span>Gross margin</li><li><span class="kchart-key kchart-key-box kc-up" aria-hidden="true"></span>Increase</li><li><span class="kchart-key kchart-key-box kc-down" aria-hidden="true"></span>Decrease</li>');
    expect(table(html)).toContain('<thead><tr><th scope="col">Bar</th><th scope="col" class="kc-num">Gross margin</th><th scope="col" class="kc-num">Running total</th></tr></thead>');
    expect(table(html)).toContain(`<tr><th scope="row">DRAM price</th><td class="kc-num">+${(6.2).toLocaleString()}</td><td class="kc-num">${(44.7).toLocaleString()}</td></tr>`);
    expect(geometry(html)).toMatchObject({ k: 'waterfall', tt: [0, 4], up: [0, 1, 0, 0, 0] });
    expect(html).toContain('aria-label="Waterfall chart: Gross margin walk, 5 bars"');

    // subtotals by name: a level in the middle stands on zero again
    const pnl = chart.render(spec({ type: 'waterfall', x: ['Revenue', 'Costs', 'Gross', 'Opex', 'EBIT'], totals: ['Revenue', 'Gross', 'EBIT'], series: [{ name: 'USD bn', values: [10, -6, 4, -1.5, 2.5] }] }));
    const gross = segments(pnl, 2)[0];
    expect(gross.cls).toBe('kc-s1');
    expect(gross.y1).toBeCloseTo(Number(/<line class="kc-axis" x1="[^"]*" x2="[^"]*" y1="([^"]*)"/.exec(pnl)![1]), 0);
    expect(pnl).not.toContain('kc-up'); // no rise, so no key for one
  });

  it('lays a timeline out in a row per series, each date where it falls in its year', () => {
    const html = chart.render(JSON.stringify(HBM));
    expect(html).toContain('aria-label="Timeline: HBM generations, 3 milestones, 2 series"');
    expect(html).toContain('<desc>3 milestones, HBM3E to HBM4E. SK hynix: 2024-03 to 2027; Samsung: 2024-Q4 to 2026-H1.</desc>');
    const pts = dots(html);
    expect(pts.map((d) => [d.s, d.i])).toEqual([[0, 0], [0, 1], [0, 2], [1, 0], [1, 1]]);
    // one row each, in the series' hue
    expect(new Set(pts.filter((d) => d.s === 0).map((d) => d.cy)).size).toBe(1);
    expect(pts.find((d) => d.s === 1)!.cy).toBeGreaterThan(pts[0].cy);
    expect(pts.filter((d) => d.s === 1).every((d) => d.cls.includes('kc-s2'))).toBe(true);
    // years along the foot, from the first date's year to the end of the last one's
    const years = labels(html, 'kc-tick').map((l) => l.text);
    expect(years).toEqual(['2024', '2025', '2026', '2027', '2028']);
    const yearX = (y: string) => labels(html, 'kc-tick').find((l) => l.text === y)!.x;
    const at = (s: number, i: number) => pts.find((d) => d.s === s && d.i === i)!.cx;
    expect(at(0, 2)).toBeCloseTo(yearX('2027'), 0); // 2027 is its start
    expect(at(0, 1)).toBeCloseTo(yearX('2025') + 0.75 * (yearX('2026') - yearX('2025')), 0); // Q4 starts three quarters in
    expect(at(1, 1)).toBeCloseTo(yearX('2026'), 0); // H1 starts with the year
    expect(labels(html, 'kc-row').map((l) => l.text)).toEqual(['SK hynix', 'Samsung']);
    expect(labels(html, 'kc-name').map((l) => l.text)).toEqual(['HBM3E', 'HBM4', 'HBM4E', 'HBM3E', 'HBM4']);
    expect(count(html, /<line class="kc-track kc-s/g)).toBe(2);
    // the table shows the dates as written; a timeline has no unit and no legend
    expect(table(html)).toContain('<tr><th scope="row">HBM4</th><td class="kc-num">2025-Q4</td><td class="kc-num">2026-H1</td></tr>');
    expect(table(html)).toContain('<tr><th scope="row">HBM4E</th><td class="kc-num">2027</td><td class="kc-num kc-gap">—</td></tr>');
    expect(table(html)).toContain('<thead><tr><th scope="col">Milestone</th>');
    expect(html).not.toContain('kchart-legend');
    expect(html).not.toContain('data-unit');
  });

  it('keeps every new type\'s marks inside its plot', () => {
    for (const s of [DRAM, SHARE_USD, BRIDGE]) {
      const html = chart.render(JSON.stringify(s));
      const [left, top, right, bottom] = geometry(html).plot;
      for (const [, d] of html.matchAll(/<path class="kc-bar[^"]*"[^>]* d="([^"]*)"/g)) {
        const b = pathBox(d);
        expect(b.x0).toBeGreaterThanOrEqual(left - 0.5);
        expect(b.x1).toBeLessThanOrEqual(right + 0.5);
        expect(b.y0).toBeGreaterThanOrEqual(top - 0.5);
        expect(b.y1).toBeLessThanOrEqual(bottom + 0.5);
      }
    }
    for (const s of [VALUATION, HBM]) {
      const html = chart.render(JSON.stringify(s));
      const [left, top, right, bottom] = geometry(html).plot;
      for (const d of dots(html)) {
        expect(d.cx).toBeGreaterThanOrEqual(left);
        expect(d.cx).toBeLessThanOrEqual(right);
        expect(d.cy).toBeGreaterThanOrEqual(top);
        expect(d.cy).toBeLessThanOrEqual(bottom);
      }
    }
  });
});

describe('hydrate', () => {
  it('is a no-op without a page to wire', () => {
    expect(() => chart.hydrate()).not.toThrow();
    expect(() => chart.hydrate(null)).not.toThrow();
    expect(() => chart.hydrate({})).not.toThrow();
  });
});
