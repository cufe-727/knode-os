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

/** A full date, day included: `2025-08-25`, `2025/8/25`, `2025年8月25日`, and `2025.08.25` (which is also how a version is written). */
const FULL_DATE = String.raw`((?:19|20)\d{2})(-|/|\.|\s*年\s*)(1[0-2]|0?[1-9])(?:-|/|\.|\s*月\s*)(3[01]|[12]\d|0?[1-9])(?:\s*[日号])?(?!\d)`;
/** A label that says the document's date follows. Not a statistics period, a deadline or a plan. */
const DATELINE_LABEL = /^(?:日期|时间|发布时间|发布日期|报告日期|报告期|date|dated|published|posted|as of)(?:\s*[:：]\s*|\s+)/i;
const DATELINE_DATE = new RegExp(`^${FULL_DATE}`);
const DATELINE_RANGE = new RegExp(`^\\s*(?:~|～|—|–|-|至|到|to)\\s*${FULL_DATE}`, 'i');
/** A line that is an entry of something else: a list item, a heading, a quote, a table row. */
const NOT_A_DATELINE = /^(?:[-*+]\s|\d+[.)、]\s*|#|>|\|)/;
const WEEKDAY = /^[（(](?:(?:周|星期|礼拜)[一二三四五六日天]|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?)[）)]\s*/i;
const BYLINE_LEAD = /^(?:[·•|]\s*|by\s+|(?:作者|记录|撰写|整理)[:：]\s*)/i;
const BYLINE_LABEL = /^(?:by\s+|(?:作者|记录|撰写|整理)[:：]\s*)(?=\S)/i;

/**
 * What may follow the date on its line: nothing, a weekday in brackets, a
 * byline behind a dot, a bar or "by" ("· 龙杰", "| by Lin", "· 作者：王芳") —
 * a few words with no sentence punctuation.
 */
function onlyByline(rest: string): boolean {
  let r = rest.trim().replace(WEEKDAY, '');
  if (!r) return true;
  const lead = BYLINE_LEAD.exec(r);
  if (!lead) return false;
  r = r.slice(lead[0].length).replace(BYLINE_LABEL, '').trim();
  return r.length > 0 && r.length <= 30 && !/[。！？!?；;，,：:]/.test(r);
}

/**
 * The date a document states at its top, or null. A dateline is a line among
 * the document's first few that is a date and nothing else: optionally a
 * label ("日期：", "Date:"), a full date, optionally a second date that ends a
 * range, optionally a weekday or a short byline ("2025-08-25 ~ 2025-08-29 ·
 * 龙杰", "日期：2025年8月29日", "**Date:** 2025/8/5").
 *
 * Not a dateline, because each of these was read as one (review, 2026-11-15):
 *   - a sentence that opens with a date ("2019年3月1日，公司在深圳成立…",
 *     "2027-06-30 — 完成迁移"): anything after the date but a weekday or a
 *     byline;
 *   - an entry of a list, a heading, a quote or a table ("- 2023-01-05 -
 *     initial release", "## 2023-01-05", "> 日期：2024年1月5日"): a changelog,
 *     a quoted mail;
 *   - a dotted date that stands alone ("2025.8.1", "2024.02.03"): a version
 *     number. Dotted dates count behind a label or in a range, with two
 *     digits each for month and day;
 *   - a date later than the day the document is indexed (a deadline, a plan);
 *   - a range longer than REPORT_PERIOD_DAYS, or one that ends in the future
 *     (a statistics period, a plan's year): such a range says what the
 *     document covers, not when it is from.
 *
 * Of a range that is a report's own period — a week, a fortnight, a month —
 * the document's date is the **end**: the report is written when its period
 * is over, and a claim dated by its document must not be dated before what it
 * reports.
 */
export function dateFromContent(content: string, indexedAt?: string | null): string | null {
  const latest = Date.parse(indexedAt ?? new Date().toISOString()) + DAY_MS; // a day's grace: the writer's "today" may be ahead of UTC
  const lines = content.slice(0, DATELINE_CHARS).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, DATELINE_LINES);
  const iso = (m: RegExpExecArray) => dateStart(`${m[1]}-${m[3].padStart(2, '0')}-${m[4].padStart(2, '0')}`);
  const dotted = (m: RegExpExecArray) => m[2] === '.';
  const padded = (m: RegExpExecArray) => m[3].length === 2 && m[4].length === 2;
  for (const raw of lines) {
    if (NOT_A_DATELINE.test(raw)) continue;
    let line = raw.replace(/\*\*|__/g, '').replace(/^[*_]|[*_]$/g, '').trim();
    const label = DATELINE_LABEL.exec(line);
    if (label) line = line.slice(label[0].length).trim();
    const first = DATELINE_DATE.exec(line);
    if (!first) continue;
    let rest = line.slice(first[0].length);
    const second = DATELINE_RANGE.exec(rest);
    if (second) rest = rest.slice(second[0].length);
    if (!onlyByline(rest)) continue;
    if ((dotted(first) && !(padded(first) && (label || second))) || (second && dotted(second) && !padded(second))) continue;
    const from = iso(first);
    const to = second ? iso(second) : null;
    if (!from || (second && !to)) continue;
    const date = to ?? from;
    if (Date.parse(date) > latest) continue;
    if (to && (to < from || Date.parse(to) - Date.parse(from) > REPORT_PERIOD_DAYS * DAY_MS)) continue;
    return date;
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
