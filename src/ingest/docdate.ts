import path from 'node:path';
import { dateStart } from '../store/dates.js';

/**
 * A source's reference date: when its content is *about*. Read from
 * frontmatter first (`date`, `published`, `as_of`, OKF `generated.at` …),
 * then from a date in the path (`reports/2026-05-catl.md`, `20260510.pdf`),
 * then, for a raw document, from a dateline at its top (`dateFromContent`:
 * a line that is a date and nothing else). Never the file mtime — copying a
 * workspace would silently re-date every claim and break idempotent
 * re-ingest.
 */
const FRONTMATTER_KEYS = ['date', 'doc_date', 'docDate', 'published', 'published_at', 'publishedAt', 'as_of', 'asOf', 'report_date', 'reportDate', 'issued', 'created'];

export function docDateOf(
  file: string,
  frontmatter: Record<string, unknown> | undefined | null,
  /** The text of a raw document, to read a dateline from; and when it is being indexed (a dateline later than that is no date of the document). */
  content?: string | null,
  indexedAt?: string | null,
): string | null {
  const fm = frontmatter ?? {};
  for (const key of FRONTMATTER_KEYS) {
    const v = fm[key];
    if (v === undefined || v === null || v === '') continue;
    const iso = dateStart(v);
    if (iso) return iso;
  }
  const generated = fm.generated;
  if (generated && typeof generated === 'object' && !Array.isArray(generated)) {
    const at = (generated as Record<string, unknown>).at;
    const iso = dateStart(at);
    if (iso) return iso;
  }
  return dateFromPath(file) ?? (content ? dateFromContent(content, indexedAt) : null);
}

/** How far into a document its dateline may stand: among its first lines, title included. */
const DATELINE_LINES = 8;
const DATELINE_CHARS = 1_200;
/** The longest range that is a report's own period (a week, a fortnight, a month). */
const REPORT_PERIOD_DAYS = 31;
const DAY_MS = 86_400_000;

/** A full date in digits, day included: `2025-08-25`, `2025/8/25`, `2025年8月25日`, and `2025.08.25` (which is also how a version is written). */
const NUMERIC_DATE = /^((?:19|20)\d{2})(-|\/|\.|\s*年\s*)(1[0-2]|0?[1-9])(?:-|\/|\.|\s*月\s*)(3[01]|[12]\d|0?[1-9])(?:\s*[日号])?(?!\d)/;
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
/** `March 1, 2025`, `Aug. 29th, 2025` and `1 March 2025`. */
const MONTH_FIRST = new RegExp(String.raw`^${MONTH}\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})(?!\d)`, 'i');
const DAY_FIRST = new RegExp(String.raw`^(\d{1,2})(?:st|nd|rd|th)?\s+${MONTH},?\s+((?:19|20)\d{2})(?!\d)`, 'i');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** A label that says the document's date follows. Not a statistics period, a deadline or a plan. */
const DATELINE_LABEL = /^(?:日期|时间|发布时间|发布日期|报告日期|报告期|date|dated|published|posted|as of)(?:\s*[:：]\s*|\s+)/i;
const RANGE_SEPARATOR = /^\s*(?:~|～|—|–|-|至|到|to)\s*/i;
/** A line that is an entry of something else: a list item ("- …", "1. …"), a heading, a quote, a table row. */
const NOT_A_DATELINE = /^(?:[-*+]\s|\d{1,3}[.)、]\s|#|>|\|)/;
const WEEKDAY_NAME = String.raw`(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\.?`;
/** "Friday, " ahead of a date. */
const WEEKDAY_AHEAD = new RegExp(String.raw`^${WEEKDAY_NAME},?\s+`, 'i');
/** A weekday behind a date, in brackets or not: （周五）, 星期五, (Fri). */
const WEEKDAY_BEHIND = new RegExp(String.raw`^\s*[（(]?\s*(?:(?:周|星期|礼拜)[一二三四五六日天]|${WEEKDAY_NAME})\s*[）)]?`, 'i');
/** A time of day behind a date: 14:30, 09:30:00 UTC, 下午 2:30, T14:30+08:00. */
const TIME = /^(?:T|\s+)\s*(?:上午|下午|am|pm)?\s*\d{1,2}[:：]\d{2}(?:[:：]\d{2})?(?:\s*(?:am|pm))?(?:\s*(?:utc|gmt|z|[+-]\d{1,2}(?::?\d{2})?))?(?![\d:：])/i;
const BYLINE_LEAD = /^(?:[·•|]\s*|[,，]\s*(?=by\s|作者|记录|撰写|整理)|by\s+|(?:作者|记录|撰写|整理)[:：]\s*)/i;
const BYLINE_LABEL = /^(?:by\s+|(?:作者|记录|撰写|整理)[:：]\s*)(?=\S)/i;

interface DateToken {
  iso: string;
  length: number;
  /** Written with dots, and with two digits each for month and day. */
  dotted: boolean;
  padded: boolean;
}

/** The full date a text opens with, or null. */
function dateAt(text: string): DateToken | null {
  const day = (y: string, month: number | string, d: string) => dateStart(`${y}-${String(month).padStart(2, '0')}-${d.padStart(2, '0')}`);
  let m = NUMERIC_DATE.exec(text);
  if (m) {
    const iso = day(m[1], m[3], m[4]);
    return iso ? { iso, length: m[0].length, dotted: m[2] === '.', padded: m[3].length === 2 && m[4].length === 2 } : null;
  }
  const monthOf = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
  m = MONTH_FIRST.exec(text);
  if (m) {
    const iso = day(m[3], monthOf(m[1]), m[2]);
    return iso ? { iso, length: m[0].length, dotted: false, padded: true } : null;
  }
  m = DAY_FIRST.exec(text);
  if (m) {
    const iso = day(m[3], monthOf(m[2]), m[1]);
    return iso ? { iso, length: m[0].length, dotted: false, padded: true } : null;
  }
  return null;
}

/**
 * What stands behind the date on its line, if it is only what a dateline
 * carries: a weekday, a time of day, a byline behind a dot, a bar, a comma or
 * "by" ("· 龙杰", "| by Lin", ", by Lin", "· 作者：王芳") — a few words with
 * no sentence punctuation. Null when anything else follows.
 */
function datelineTail(rest: string): { weekday: boolean; time: boolean; byline: boolean } | null {
  const seen = { weekday: false, time: false, byline: false };
  let r = rest;
  for (let i = 0; i < 2; i++) {
    const time = seen.time ? null : TIME.exec(r);
    if (time) {
      seen.time = true;
      r = r.slice(time[0].length);
      continue;
    }
    const weekday = seen.weekday ? null : WEEKDAY_BEHIND.exec(r);
    if (weekday && /^(?:\s|$|[·•|,，])/.test(r.slice(weekday[0].length))) {
      seen.weekday = true;
      r = r.slice(weekday[0].length);
    }
  }
  r = r.trim();
  if (!r) return seen;
  const lead = BYLINE_LEAD.exec(r);
  if (!lead) return null;
  r = r.slice(lead[0].length).replace(BYLINE_LABEL, '').trim();
  if (r.length === 0 || r.length > 30 || /[。！？!?；;，,：:]/.test(r)) return null;
  seen.byline = true;
  return seen;
}

/**
 * The date a document states at its top, or null. A dateline is a line among
 * the document's first few that is a date and nothing else: optionally a
 * label ("日期：", "Date:"), a full date in digits or with the month by name,
 * optionally a second date that ends a range, optionally a weekday, a time of
 * day or a short byline ("2025-08-25 ~ 2025-08-29 · 龙杰", "日期：2025年8月29日",
 * "**Date:** 2025/8/5, by Lin", "Date: March 1, 2025", "时间：2025-08-25
 * 14:30", "2025年8月29日 星期五").
 *
 * Not a dateline, because each of these was read as one (review, 2026-11-15):
 *   - a sentence that opens with a date ("2019年3月1日，公司在深圳成立…",
 *     "2027-06-30 — 完成迁移"): anything after the date but a weekday, a time
 *     or a byline;
 *   - an entry of a list, a heading, a quote or a table ("- 2023-01-05 -
 *     initial release", "## 2023-01-05", "> 日期：2024年1月5日"): a changelog,
 *     a quoted mail;
 *   - a dotted date that stands alone ("2025.8.1", "2024.02.03"): a version
 *     number. Dotted dates count behind a label or in a range, with two
 *     digits each for month and day;
 *   - a bare date — no label, range, weekday, time or byline — anywhere but
 *     directly under the title (the first line, or the second): a birth date
 *     in a biography. Directly under the title a bare date is read; a
 *     biography that opens with one is dated by it, because a date decades
 *     before the others in a text cannot be told from a plan whose horizon is
 *     decades after its own date;
 *   - a date later than the day the document is indexed (a deadline, a plan);
 *   - a range longer than REPORT_PERIOD_DAYS, or one that starts in the
 *     future (a statistics period, a plan's year): such a range says what the
 *     document covers, not when it is from.
 *
 * Of a range that is a report's own period — a week, a fortnight, a month —
 * the document's date is the **end**: the report is written when its period
 * is over, and a claim dated by its document must not be dated before what it
 * reports. A report indexed while its period is still running is dated by the
 * day it is indexed — nothing in it is later — until it is indexed again.
 */
export function dateFromContent(content: string, indexedAt?: string | null): string | null {
  const indexed = Date.parse(indexedAt ?? new Date().toISOString());
  const today = new Date(indexed).toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const latest = indexed + DAY_MS; // a day's grace: the writer's "today" may be ahead of UTC
  const lines = content.slice(0, DATELINE_CHARS).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, DATELINE_LINES);
  for (const [index, raw] of lines.entries()) {
    if (NOT_A_DATELINE.test(raw)) continue;
    let line = raw.replace(/\*\*|__/g, '').replace(/^[*_]|[*_]$/g, '').trim();
    const label = DATELINE_LABEL.exec(line);
    if (label) line = line.slice(label[0].length).trim();
    const ahead = WEEKDAY_AHEAD.exec(line);
    if (ahead) line = line.slice(ahead[0].length);
    const first = dateAt(line);
    if (!first) continue;
    let rest = line.slice(first.length);
    const leadTime = TIME.exec(rest);
    let second: DateToken | null = null;
    const separator = RANGE_SEPARATOR.exec(leadTime ? rest.slice(leadTime[0].length) : rest);
    if (separator) {
      const after = (leadTime ? rest.slice(leadTime[0].length) : rest).slice(separator[0].length);
      second = dateAt(after);
      if (second) rest = after.slice(second.length);
    }
    const tail = datelineTail(rest);
    if (!tail) continue;
    if ((first.dotted && !(first.padded && (label || second))) || (second?.dotted && !second.padded)) continue;
    // a date with nothing to it is a dateline only where one stands: directly under the title
    const marked = Boolean(label || second || ahead || tail.weekday || tail.time || tail.byline);
    if (!marked && index > 1) continue;
    if (Date.parse(first.iso) > latest) continue;
    if (!second) return first.iso;
    if (second.iso < first.iso || Date.parse(second.iso) - Date.parse(first.iso) > REPORT_PERIOD_DAYS * DAY_MS) continue;
    // its own period: the end, or while the period is still running the day it is indexed
    if (Date.parse(second.iso) <= latest) return second.iso;
    return today > first.iso ? today : first.iso;
  }
  return null;
}

/** `2026-05-10`, `2026_05_10`, `20260510`, `2026-05`, `2026年5月` anywhere in the file name or its parent folders. */
export function dateFromPath(file: string): string | null {
  const segments = file.replace(/\\/g, '/').split('/');
  const base = path.posix.basename(file).replace(/\.[^.]+$/, '');
  const candidates = [base, ...segments.slice(0, -1).reverse()];
  for (const seg of candidates) {
    let m: RegExpExecArray | null;
    if ((m = /(?:^|\D)((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)/.exec(seg))) {
      const iso = dateStart(`${m[1]}-${m[2]}-${m[3]}`);
      if (iso) return iso;
    }
    if ((m = /(?:^|\D)((?:19|20)\d{2})年(1[0-2]|0?[1-9])月(?:(\d{1,2})日)?/.exec(seg))) {
      const iso = dateStart(m[3] ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : `${m[1]}-${m[2].padStart(2, '0')}`);
      if (iso) return iso;
    }
    if ((m = /(?:^|\D)((?:19|20)\d{2})[-_.](0[1-9]|1[0-2])(?![-_.\d])/.exec(seg))) {
      const iso = dateStart(`${m[1]}-${m[2]}`);
      if (iso) return iso;
    }
    if ((m = /(?:^|\D)((?:19|20)\d{2})\s*[qQ]([1-4])(?!\d)/.exec(seg))) {
      const iso = dateStart(`${m[1]}Q${m[2]}`);
      if (iso) return iso;
    }
  }
  return null;
}
