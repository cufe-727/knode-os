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
 * Every type reads the same shape — `x` names the categories, each series
 * holds one value per category — and says what the categories are:
 *
 *   bar · hbar · line · area   one value axis, the categories along it
 *   stacked-bar                parts of a whole, stacked (no negatives)
 *   share                      the same, each column drawn as 100%: market share over time
 *   scatter                    `x` names the points; exactly two series, the horizontal
 *                              measure first, then the vertical one
 *   waterfall                  `x` names the bars of one series: levels (`totals`, the first
 *                              and the last when left out) and the changes between them
 *   timeline                   `x` lists generations or milestones in order, a series per
 *                              maker, and each value is when: a year, "2025-03", "2025-Q4", "2026-H1"
 *
 * This module is the server's reading of that contract: the validator checks
 * every chart a research page carries, and `knode_chart` lets an agent check a
 * spec before it writes the page. The viewers parse the same shape leniently.
 */

export const CHART_TYPES = ['bar', 'line', 'area', 'stacked-bar', 'hbar', 'share', 'scatter', 'waterfall', 'timeline'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export interface ChartSeries {
  name: string;
  /** Numbers, null for a gap. A timeline's are dates: a year (2025, 2025.5) or "2025", "2025-03", "2025-Q4", "2026-H1". */
  values: (number | string | null)[];
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
  /** waterfall: the bars that stand for a level rather than a change, by their x label. */
  totals?: string[];
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

const FIRST_YEAR = 1900;
const LAST_YEAR = 2199;

/**
 * A timeline's value: where it stands, in years (the start of its period:
 * "2025-Q4" is 2025.75), and how it reads; null for a gap, undefined when it
 * is no date. web/chart.js and the Mac app read the same forms.
 */
export function timelineDate(v: unknown): { at: number; text: string } | null | undefined {
  if (v === null) return null;
  const year = (y: number) => (y >= FIRST_YEAR && y <= LAST_YEAR ? y : undefined);
  if (typeof v === 'number') return Number.isFinite(v) && year(Math.floor(v)) !== undefined ? { at: v, text: String(v) } : undefined;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t === '') return null;
  let m = /^(\d{4})(?:\.\d+)?$/.exec(t);
  if (m) return year(Number(m[1])) === undefined ? undefined : { at: Number(t), text: t };
  m = /^(\d{4})[-/.](\d{1,2})$/.exec(t);
  if (m && year(Number(m[1])) !== undefined && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    return { at: Number(m[1]) + (Number(m[2]) - 1) / 12, text: `${m[1]}-${m[2].padStart(2, '0')}` };
  }
  // 2025-Q4, 2025 Q4, Q4 2025; the same with H for a half
  const yearFirst = /^(\d{4})[-\s]?([QH])([1-4])$/i.exec(t);
  const yearLast = /^([QH])([1-4])[-\s]?(\d{4})$/i.exec(t);
  const part = yearFirst ? { y: Number(yearFirst[1]), kind: yearFirst[2].toUpperCase(), n: Number(yearFirst[3]) }
    : yearLast ? { y: Number(yearLast[3]), kind: yearLast[1].toUpperCase(), n: Number(yearLast[2]) } : null;
  if (!part || year(part.y) === undefined || (part.kind === 'H' && part.n > 2)) return undefined;
  return { at: part.y + (part.n - 1) / (part.kind === 'Q' ? 4 : 2), text: `${part.y}-${part.kind}${part.n}` };
}

/** The decimals a value was written with, so a sum can be held to the rounding its parts carry. */
const decimals = (v: number) => /\.(\d+)$/.exec(String(v))?.[1].length ?? 0;
const clean = (v: number) => Number(v.toPrecision(12));
const PERCENT = /%|percent|pct|百分/i;

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
  const timeline = type === 'timeline';
  rawSeries.slice(0, MAX_CHART_SERIES).forEach((s, i) => {
    const so = (s ?? {}) as Record<string, unknown>;
    const name = typeof so.name === 'string' && so.name.trim() ? so.name.trim() : '';
    if (!name) errors.push(`series ${i + 1} needs a name`);
    const given = Array.isArray(so.values) ? so.values : [];
    if (given.length !== x.length) errors.push(`series "${name || i + 1}" has ${given.length} values for ${x.length} categories`);
    if (timeline) {
      const dates = given.map(timelineDate);
      if (dates.some((d) => d === undefined)) errors.push(`series "${name || i + 1}": a timeline's values are dates — a year (2025), "2025-03", "2025-Q4", "2026-H1" — or null`);
      series.push({ name, values: dates.map((d, k) => (d ? (typeof given[k] === 'number' ? d.at : d.text) : null)) });
      return;
    }
    const values = given.map(num);
    if (values.some((v) => v === undefined)) errors.push(`series "${name || i + 1}": values are numbers or null`);
    series.push({ name, values: values.map((v) => (v === undefined ? null : v)) });
  });
  if (series.length && series.every((s) => s.values.every((v) => v === null))) errors.push('the chart has no values');
  const numbers = (s: ChartSeries) => s.values.map((v) => (typeof v === 'number' ? v : null));
  if ((type === 'stacked-bar' || type === 'share') && series.some((s) => numbers(s).some((v) => v !== null && v < 0))) errors.push(`${type} values must not be negative`);
  const source = typeof o.source === 'string' ? o.source.trim() : '';
  if (!source) errors.push('source is required: the files or URLs the numbers come from');
  if (type === 'line' && x.length < 3) warnings.push(`"${title}": a line over ${x.length} points reads better as bars`);

  const unit = typeof o.unit === 'string' && o.unit.trim() ? o.unit.trim() : '';
  let totals: string[] | undefined;
  if (type === 'share') checkShare(title, x, series.map(numbers), unit, errors, warnings);
  if (type === 'scatter') checkScatter(series, errors, warnings);
  if (type === 'waterfall') totals = checkWaterfall(title, x, series, o.totals, errors, warnings);
  if (timeline) checkTimeline(title, x, series, warnings);

  const spec: ChartSpec = {
    type, title, x, series, source,
    ...(typeof o.subtitle === 'string' && o.subtitle.trim() ? { subtitle: o.subtitle.trim() } : {}),
    ...(unit ? { unit } : {}),
    ...(typeof o.note === 'string' && o.note.trim() ? { note: o.note.trim() } : {}),
    ...(totals ? { totals } : {}),
  };
  return { spec: errors.length ? null : spec, errors, warnings };
}

/** share: every column drawn as 100%, so each needs something to share out; percentages that fall short of 100 have lost a part. */
function checkShare(title: string, x: string[], rows: (number | null)[][], unit: string, errors: string[], warnings: string[]): void {
  if (rows.length === 1) warnings.push(`"${title}": a share chart of one series fills every column — add the others, or draw it as bars`);
  x.forEach((label, i) => {
    const column = rows.map((r) => r[i]).filter((v): v is number => v !== null && v !== undefined);
    const sum = column.reduce((a, v) => a + Math.max(0, v), 0);
    if (sum <= 0) errors.push(`share: "${label}" has nothing to share out (every value is empty or zero)`);
    else if (PERCENT.test(unit) && Math.abs(sum - 100) > Math.max(1, 0.5 * column.length)) {
      warnings.push(`"${title}": the ${label} shares add up to ${clean(sum)}%, not 100 — add an "Other" series, or the bar stretches them to fill it`);
    }
  });
}

/** scatter: two measures, horizontal then vertical, and points that have both. */
function checkScatter(series: ChartSeries[], errors: string[], warnings: string[]): void {
  if (series.length !== 2) {
    errors.push(`a scatter takes two series, the horizontal measure first and then the vertical one (${series.length} given)`);
    return;
  }
  const [h, v] = series;
  const both = h.values.filter((a, i) => a !== null && v.values[i] !== null).length;
  if (both < 2) errors.push('a scatter needs at least two points with both values');
  else if (both < h.values.length) warnings.push(`scatter: ${h.values.length - both} of ${h.values.length} points lack one of the two values and are left out`);
}

/**
 * waterfall: one series whose bars are levels (its totals) or the changes
 * between them, with no gaps; each level after the first should be what the
 * changes before it add up to, within the rounding the numbers were written with.
 */
function checkWaterfall(title: string, x: string[], series: ChartSeries[], rawTotals: unknown, errors: string[], warnings: string[]): string[] | undefined {
  if (series.length !== 1) errors.push(`a waterfall takes one series, its steps (${series.length} given)`);
  let totals: string[] | undefined;
  if (rawTotals !== undefined && rawTotals !== null) {
    if (!Array.isArray(rawTotals) || rawTotals.some((t) => typeof t !== 'string' && typeof t !== 'number')) {
      errors.push('totals lists the x labels of the bars that are levels, such as ["Q2 2026", "Q3 2026"]');
    } else {
      totals = [...new Set(rawTotals.map((t) => String(t).trim()))];
      for (const t of totals) {
        const n = x.filter((l) => l === t).length;
        if (n === 0) errors.push(`totals names "${t}", which is not one of the x labels`);
        if (n > 1) errors.push(`totals names "${t}", which x lists ${n} times`);
      }
    }
  }
  const s = series[0];
  if (!s) return totals;
  const gaps = s.values.map((v, i) => (v === null ? i + 1 : 0)).filter(Boolean);
  if (x.length < 3) warnings.push(`"${title}": a waterfall of ${x.length} bars reads better as bars`);
  if (gaps.length) {
    errors.push(`a waterfall has no gaps — every bar is a level or a change (value ${gaps.join(', ')} is null)`);
    return totals;
  }
  const isTotal = (i: number) => (totals ? totals.includes(x[i]) : i === 0 || i === x.length - 1);
  const values = s.values.map((v) => (typeof v === 'number' ? v : 0));
  const places = Math.max(0, ...values.map(decimals));
  let level = 0;
  let summed = 0; // the values in `level` since the last check
  values.forEach((v, i) => {
    if (!isTotal(i)) {
      level += v;
      summed++;
      return;
    }
    if (summed > 0 && Math.abs(level - v) > (summed + 1) * 0.5 * 10 ** -places + 1e-9) {
      warnings.push(`"${title}": the steps up to "${x[i]}" add up to ${clean(level)}, but that bar says ${v}`);
    }
    level = v;
    summed = 1;
  });
  return totals;
}

/** timeline: a maker reaches the generations x lists in order; going back in time along a row is likely a slip. */
function checkTimeline(title: string, x: string[], series: ChartSeries[], warnings: string[]): void {
  for (const s of series) {
    let last: { at: number; text: string; i: number } | null = null;
    s.values.forEach((v, i) => {
      const d = timelineDate(v);
      if (!d) return;
      if (last && d.at < last.at) warnings.push(`"${title}": ${s.name} reaches "${x[i]}" (${d.text}) before "${x[last.i]}" (${last.text}) — list the generations in x in the order they come`);
      last = { ...d, i };
    });
  }
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
