/**
 * Charts in wiki pages are data, not pictures: a fenced block with the
 * language `chart` holding one JSON object. The web viewer draws it
 * (web/chart.js), the Mac app draws it with Swift Charts, Obsidian shows the
 * JSON — and in every one of them the numbers stay readable, diffable and
 * citable, which a PNG an agent rendered would not be.
 *
 *   ```chart
 *   { "type": "bar", "title": "Revenue by year", "unit": "USD bn",
 *     "x": ["2023", "2024", "2025"],
 *     "series": [{ "name": "Revenue", "values": [0.1, 0.9, 4.5] }],
 *     "source": "raw/docs/research/…/files/s-1.html" }
 *   ```
 *
 * This module is the server's reading of that contract: the validator checks
 * every chart a research page carries, and `knode_chart` lets an agent check a
 * spec before it writes the page. The viewers parse the same shape leniently.
 */

export const CHART_TYPES = ['bar', 'line', 'area', 'stacked-bar', 'hbar'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export interface ChartSeries {
  name: string;
  values: (number | null)[];
}

export interface ChartSpec {
  type: ChartType;
  title: string;
  subtitle?: string;
  unit?: string;
  x: string[];
  series: ChartSeries[];
  source: string;
  note?: string;
}

export const MAX_CHART_SERIES = 8;
export const MAX_CHART_POINTS = 60;

function num(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const t = v.trim().replace(/,/g, '');
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** A spec, normalized, and what is wrong with it (empty when it can be drawn and cited). */
export function parseChart(text: string): { spec: ChartSpec | null; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch (err) {
    return { spec: null, errors: [`not valid JSON: ${err instanceof Error ? err.message : err}`], warnings };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { spec: null, errors: ['a chart is one JSON object'], warnings };
  const o = raw as Record<string, unknown>;
  const type = (typeof o.type === 'string' ? o.type.trim().toLowerCase() : 'bar') as ChartType;
  if (!CHART_TYPES.includes(type)) errors.push(`type must be one of ${CHART_TYPES.join(', ')}`);
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  if (!title) errors.push('title is required');
  const x = Array.isArray(o.x) ? o.x.map((v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '')) : [];
  if (x.length === 0) errors.push('x needs at least one category');
  if (x.length > MAX_CHART_POINTS) errors.push(`at most ${MAX_CHART_POINTS} categories (aggregate, or split the chart)`);
  if (x.some((v) => !v)) errors.push('every x label is a non-empty string');
  const series: ChartSeries[] = [];
  const rawSeries = Array.isArray(o.series) ? o.series : [];
  if (rawSeries.length === 0) errors.push('series needs at least one { name, values }');
  if (rawSeries.length > MAX_CHART_SERIES) errors.push(`at most ${MAX_CHART_SERIES} series (fold the rest into "Other", or use small charts)`);
  rawSeries.slice(0, MAX_CHART_SERIES).forEach((s, i) => {
    const so = (s ?? {}) as Record<string, unknown>;
    const name = typeof so.name === 'string' && so.name.trim() ? so.name.trim() : '';
    if (!name) errors.push(`series ${i + 1} needs a name`);
    const values = Array.isArray(so.values) ? so.values.map(num) : [];
    if (values.length !== x.length) errors.push(`series "${name || i + 1}" has ${values.length} values for ${x.length} categories`);
    if (values.some((v) => v === undefined)) errors.push(`series "${name || i + 1}": values are numbers or null`);
    series.push({ name, values: values.map((v) => (v === undefined ? null : v)) });
  });
  if (series.length && series.every((s) => s.values.every((v) => v === null))) errors.push('the chart has no values');
  if (type === 'stacked-bar' && series.some((s) => s.values.some((v) => v !== null && v < 0))) errors.push('stacked-bar values must not be negative');
  const source = typeof o.source === 'string' ? o.source.trim() : '';
  if (!source) errors.push('source is required: the files or URLs the numbers come from');
  if (type === 'line' && x.length < 3) warnings.push(`"${title}": a line over ${x.length} points reads better as bars`);
  const spec: ChartSpec = {
    type, title, x, series, source,
    ...(typeof o.subtitle === 'string' && o.subtitle.trim() ? { subtitle: o.subtitle.trim() } : {}),
    ...(typeof o.unit === 'string' && o.unit.trim() ? { unit: o.unit.trim() } : {}),
    ...(typeof o.note === 'string' && o.note.trim() ? { note: o.note.trim() } : {}),
  };
  return { spec: errors.length ? null : spec, errors, warnings };
}

/** Every ```chart block of a Markdown body, with its line. */
export function chartBlocks(markdown: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,}|~{3,})\s*chart\b.*$/i.exec(lines[i]);
    if (!open) continue;
    const fence = open[2];
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (lines[j].trim().startsWith(fence[0].repeat(fence.length)) && lines[j].trim().replace(/[`~]/g, '') === '') break;
      body.push(lines[j]);
    }
    out.push({ line: i + 1, text: body.join('\n') });
    i = j;
  }
  return out;
}

/** The validator's view of a page's charts: errors block the page, warnings ride along. */
export function checkCharts(markdown: string): { errors: string[]; warnings: string[]; count: number } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const blocks = chartBlocks(markdown);
  for (const b of blocks) {
    const r = parseChart(b.text);
    for (const e of r.errors) errors.push(`chart at line ${b.line}: ${e}`);
    warnings.push(...r.warnings);
  }
  return { errors, warnings, count: blocks.length };
}

/** The block an agent pastes into its page. */
export function chartBlock(spec: ChartSpec): string {
  return ['```chart', JSON.stringify(spec, null, 2), '```'].join('\n');
}
