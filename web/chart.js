/* knode-os web UI — charts a page carries as data, drawn as SVG */
'use strict';

/**
 * A page can carry a chart as data: a fenced block whose language is
 * `chart`, holding one JSON object —
 *
 *   {
 *     "type": "bar",                bar · line · area · stacked-bar · hbar (bar when left out)
 *     "title": "…", "subtitle": "…", "unit": "USD bn",
 *     "x": ["2024-12", "2025-05"],                        the categories, in order
 *     "series": [{ "name": "…", "values": [1, null] }],   1 to 8 of them; null is a gap
 *     "source": "…", "note": "…"
 *   }
 *
 * web/markdown.js hands the block's text to `render`, which returns a figure:
 * the title, a legend, the SVG, the note and the source, and the numbers as a
 * table. Obsidian and other viewers show the JSON, which is fine.
 *
 * Agents write these blocks, so a spec is data and never markup:
 *   - every string from it is escaped and lands only in text or in an
 *     attribute's value: never an attribute's name, a URL or a handler;
 *   - the markup carries no `style="…"`, script, handler or `id` (markdown.js
 *     sets no `id` either): colours are classes in web/chart.css, and the
 *     hover layer comes from `hydrate`, with listeners and CSSOM, both of
 *     which the page's Content-Security-Policy allows;
 *   - the server validates specs; this reads them leniently: what can be
 *     drawn is, with its problems listed under it, and a block that cannot
 *     be drawn says why above its JSON.
 *
 * Hover is an enhancement. A chart never hydrated still reads in full: the
 * axis, the sparing direct labels and the table under it carry every value a
 * tooltip shows.
 *
 * A plain script (no build step), loaded before markdown.js. app.js calls
 * `knodeChart.hydrate(element)` after it puts rendered Markdown in the page;
 * the tests load this file the way the page does, next to marked.
 */
(function (global) {
  const TYPES = ['bar', 'line', 'area', 'stacked-bar', 'hbar'];
  const TYPE_NAMES = {
    bar: 'Bar chart',
    line: 'Line chart',
    area: 'Area chart',
    'stacked-bar': 'Stacked bar chart',
    hbar: 'Horizontal bar chart',
  };
  /** One series per categorical hue: a ninth is never invented. */
  const MAX_SERIES = 8;
  const MAX_CATEGORIES = 1000;

  // Geometry in viewBox units; the SVG scales to its column.
  const W = 640; // every chart's width
  const H = 320; // a column chart's height; an hbar grows a row per category
  const FONT = 11; // ticks, categories and direct labels
  const GAP = 2; // the surface gap between touching marks
  const BAR_MAX = 24; // bars stay thin: the band's leftover is air
  const RADIUS = 4; // the rounded data end; the baseline end stays square
  const DOT = 5; // end dots: 8px of colour inside a 2px surface ring
  const LABEL_GAP = 6; // the least air between two category labels
  const NAME_MAX = 96; // a series name riding beside its marks
  const ROW_LABEL_MAX = 200; // an hbar's category column

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /** A coordinate as the markup writes it: a tenth of a unit is finer than a pixel. */
  const p = (v) => Math.round(v * 10) / 10;

  /* -------------------------------- numbers ------------------------------- */

  const UNITS = [[1, ''], [1e3, 'K'], [1e6, 'M'], [1e9, 'B'], [1e12, 'T']];
  const MINUS = '−';

  /** Tick arithmetic leaves float dust (0.30000000000000004); twelve digits are plenty. */
  const clean = (v) => Number(v.toPrecision(12));
  const trimZeros = (s) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);

  /** A value in a few characters, for a direct label: three significant digits, 1.2K, 3.4M, 5.6B. */
  function compact(v) {
    if (v === 0) return '0';
    const a = Math.abs(v);
    for (let k = 0; k < UNITS.length; k++) {
      const [div, suffix] = UNITS[k];
      const r = Number((a / div).toPrecision(3));
      if (r < 1000 || k === UNITS.length - 1) return `${v < 0 ? MINUS : ''}${r}${suffix}`;
    }
    return String(v);
  }

  /** An axis's labels: one unit for every tick and the decimals its step needs, so no two ticks read alike. */
  function tickLabels(ticks) {
    const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : Math.abs(ticks[0]) || 1;
    const most = Math.max(...ticks.map(Math.abs));
    let k = UNITS.length - 1;
    while (k > 0 && (most < UNITS[k][0] || step < UNITS[k][0] / 100)) k--;
    const [div, suffix] = UNITS[k];
    const decimals = Math.min(12, Math.max(0, -Math.floor(Math.log10(step / div) + 1e-9)));
    return ticks.map((v) => (v === 0 ? '0' : `${v < 0 ? MINUS : ''}${trimZeros((Math.abs(v) / div).toFixed(decimals))}${suffix}`));
  }

  /** A value in full, for the tooltip and the table; a gap is a dash. */
  function fullNumber(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    try {
      return v.toLocaleString(undefined, { maximumSignificantDigits: 15 });
    } catch {
      return String(v);
    }
  }

  /** The step among 1, 2 and 5 × 10ⁿ nearest a fifth of the span (d3's thresholds): an axis that neither crowds nor wastes its top. */
  function niceStep(span) {
    const raw = span / 5;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const err = raw / mag;
    return (err >= Math.sqrt(50) ? 10 : err >= Math.sqrt(10) ? 5 : err >= Math.SQRT2 ? 2 : 1) * mag;
  }

  /** Ticks at 1, 2 or 5 × 10ⁿ spanning lo..hi: four to eight intervals. */
  function niceAxis(lo, hi) {
    if (hi - lo <= 1e-12 * Math.max(1, Math.abs(hi))) {
      // a flat run of values still needs an axis with room in it
      if (hi === 0) hi = 1;
      else if (hi > 0) lo = 0;
      else hi = 0;
    }
    const step = niceStep(hi - lo);
    const min = Math.floor(clean(lo / step)) * step;
    const max = Math.ceil(clean(hi / step)) * step;
    const ticks = [];
    for (let i = 0, k = Math.round((max - min) / step); i <= k; i++) ticks.push(clean(min + i * step));
    return { min: clean(min), max: clean(max), ticks };
  }

  /** Bars and areas measure from zero. A line may start near its values, but only over a narrow band of positive ones. */
  function valueAxis(type, lo, hi) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return niceAxis(0, 1);
    if (type === 'line' && lo > 0 && hi > lo && lo >= 0.6 * hi) {
      const axis = niceAxis(lo - (hi - lo) * 0.1, hi);
      if (axis.min > 0) return axis;
    }
    return niceAxis(Math.min(0, lo), Math.max(0, hi));
  }

  /* ------------------------------ text width ------------------------------ */

  /**
   * About how wide a character sets in the UI's sans, in ems. The renderer
   * has no DOM to measure in, so it errs wide: a label it thinks fits does,
   * and crowded labels thin out or end in an ellipsis rather than overlap.
   */
  function charWidth(ch) {
    const c = ch.codePointAt(0);
    if (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x1f000)) return 1; // CJK, full-width forms, emoji
    if (ch === '…') return 0.8;
    if (/[\s.,:;'"!|()[\]{}ijlItf]/.test(ch)) return 0.34;
    if (/[mwMW@%&]/.test(ch)) return 0.9;
    if (/[A-Z]/.test(ch)) return 0.7;
    if (/[0-9$#?+\-*=<>~^_]/.test(ch)) return 0.62;
    return 0.58;
  }

  function textWidth(s) {
    let w = 0;
    for (const ch of String(s)) w += charWidth(ch);
    return w * FONT;
  }

  /** `s` cut to `max` wide, ending in an ellipsis when it had to be cut; '' when not even that fits. */
  function fit(s, max) {
    if (textWidth(s) <= max) return s;
    const room = max - textWidth('…');
    if (room <= 0) return '';
    let out = '';
    let w = 0;
    for (const ch of s) {
      w += charWidth(ch) * FONT;
      if (w > room) break;
      out += ch;
    }
    return `${out.trimEnd()}…`;
  }

  /* -------------------------------- parsing ------------------------------- */

  const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

  /** A value from the spec as an error message quotes it: short, the way JSON writes it. */
  function shown(v) {
    let s;
    try {
      s = JSON.stringify(v);
    } catch {
      s = undefined;
    }
    if (s === undefined) s = String(v);
    return s.length > 40 ? `${s.slice(0, 39)}…` : s;
  }

  const positions = (list) => (list.length > 6 ? `${list.slice(0, 6).join(', ')}, …` : list.join(', '));
  const plural = (n, one, many) => (n === 1 ? one : many);

  /**
   * A number, or null for a gap. A numeric string counts as its number
   * ("1,234" too) and an empty one as a gap, the way the server's validator
   * (src/research/chart.ts) reads them; anything else is a gap and reported.
   */
  function toNumber(v, bad) {
    if (v === null) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const t = v.trim().replace(/,/g, '');
      if (t === '') return null;
      const n = Number(t);
      if (Number.isFinite(n)) return n;
    }
    bad();
    return null;
  }

  /**
   * The spec in a block's text, normalized — `type` defaulted to bar, `x` as
   * strings, values finite numbers or null, absent text fields '' — and what
   * is wrong with it, in words. `spec` is null only when nothing can be
   * drawn: the JSON does not parse, or there are no categories, no series or
   * no values. Anything else is drawn as far as it goes, its problems listed.
   */
  function parse(text) {
    const errors = [];
    const src = String(text ?? '').trim();
    if (!src) return { spec: null, errors: ['The chart block is empty: it needs a JSON object with "x" and "series".'] };
    let raw;
    try {
      raw = JSON.parse(src);
    } catch (e) {
      return { spec: null, errors: [`The chart is not valid JSON: ${e?.message ?? e}`] };
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { spec: null, errors: ['The chart must be one JSON object: { "type": …, "title": …, "x": […], "series": […] }.'] };
    }

    let type = 'bar';
    if (raw.type !== undefined && raw.type !== null) {
      const t = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
      if (TYPES.includes(t)) type = t;
      else errors.push(`"type" ${shown(raw.type)} is not one of ${TYPES.join(', ')}; it is drawn as a bar chart.`);
    }

    const textField = (key, required) => {
      const v = raw[key];
      if (typeof v === 'string' && oneLine(v)) return oneLine(v);
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
      const given = v !== undefined && v !== null && typeof v !== 'string';
      if (required) errors.push(given ? `"${key}" must be text.` : `The chart has no "${key}".`);
      else if (given) errors.push(`"${key}" must be text; it is left out.`);
      return '';
    };
    const title = textField('title', true);
    const subtitle = textField('subtitle');
    const unit = textField('unit');
    const source = textField('source');
    const note = textField('note');

    let fatal = false;
    let x = [];
    const xCount = Array.isArray(raw.x) ? raw.x.length : 0;
    if (!Array.isArray(raw.x)) {
      errors.push(raw.x === undefined ? 'The chart has no "x": list its categories, such as ["2025", "2026"].' : '"x" must be a list of category labels.');
      fatal = true;
    } else if (xCount === 0) {
      errors.push('"x" is empty: list at least one category.');
      fatal = true;
    } else {
      const bad = [];
      x = raw.x.slice(0, MAX_CATEGORIES).map((v, i) => {
        if (typeof v === 'string') return oneLine(v);
        if (typeof v === 'number' && Number.isFinite(v)) return String(v);
        bad.push(i + 1);
        return '';
      });
      if (bad.length) errors.push(`"x" labels must be text or numbers; ${plural(bad.length, 'label', 'labels')} ${positions(bad)} ${plural(bad.length, 'is', 'are')} left blank.`);
      if (xCount > MAX_CATEGORIES) errors.push(`Only the first ${MAX_CATEGORIES} of ${xCount} categories are drawn.`);
    }

    const series = [];
    if (!Array.isArray(raw.series) || raw.series.length === 0) {
      errors.push(Array.isArray(raw.series) ? '"series" is empty: add at least one { "name": …, "values": […] }.'
        : raw.series === undefined ? 'The chart has no "series": add at least one { "name": …, "values": […] }.'
          : '"series" must be a list of { "name": …, "values": […] } objects.');
      fatal = true;
    } else {
      if (raw.series.length > MAX_SERIES) {
        const over = raw.series.length - MAX_SERIES;
        errors.push(`A chart holds at most ${MAX_SERIES} series; the last ${over === 1 ? 'one is' : `${over} are`} left out.`);
      }
      raw.series.slice(0, MAX_SERIES).forEach((s, k) => {
        if (s === null || typeof s !== 'object' || Array.isArray(s)) {
          errors.push(`Series ${k + 1} is not a { "name": …, "values": […] } object; it is left out.`);
          return;
        }
        let name = typeof s.name === 'string' ? oneLine(s.name) : typeof s.name === 'number' && Number.isFinite(s.name) ? String(s.name) : '';
        if (!name) {
          name = `Series ${k + 1}`;
          errors.push(`Series ${k + 1} has no "name".`);
        }
        const given = Array.isArray(s.values) ? s.values : [];
        if (!Array.isArray(s.values)) errors.push(`Series ${shown(name)} has no "values" list.`);
        else if (xCount && given.length !== xCount) {
          errors.push(`Series ${shown(name)} has ${given.length} ${plural(given.length, 'value', 'values')} for ${xCount} ${plural(xCount, 'category', 'categories')}; `
            + `${given.length < xCount ? 'the missing ones are gaps' : 'the extra ones are left out'}.`);
        }
        const bad = [];
        const values = x.map((_, i) => (i < given.length ? toNumber(given[i], () => bad.push(i + 1)) : null));
        if (bad.length) {
          errors.push(`Series ${shown(name)}: ${plural(bad.length, 'value', 'values')} ${positions(bad)} ${plural(bad.length, 'is not a number', 'are not numbers')}, `
            + `shown as ${plural(bad.length, 'a gap', 'gaps')}.`);
        }
        series.push({ name, values });
      });
      if (!fatal && series.length === 0) {
        errors.push('No series could be read, so there is nothing to draw.');
        fatal = true;
      }
    }
    if (!fatal && series.every((s) => s.values.every((v) => v === null))) {
      errors.push('Every value is empty, so there is nothing to draw.');
      fatal = true;
    }
    return { spec: fatal ? null : { type, title, subtitle, unit, x, series, source, note }, errors };
  }

  /* ------------------------------- drawing -------------------------------- */

  /** A bar with its data end rounded and its baseline end square. */
  function barPath(x, y, w, h, end) {
    const r = Math.min(RADIUS, w / 2, h);
    const X = p(x + w);
    const Y = p(y + h);
    const [x0, y0, rr] = [p(x), p(y), p(r)];
    switch (end) {
      case 'top':
        return `M${x0},${Y}V${p(y + r)}A${rr},${rr} 0 0 1 ${p(x + r)},${y0}H${p(x + w - r)}A${rr},${rr} 0 0 1 ${X},${p(y + r)}V${Y}Z`;
      case 'bottom':
        return `M${x0},${y0}H${X}V${p(y + h - r)}A${rr},${rr} 0 0 1 ${p(x + w - r)},${Y}H${p(x + r)}A${rr},${rr} 0 0 1 ${x0},${p(y + h - r)}Z`;
      case 'right':
        return `M${x0},${y0}H${p(x + w - r)}A${rr},${rr} 0 0 1 ${X},${p(y + r)}V${p(y + h - r)}A${rr},${rr} 0 0 1 ${p(x + w - r)},${Y}H${x0}Z`;
      case 'left':
        return `M${X},${y0}V${Y}H${p(x + r)}A${rr},${rr} 0 0 1 ${x0},${p(y + h - r)}V${p(y + r)}A${rr},${rr} 0 0 1 ${p(x + r)},${y0}Z`;
      default:
        return `M${x0},${y0}H${X}V${Y}H${x0}Z`;
    }
  }

  const barMark = (i, j, x, y, w, h, end) => `<path class="kc-bar kc-s${j + 1}" data-i="${i}" data-s="${j}" d="${barPath(x, y, w, h, end)}"/>`;
  const dot = (j, [x, y]) => `<circle class="kc-dot kc-s${j + 1}" cx="${p(x)}" cy="${p(y)}" r="${DOT}"/>`;
  /** A hover target: bigger than its mark, and the mark's index (and series) for `hydrate`. */
  const hitRect = (i, j, x, y, w, h) => `<rect class="kc-hit" data-i="${i}"${j === null ? '' : ` data-s="${j}"`} x="${p(x)}" y="${p(y)}" width="${p(Math.max(0, w))}" height="${p(Math.max(0, h))}"/>`;
  const label = (cls, x, y, text, anchor) => `<text class="${cls}" x="${p(x)}" y="${p(y)}"${anchor === 'start' ? '' : ` text-anchor="${anchor}"`}>${esc(text)}</text>`;

  function lastIndex(values) {
    for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return i;
    return -1;
  }

  /** What a single series labels directly: its last value, then its most extreme one. Never every value. */
  function labelPicks(values) {
    const last = lastIndex(values);
    if (last < 0) return [];
    let ext = last;
    values.forEach((v, i) => {
      if (v !== null && Math.abs(v) > Math.abs(values[ext])) ext = i;
    });
    return ext === last ? [last] : [last, ext];
  }

  /** Direct labels placed so far, as boxes: one that would touch another is left to the tooltip and the table. */
  function labelSet() {
    const boxes = [];
    return (x0, baseline, x1) => {
      const y0 = baseline - 9;
      const y1 = baseline + 2;
      if (boxes.some((b) => x0 < b[2] + 3 && x1 > b[0] - 3 && y0 < b[3] + 1 && y1 > b[1] - 1)) return false;
      boxes.push([x0, y0, x1, y1]);
      return true;
    };
  }

  /**
   * Category labels along a column chart's foot: every one when they fit,
   * else every k-th (counted from the last, so the latest shows), cut with an
   * ellipsis past what the spacing allows, and never two that touch.
   */
  function thinLabels(labels, step, at) {
    const n = labels.length;
    const natural = Math.max(0, ...labels.map(textWidth));
    let k = natural <= step - LABEL_GAP ? 1 : Math.max(1, Math.ceil((Math.min(natural, 110) + LABEL_GAP) / step));
    // a spacing that also lands on the first category shows both ends
    if (k > 1) for (let c = k; c <= k + 2 && c < n; c++) if ((n - 1) % c === 0) { k = c; break; }
    const room = k === 1 ? step - LABEL_GAP : Math.min(110, k * step - LABEL_GAP);
    const out = [];
    let edge = Infinity; // the left end of the label placed to the right
    for (let i = n - 1; i >= 0; i -= k) {
      const text = fit(labels[i], room);
      if (!text) continue;
      const w = textWidth(text);
      const cx = Math.min(Math.max(at(i), w / 2 + 2), W - w / 2 - 2);
      if (cx + w / 2 + LABEL_GAP > edge) continue;
      out.push({ i, text, cx, full: labels[i] });
      edge = cx - w / 2;
    }
    return out;
  }

  /** bar, stacked-bar, line and area: categories across, one value axis up the side. */
  function drawColumns(spec, notes) {
    const { type, x, series, unit } = spec;
    const n = x.length;
    const m = series.length;
    const stacked = type === 'stacked-bar';
    const lineLike = type === 'line' || type === 'area';

    let lo = Infinity;
    let hi = -Infinity;
    const totals = [];
    if (stacked) {
      // a stack adds up what is there: a negative value has no place in it
      let dropped = 0;
      lo = 0;
      hi = 0;
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (const s of series) {
          const v = s.values[i];
          if (v === null) continue;
          if (v < 0) dropped++;
          else sum += v;
        }
        totals.push(clean(sum));
        hi = Math.max(hi, sum);
      }
      if (dropped) notes.push(`${dropped} negative ${plural(dropped, 'value is', 'values are')} left out of the stacks; the data table lists ${plural(dropped, 'it', 'them')}.`);
    } else {
      for (const s of series) {
        for (const v of s.values) {
          if (v === null) continue;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    }
    const axis = valueAxis(type, lo, hi);
    const ticks = tickLabels(axis.ticks);
    const left = Math.ceil(Math.max(28, ...ticks.map((t) => textWidth(t) + 12)));
    const top = unit ? 30 : 20;
    const bottom = H - 26;
    const yAt = (v) => bottom - ((v - axis.min) / (axis.max - axis.min)) * (bottom - top);

    // the right margin holds the direct labels that ride past the last marks
    const named = m >= 2 && m <= 4 && (lineLike || stacked);
    const nameW = named ? Math.min(NAME_MAX, Math.max(...series.map((s) => textWidth(s.name)))) : 0;
    const stackWidth = (band) => Math.min(BAR_MAX, Math.max(band * 0.6, Math.min(1, band)));
    let right = W - 14;
    if (lineLike && m === 1) {
      const end = series[0].values[lastIndex(series[0].values)];
      right = W - Math.max(14, Math.ceil(textWidth(compact(end)) + DOT + 8));
    } else if (lineLike && named) {
      right = W - Math.ceil(nameW + DOT + 8);
    } else if (stacked && named) {
      for (let pass = 0; pass < 3; pass++) {
        const band = (right - left) / n;
        const over = right - (band - stackWidth(band)) / 2 + 6 + nameW + 2 - W;
        if (over <= 0) break;
        right -= over;
      }
    }

    const plotW = right - left;
    const band = lineLike ? 0 : plotW / n;
    const step = lineLike ? (n > 1 ? plotW / (n - 1) : plotW) : band;
    const xAt = (i) => (lineLike ? (n > 1 ? left + i * step : left + plotW / 2) : left + (i + 0.5) * band);
    const zero = axis.min <= 0 && axis.max >= 0 ? yAt(0) : bottom;

    const grid = [];
    const marks = [];
    const text = [];
    const hits = [];
    const place = labelSet();

    // gridlines and their ticks; zero, or the floor of an axis above it, is the baseline
    axis.ticks.forEach((t, k) => {
      const y = yAt(t);
      if (t !== 0 && !(k === 0 && axis.min > 0)) grid.push(`<line class="kc-grid" x1="${left}" x2="${p(right)}" y1="${p(y)}" y2="${p(y)}"/>`);
      text.push(label('kc-tick', left - 8, y + 3.5, ticks[k], 'end'));
    });
    const baseline = `<line class="kc-axis" x1="${left}" x2="${p(right)}" y1="${p(zero)}" y2="${p(zero)}"/>`;
    if (unit) text.push(label('kc-unit', 2, 12, fit(unit, W - 4), 'start'));
    for (const c of thinLabels(x, step, xAt)) {
      const whole = c.text === c.full ? '' : `<title>${esc(c.full)}</title>`;
      text.push(`<text class="kc-tick kc-cat" x="${p(c.cx)}" y="${bottom + 17}" text-anchor="middle">${esc(c.text)}${whole}</text>`);
    }

    if (type === 'bar') {
      // a group fills at most 72% of its band; when that crowds, the gaps narrow before the bars do
      const slot = band * 0.72;
      let gap = m > 1 ? GAP : 0;
      let bw = (slot - gap * (m - 1)) / m;
      if (bw < 2 && m > 1) {
        gap = 1;
        bw = (slot - (m - 1)) / m;
      }
      if (bw < 1) {
        gap = 0;
        bw = slot / m;
      }
      bw = Math.min(BAR_MAX, bw);
      const groupW = bw * m + gap * (m - 1);
      for (let i = 0; i < n; i++) {
        const gx = xAt(i) - groupW / 2;
        for (let j = 0; j < m; j++) {
          const bx = gx + j * (bw + gap);
          // the bar's share of its band, the plot's full height: short bars are as easy to hit as tall ones
          const h0 = j === 0 ? xAt(i) - band / 2 : bx - gap / 2;
          const h1 = j === m - 1 ? xAt(i) + band / 2 : bx + bw + gap / 2;
          hits.push(hitRect(i, j, h0, top, h1 - h0, bottom - top));
          const v = series[j].values[i];
          if (v === null) continue;
          const y = yAt(v);
          if (Math.abs(y - zero) < 0.5) continue;
          marks.push(barMark(i, j, bx, Math.min(y, zero), bw, Math.abs(y - zero), v >= 0 ? 'top' : 'bottom'));
        }
      }
      if (m === 1) {
        const values = series[0].values;
        for (const i of labelPicks(values)) {
          const v = values[i];
          // above a column's cap; below a negative one's end while that stays clear of the category labels
          if (v < 0 && yAt(v) > bottom - 5) continue;
          const t = compact(v);
          const w = textWidth(t);
          const y = v >= 0 ? yAt(v) - 5 : yAt(v) + 13;
          const cx = Math.min(Math.max(xAt(i), w / 2 + 2), W - w / 2 - 2);
          if (place(cx - w / 2, y, cx + w / 2)) text.push(label('kc-value', cx, y, t, 'middle'));
        }
      }
    }

    if (stacked) {
      const bw = stackWidth(band);
      let lastColumn = null;
      for (let i = 0; i < n; i++) {
        const cx = xAt(i);
        // the column answers hover too, so a gap or an empty column still has a tooltip
        hits.push(hitRect(i, null, cx - band / 2, top, band, bottom - top));
        let sum = 0;
        const segments = [];
        series.forEach((s, j) => {
          const v = s.values[i];
          if (v === null || v <= 0) return;
          segments.push({ j, y0: yAt(sum), y1: yAt(sum + v) });
          sum += v;
        });
        const drawn = [];
        segments.forEach((sg, k) => {
          const low = k === 0 ? sg.y0 : sg.y0 - GAP; // the surface gap to the segment below
          if (low - sg.y1 >= 0.5) drawn.push({ ...sg, low });
          // a segment's hit area takes in half of each gap; the top one reaches the top of the plot
          const hy0 = k === segments.length - 1 ? top : sg.y1 - GAP / 2;
          const hy1 = k === 0 ? bottom : sg.y0 - GAP / 2;
          hits.push(hitRect(i, sg.j, cx - band / 2, hy0, band, hy1 - hy0));
        });
        drawn.forEach((sg, k) => marks.push(barMark(i, sg.j, cx - bw / 2, sg.y1, bw, sg.low - sg.y1, k === drawn.length - 1 ? 'top' : 'none')));
        if (drawn.length) lastColumn = { cx, drawn };
      }
      if (named && lastColumn) {
        // the series' names beside the last column's segments, where one is tall enough to carry its name
        const lx = lastColumn.cx + bw / 2 + 6;
        for (const sg of lastColumn.drawn) {
          if (sg.low - sg.y1 < 12) continue;
          const y = (sg.y1 + sg.low) / 2 + 4;
          const t = fit(series[sg.j].name, W - 2 - lx);
          if (t && place(lx, y, lx + textWidth(t))) text.push(label('kc-name', lx, y, t, 'start'));
        }
      }
    }

    let points = [];
    if (lineLike) {
      points = series.map((s) => s.values.map((v, i) => (v === null ? null : [xAt(i), yAt(v)])));
      const washes = [];
      const lines = [];
      const dots = [];
      const dotted = new Set(); // `${j}:${i}` of the points that wear a dot
      points.forEach((row, j) => {
        let d = '';
        let run = [];
        const close = () => {
          // an area is washed down to zero under each unbroken run
          if (type === 'area' && run.length > 1) {
            const edge = run.map(([px, py]) => `L${p(px)},${p(py)}`).join('');
            washes.push(`<path class="kc-area kc-s${j + 1}" d="M${p(run[0][0])},${p(zero)}${edge}L${p(run[run.length - 1][0])},${p(zero)}Z"/>`);
          }
          run = [];
        };
        for (const pt of row) {
          if (!pt) {
            close(); // a gap: the line lifts and starts again after it
            continue;
          }
          d += `${run.length ? 'L' : 'M'}${p(pt[0])},${p(pt[1])}`;
          run.push(pt);
        }
        close();
        if (d) lines.push(`<path class="kc-line kc-s${j + 1}" d="${d}"/>`);
        const end = lastIndex(series[j].values);
        row.forEach((pt, i) => {
          // the last point gets a dot, and so does one with no neighbour, which draws no line
          if (pt && (i === end || (!row[i - 1] && !row[i + 1]))) {
            dots.push(dot(j, pt));
            dotted.add(`${j}:${i}`);
          }
        });
      });

      if (m === 1) {
        const values = series[0].values;
        const [end, ext] = labelPicks(values);
        const [ex, ey] = points[0][end];
        const t = compact(values[end]);
        const lx = ex + DOT + 4;
        if (place(lx, ey + 4, lx + textWidth(t))) text.push(label('kc-value', lx, ey + 4, t, 'start'));
        if (ext !== undefined) {
          const v = values[ext];
          const [px, py] = points[0][ext];
          const et = compact(v);
          const w = textWidth(et);
          const y = v >= 0 ? py - 10 : py + 18;
          const cx = Math.min(Math.max(px, w / 2 + 2), W - w / 2 - 2);
          if (y <= bottom - 2 && place(cx - w / 2, y, cx + w / 2)) {
            // the extreme's label sits on a dot of its own
            text.push(label('kc-value', cx, y, et, 'middle'));
            if (!dotted.has(`0:${ext}`)) dots.push(dot(0, [px, py]));
          }
        }
      } else if (named) {
        // each series' name at its last point, unless it would touch another's
        series.forEach((s, j) => {
          const i = lastIndex(s.values);
          if (i < 0) return;
          const [px, py] = points[j][i];
          const t = fit(s.name, NAME_MAX);
          const lx = px + DOT + 4;
          if (t && place(lx, py + 4, lx + textWidth(t))) text.push(label('kc-name', lx, py + 4, t, 'start'));
        });
      }
      marks.push(...washes, ...lines, ...dots);
      const hx0 = Math.max(0, left - step / 2);
      const hx1 = Math.min(W, right + step / 2);
      hits.push(`<rect class="kc-hit kc-hit-x" x="${p(hx0)}" y="${top}" width="${p(hx1 - hx0)}" height="${bottom - top}"/>`);
    }

    const geom = { k: type, plot: [left, top, right, bottom].map(p), at: x.map((_, i) => p(xAt(i))) };
    if (lineLike) geom.y = points.map((row) => row.map((pt) => (pt ? p(pt[1]) : null)));
    if (stacked) geom.tot = totals;
    // a line rides over the baseline; a bar stands on it
    const body = `<g class="kc-grid-layer">${grid.join('')}${lineLike ? baseline : ''}</g>`
      + `<g class="kc-marks">${marks.join('')}</g>${lineLike ? '' : baseline}`
      + `<g class="kc-text">${text.join('')}</g>`
      + `<g class="kc-hits">${hits.join('')}</g>`;
    return { height: H, body, geom };
  }

  /** hbar: a row per category, its label in a column on the left, the value axis along the foot. */
  function drawRows(spec) {
    const { x, series, unit } = spec;
    const n = x.length;
    const m = series.length;
    const thick = m === 1 ? 16 : m === 2 ? 10 : m === 3 ? 8 : m <= 5 ? 6 : 4;
    const gap = m > 1 ? GAP : 0;
    const groupH = m * thick + (m - 1) * gap;
    const rowH = m === 1 ? 26 : groupH + 10;

    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series) {
      for (const v of s.values) {
        if (v === null) continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    const axis = valueAxis('hbar', lo, hi);
    const ticks = tickLabels(axis.ticks);
    const left = Math.ceil(Math.max(40, Math.min(ROW_LABEL_MAX, Math.max(...x.map(textWidth))) + 14));
    // a single series' values ride at the tips of the bars they label
    const picks = m === 1 ? labelPicks(series[0].values) : [];
    const tipW = picks.length ? Math.max(...picks.map((i) => textWidth(compact(series[0].values[i])))) + 10 : 0;
    const right = W - Math.max(16, Math.ceil(tipW));
    const top = 4;
    const bottom = top + n * rowH;
    const xAt = (v) => left + ((v - axis.min) / (axis.max - axis.min)) * (right - left);
    const zero = xAt(0);

    const grid = [];
    const marks = [];
    const text = [];
    const hits = [];
    const place = labelSet();

    let edge = -Infinity; // the right end of the tick label placed last
    let first = null; // the left end of the first
    axis.ticks.forEach((t, k) => {
      const tx = xAt(t);
      if (t !== 0) grid.push(`<line class="kc-grid" x1="${p(tx)}" x2="${p(tx)}" y1="${top}" y2="${bottom}"/>`);
      const w = textWidth(ticks[k]);
      const cx = Math.min(Math.max(tx, w / 2 + 2), W - w / 2 - 2);
      if (cx - w / 2 < edge + LABEL_GAP) return;
      text.push(label('kc-tick', cx, bottom + 15, ticks[k], 'middle'));
      if (first === null) first = cx - w / 2;
      edge = cx + w / 2;
    });
    const baseline = `<line class="kc-axis" x1="${p(zero)}" x2="${p(zero)}" y1="${top}" y2="${bottom}"/>`;
    // the unit heads the value axis, in the label column's empty foot; a long one takes a line of its own under it
    let height = bottom + 22;
    if (unit) {
      const ux = (first ?? left) - 8;
      if (textWidth(unit) <= ux - 2) text.push(label('kc-unit', ux, bottom + 15, unit, 'end'));
      else {
        text.push(label('kc-unit', right, bottom + 30, fit(unit, right - 2), 'end'));
        height += 14;
      }
    }

    const rowCenter = [];
    for (let i = 0; i < n; i++) {
      const rowTop = top + i * rowH;
      const cy = rowTop + rowH / 2;
      rowCenter.push(p(cy));
      text.push(label('kc-cat kc-row', left - 8, cy + 4, fit(x[i], left - 14), 'end'));
      const gy = cy - groupH / 2;
      for (let j = 0; j < m; j++) {
        const by = gy + j * (thick + gap);
        // the whole width of the bar's share of its row, its label included
        const h0 = j === 0 ? rowTop : by - gap / 2;
        const h1 = j === m - 1 ? rowTop + rowH : by + thick + gap / 2;
        hits.push(hitRect(i, j, 0, h0, W, h1 - h0));
        const v = series[j].values[i];
        if (v === null) continue;
        const bx = xAt(v);
        if (Math.abs(bx - zero) < 0.5) continue;
        marks.push(barMark(i, j, Math.min(bx, zero), by, Math.abs(bx - zero), thick, v >= 0 ? 'right' : 'left'));
      }
    }
    for (const i of picks) {
      const v = series[0].values[i];
      const t = compact(v);
      const w = textWidth(t);
      const y = top + i * rowH + rowH / 2 + 4;
      const bx = xAt(v);
      if (v >= 0) {
        if (place(bx + 6, y, bx + 6 + w)) text.push(label('kc-value', bx + 6, y, t, 'start'));
      } else if (bx - 6 - w >= left && place(bx - 6 - w, y, bx - 6)) {
        text.push(label('kc-value', bx - 6, y, t, 'end'));
      }
    }

    const geom = { k: 'hbar', plot: [left, top, right, bottom].map(p), at: rowCenter };
    const body = `<g class="kc-grid-layer">${grid.join('')}</g><g class="kc-marks">${marks.join('')}</g>${baseline}`
      + `<g class="kc-text">${text.join('')}</g><g class="kc-hits">${hits.join('')}</g>`;
    return { height: p(height), body, geom };
  }

  /** What the chart shows, in a sentence, for a screen reader: the span of categories and each series' range. */
  function describe(spec) {
    const { x, series, unit } = spec;
    const span = x.length > 1 ? `${x[0]} to ${x[x.length - 1]}` : x[0];
    const parts = series.map((s) => {
      const values = s.values.filter((v) => v !== null);
      if (!values.length) return `${s.name}: no values`;
      const lo = Math.min(...values);
      const hi = Math.max(...values);
      return `${s.name} ${lo === hi ? fullNumber(lo) : `${fullNumber(lo)} to ${fullNumber(hi)}`}${unit ? ` ${unit}` : ''}`;
    });
    return `${x.length} ${plural(x.length, 'category', 'categories')}, ${span}. ${parts.join('; ')}.`;
  }

  /** Two or more series: names beside a swatch that mirrors the mark. One series needs none: the title names it. */
  function legend(spec) {
    if (spec.series.length < 2) return '';
    const key = spec.type === 'line' ? 'kchart-key-line' : 'kchart-key-box';
    const items = spec.series.map((s, j) => `<li><span class="kchart-key ${key} kc-s${j + 1}" aria-hidden="true"></span>${esc(s.name)}</li>`);
    return `<ul class="kchart-legend" aria-label="Legend">${items.join('')}</ul>`;
  }

  /** The numbers drawn, as a table: every value reachable without hovering. */
  function dataTable(spec) {
    const { x, series, unit } = spec;
    const head = series.map((s) => `<th scope="col" class="kc-num">${esc(s.name)}</th>`).join('');
    const rows = x.map((cat, i) => {
      const cells = series.map((s) => {
        const v = s.values[i];
        return `<td class="kc-num${v === null ? ' kc-gap' : ''}">${esc(fullNumber(v))}</td>`;
      });
      return `<tr><th scope="row">${esc(cat)}</th>${cells.join('')}</tr>`;
    });
    const attrs = unit ? ` data-unit="${esc(unit)}"` : '';
    const caption = unit ? `<caption>Values in ${esc(unit)}</caption>` : '';
    return `<details class="kchart-data"><summary>Data</summary><div class="kchart-table-wrap"><table class="kchart-table"${attrs}>${caption}`
      + `<thead><tr><th scope="col">Category</th>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></div></details>`;
  }

  function figure(spec, problems) {
    const notes = [];
    const chart = spec.type === 'hbar' ? drawRows(spec) : drawColumns(spec, notes);
    const { type, title, subtitle, x, series } = spec;
    const n = x.length;
    const m = series.length;
    const name = `${TYPE_NAMES[type]}: ${title || 'untitled'}, ${n} ${plural(n, 'category', 'categories')}, ${m} series`;
    const svg = `<svg class="kchart-svg" viewBox="0 0 ${W} ${chart.height}" width="100%" preserveAspectRatio="xMidYMid meet" role="img"`
      + ` aria-label="${esc(name)}" data-kc="${esc(JSON.stringify(chart.geom))}"><title>${esc(title || TYPE_NAMES[type])}</title>`
      + `<desc>${esc(describe(spec))}</desc>${chart.body}</svg>`;
    const head = title || subtitle
      ? `<figcaption class="kchart-head">${title ? `<span class="kchart-title">${esc(title)}</span>` : ''}${subtitle ? `<span class="kchart-subtitle">${esc(subtitle)}</span>` : ''}</figcaption>`
      : '';
    let foot = '';
    if (spec.note) foot += `<p class="kchart-note"><span class="kchart-label">Note</span> ${esc(spec.note)}</p>`;
    for (const note of notes) foot += `<p class="kchart-note">${esc(note)}</p>`;
    if (spec.source) foot += `<p class="kchart-source"><span class="kchart-label">Source</span> ${esc(spec.source)}</p>`;
    if (problems.length) {
      foot += `<div class="kchart-issues"><p class="kchart-issues-title"><span aria-hidden="true">⚠</span> Drawn from a spec with problems</p>`
        + `<ul>${problems.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
    }
    return `<figure class="kchart kchart-${type}" data-kchart="${type}">${head}${legend(spec)}<div class="kchart-plot">${svg}</div>${foot}${dataTable(spec)}</figure>`;
  }

  /** Why a block could not be drawn, above the JSON as it was written. */
  function errorBox(errors, text) {
    const items = errors.map((e) => `<li>${esc(e)}</li>`).join('');
    return `<div class="kchart-error"><p class="kchart-error-title">Chart not drawn</p><ul>${items}</ul>`
      + `<pre><code class="language-chart">${esc(String(text ?? '').replace(/\n+$/, ''))}</code></pre></div>`;
  }

  /** A ```chart block's text as markup: the figure, or why it cannot be drawn above the escaped JSON. */
  function render(text) {
    const { spec, errors } = parse(text);
    if (!spec) return errorBox(errors, text);
    try {
      return figure(spec, errors);
    } catch (e) {
      // a spec this file draws wrongly still shows its data, and why
      return errorBox([...errors, `The chart could not be drawn: ${e?.message ?? e}`], text);
    }
  }

  /* -------------------------------- hover --------------------------------- */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const hydrated = new WeakSet();

  /**
   * The hover layer for every chart under `root` (the document when left
   * out): a tooltip per bar or segment, a crosshair with every series' value
   * on lines and areas, and the same readout from the keyboard (focus the
   * chart, then the arrow keys, Home, End, Escape). Each chart is wired
   * once, so calling this again after more Markdown arrives is safe.
   */
  function hydrate(root) {
    const scope = root ?? global.document;
    if (!scope || typeof scope.querySelectorAll !== 'function') return;
    const figures = [...scope.querySelectorAll('figure.kchart')];
    if (typeof scope.matches === 'function' && scope.matches('figure.kchart')) figures.unshift(scope);
    for (const fig of figures) {
      if (hydrated.has(fig)) continue;
      hydrated.add(fig);
      try {
        wire(fig);
      } catch {
        // the hover layer is extra: the chart, its labels and its table read the same without it
      }
    }
  }

  function wire(fig) {
    const doc = fig.ownerDocument;
    const plot = fig.querySelector('.kchart-plot');
    const svg = plot && plot.querySelector('svg.kchart-svg');
    const table = fig.querySelector('table.kchart-table');
    if (!svg || !table || !table.tHead || !table.tBodies[0]) return;
    const geom = JSON.parse(svg.getAttribute('data-kc') || 'null');
    if (!geom || !Array.isArray(geom.at)) return;
    const kind = geom.k;
    const lineLike = kind === 'line' || kind === 'area';
    // what the tooltip says comes from the table, so the two always agree
    const names = [...table.tHead.rows[0].cells].slice(1).map((c) => c.textContent);
    const rows = [...table.tBodies[0].rows].map((r) => [...r.cells].map((c) => c.textContent));
    const unit = table.getAttribute('data-unit') || '';
    const n = rows.length;
    const [, plotTop, , plotBottom] = geom.plot;
    const vbWidth = svg.viewBox.baseVal.width || W;

    const el = (tag, cls, text) => {
      const e = doc.createElement(tag);
      e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const tip = el('div', 'kchart-tip');
    tip.hidden = true;
    plot.append(tip);

    // lines and areas: a crosshair that snaps to the nearest category, with a dot on each series
    let hover = null;
    let cross = null;
    let hoverDots = [];
    if (lineLike) {
      hover = doc.createElementNS(SVG_NS, 'g');
      hover.setAttribute('class', 'kc-hover');
      cross = doc.createElementNS(SVG_NS, 'line');
      cross.setAttribute('class', 'kc-cross');
      cross.setAttribute('y1', String(plotTop));
      cross.setAttribute('y2', String(plotBottom));
      hover.append(cross);
      hoverDots = names.map((_, j) => {
        const c = doc.createElementNS(SVG_NS, 'circle');
        c.setAttribute('class', `kc-dot kc-s${j + 1}`);
        c.setAttribute('r', String(DOT));
        hover.append(c);
        return c;
      });
      svg.insertBefore(hover, svg.querySelector('.kc-hits'));
    }

    let active = -1;
    let showing = null; // what the tooltip reads now, so a pointer moving over the same mark changes nothing
    let lit = [];
    function light(selector) {
      for (const e of lit) e.classList.remove('kc-hot');
      lit = selector ? [...svg.querySelectorAll(selector)] : [];
      for (const e of lit) e.classList.add('kc-hot');
      svg.classList.toggle('kc-hovering', lit.length > 0);
    }

    /** The readout for category `i`: the value leads and the series' name follows; `only` limits it to one bar, `hot` marks a segment. */
    function fill(i, only, hot) {
      tip.replaceChildren(el('div', 'kchart-tip-head', rows[i][0] || '—'));
      let order = names.map((_, j) => j);
      if (kind === 'stacked-bar') order.reverse(); // read top down, as the stack stands
      if (only !== undefined) order = [only];
      for (const j of order) {
        const value = rows[i][j + 1];
        const row = el('div', `kchart-tip-row${j === hot ? ' kc-hot' : ''}`);
        row.append(el('span', `kchart-tip-key kc-s${j + 1}`), el('span', 'kchart-tip-val', value));
        if (unit && value !== '—') row.append(el('span', 'kchart-tip-unit', unit));
        row.append(el('span', 'kchart-tip-name', names[j]));
        tip.append(row);
      }
      if (kind === 'stacked-bar' && only === undefined && names.length > 1 && Array.isArray(geom.tot)) {
        const row = el('div', 'kchart-tip-row kchart-tip-total');
        row.append(el('span', 'kchart-tip-key'), el('span', 'kchart-tip-val', fullNumber(geom.tot[i])));
        if (unit) row.append(el('span', 'kchart-tip-unit', unit));
        row.append(el('span', 'kchart-tip-name', 'Total'));
        tip.append(row);
      }
      tip.hidden = false;
    }

    /** viewBox units to pixels in the plot box, where the tooltip is positioned. */
    function toPlot(sx, sy) {
      const box = svg.getBoundingClientRect();
      const outer = plot.getBoundingClientRect();
      const k = box.width / vbWidth || 1;
      return [box.left - outer.left + sx * k, box.top - outer.top + sy * k];
    }

    /**
     * Puts the tooltip beside what it reads: right of `sx`, or left of
     * `sxLeft` when there is no room on the right, so it never covers its
     * own mark; vertically centred on `sy` and kept inside the plot.
     */
    function placeTip(sx, sy, sxLeft = sx) {
      const [ax, ay] = toPlot(sx, sy);
      const [axLeft] = toPlot(sxLeft, sy);
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      const pw = plot.clientWidth;
      let left = ax + 12;
      if (left + tw > pw) left = axLeft - 12 - tw;
      if (left < 0) left = Math.max(0, pw - tw);
      const topPx = Math.max(0, Math.min(ay - th / 2, plot.clientHeight - th));
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(topPx)}px`;
    }

    /** Under a row of an hbar (over it when the plot ends first), centred on `sx`. */
    function placeUnder(sx, syTop, syBottom) {
      const [ax, ayTop] = toPlot(sx, syTop);
      const [, ayBottom] = toPlot(sx, syBottom);
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      const left = Math.max(0, Math.min(ax - tw / 2, plot.clientWidth - tw));
      let topPx = ayBottom + 6;
      if (topPx + th > plot.clientHeight) topPx = Math.max(0, ayTop - 6 - th);
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(topPx)}px`;
    }

    /** Beside the marks a selector finds, or where the category stands when it has none (a gap, a zero). */
    function placeBy(selector, i) {
      const marks = [...svg.querySelectorAll(selector)];
      if (!marks.length) {
        if (kind === 'hbar') placeUnder(geom.plot[0], geom.at[i] - 8, geom.at[i] + 8);
        else placeTip(geom.at[i], plotBottom);
        return;
      }
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const mark of marks) {
        const b = mark.getBBox();
        x0 = Math.min(x0, b.x);
        y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.width);
        y1 = Math.max(y1, b.y + b.height);
      }
      if (kind === 'hbar') placeUnder((x0 + x1) / 2, y0, y1);
      else placeTip(x1, y0 + Math.min(12, (y1 - y0) / 2), x0);
    }

    function showLine(i) {
      active = i;
      fill(i);
      cross.setAttribute('x1', String(geom.at[i]));
      cross.setAttribute('x2', String(geom.at[i]));
      let high = plotTop + (plotBottom - plotTop) / 3;
      let any = false;
      hoverDots.forEach((c, j) => {
        const y = geom.y?.[j]?.[i];
        if (typeof y !== 'number') {
          c.classList.add('kc-off');
          return;
        }
        c.classList.remove('kc-off');
        c.setAttribute('cx', String(geom.at[i]));
        c.setAttribute('cy', String(y));
        high = any ? Math.min(high, y) : y;
        any = true;
      });
      hover.classList.add('kc-on');
      placeTip(geom.at[i], high);
    }

    /** From the keyboard: a whole category, every series. */
    function showIndex(i) {
      showing = `key:${i}`;
      if (lineLike) return showLine(i);
      active = i;
      fill(i);
      light(`.kc-bar[data-i="${i}"]`);
      placeBy(`.kc-bar[data-i="${i}"]`, i);
      return undefined;
    }

    function hide() {
      active = -1;
      showing = null;
      tip.hidden = true;
      light(null);
      if (hover) hover.classList.remove('kc-on');
    }

    const svgX = (event) => {
      const box = svg.getBoundingClientRect();
      return (event.clientX - box.left) * (vbWidth / (box.width || 1));
    };
    const nearest = (sx) => {
      let best = 0;
      for (let i = 1; i < geom.at.length; i++) if (Math.abs(geom.at[i] - sx) < Math.abs(geom.at[best] - sx)) best = i;
      return best;
    };

    function onPointer(event) {
      const hit = event.target && typeof event.target.closest === 'function' ? event.target.closest('.kc-hit') : null;
      if (!hit) return hide();
      const i = lineLike ? nearest(svgX(event)) : Number(hit.getAttribute('data-i'));
      if (!(i >= 0 && i < n)) return hide();
      const s = !lineLike && hit.hasAttribute('data-s') ? Number(hit.getAttribute('data-s')) : undefined;
      const key = `${i}:${s}`;
      if (key === showing) return undefined;
      showing = key;
      tip.removeAttribute('aria-live'); // a pointer needs no announcements; the keyboard path turns them on
      if (lineLike) return showLine(i);
      active = i;
      if (kind === 'stacked-bar') {
        // the whole stack, read top down, the segment under the pointer marked
        fill(i, undefined, s);
        light(s === undefined ? null : `.kc-bar[data-i="${i}"][data-s="${s}"]`);
        placeBy(`.kc-bar[data-i="${i}"]`, i);
      } else {
        // the bar under the pointer: its category and value
        fill(i, s);
        light(`.kc-bar[data-i="${i}"][data-s="${s}"]`);
        placeBy(`.kc-bar[data-i="${i}"][data-s="${s}"]`, i);
      }
      return undefined;
    }

    svg.addEventListener('pointermove', onPointer);
    svg.addEventListener('pointerdown', onPointer);
    // a finger lifting leaves at once: a tapped readout stays until the chart loses focus or another mark is tapped
    svg.addEventListener('pointerleave', (event) => {
      if (event.pointerType !== 'touch') hide();
    });

    plot.tabIndex = 0;
    plot.setAttribute('role', 'group');
    plot.setAttribute('aria-label', `${svg.getAttribute('aria-label') || 'Chart'}. The arrow keys read the values.`);
    const back = kind === 'hbar' ? 'ArrowUp' : 'ArrowLeft';
    const ahead = kind === 'hbar' ? 'ArrowDown' : 'ArrowRight';
    plot.addEventListener('keydown', (event) => {
      let i;
      if (event.key === ahead) i = active < 0 ? 0 : Math.min(n - 1, active + 1);
      else if (event.key === back) i = active < 0 ? n - 1 : Math.max(0, active - 1);
      else if (event.key === 'Home') i = 0;
      else if (event.key === 'End') i = n - 1;
      else if (event.key === 'Escape') return hide();
      else return undefined;
      event.preventDefault();
      tip.setAttribute('aria-live', 'polite');
      return showIndex(i);
    });
    plot.addEventListener('focus', () => {
      let keyboard = true;
      try {
        keyboard = plot.matches(':focus-visible');
      } catch {
        // an engine without :focus-visible: treat focus as the keyboard's
      }
      if (keyboard && active < 0) {
        tip.setAttribute('aria-live', 'polite');
        showIndex(0);
      }
    });
    plot.addEventListener('blur', hide);
  }

  global.knodeChart = { parse, render, hydrate };
})(globalThis);
