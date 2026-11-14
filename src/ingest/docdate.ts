import path from 'node:path';
import { dateStart } from '../store/dates.js';

/**
 * A source's reference date: when its content is *about*. Read from
 * frontmatter first (`date`, `published`, `as_of`, OKF `generated.at` …),
 * then from a date in the path (`reports/2026-05-catl.md`, `20260510.pdf`),
 * then, for a document that gives its text, from a dateline at its top
 * (`dateFromContent`). Never the file mtime — copying a workspace would
 * silently re-date every claim and break idempotent re-ingest.
 */
const FRONTMATTER_KEYS = ['date', 'doc_date', 'docDate', 'published', 'published_at', 'publishedAt', 'as_of', 'asOf', 'report_date', 'reportDate', 'issued', 'created'];

export function docDateOf(file: string, frontmatter: Record<string, unknown> | undefined | null, content?: string | null): string | null {
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
  return dateFromPath(file) ?? (content ? dateFromContent(content) : null);
}

/** How far into a document its dateline may stand: among its first lines, title included. */
const DATELINE_LINES = 8;
const DATELINE_CHARS = 1_200;
/** A full date, day included: `2025-08-25`, `2025/8/25`, `2025.08.25`, `2025年8月25日`. */
const FULL_DATE = String.raw`((?:19|20)\d{2})(?:[-/.]|\s*年\s*)(1[0-2]|0?[1-9])(?:[-/.]|\s*月\s*)(3[01]|[12]\d|0?[1-9])(?:\s*[日号])?(?!\d)`;
/** What a dateline may open with: list or quote marks, emphasis, and a label that says a date follows. */
const DATELINE_LEAD = String.raw`^[\s>*_#\-–—·•]*(?:(?:日期|时间|发布时间|发布日期|报告日期|报告期|统计周期|周期|date|dated|published|posted|period|as of)\s*[:：]?)?[*_\s]*`;
const DATELINE = new RegExp(`${DATELINE_LEAD}${FULL_DATE}(?:\\s*(?:~|～|—|–|-|至|到|to)\\s*${FULL_DATE})?`, 'i');
/** After the date the line ends, or goes on behind a separator ("· 王芳", ", by …", "（周五）"). */
const DATELINE_REST = /^[*_\s]*(?:$|[·•|,，;；(（\-–—]|\s(?:by|作者|记录|撰写)\b)/i;

/**
 * The date a document states at its top: a line among its first few that
 * opens with a full date, or a range of two ("2025-08-25 ~ 2025-08-29 · 龙杰",
 * "日期：2025年8月29日"). Of a range the end: a weekly report is written when
 * its week is over, and a claim dated by its document must not be dated
 * before what it reports. A date inside a sentence ("成立于2019年3月1日的…")
 * is no dateline, and neither is a month or a year alone.
 */
export function dateFromContent(content: string): string | null {
  const lines = content.slice(0, DATELINE_CHARS).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, DATELINE_LINES);
  for (const line of lines) {
    const m = DATELINE.exec(line);
    if (!m || !DATELINE_REST.test(line.slice(m[0].length))) continue;
    const day = (y: string, mo: string, d: string) => dateStart(`${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`);
    const from = day(m[1], m[2], m[3]);
    const to = m[4] ? day(m[4], m[5], m[6]) : null;
    if (to && from && to >= from) return to;
    if (from) return from;
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
