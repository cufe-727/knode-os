/**
 * Date-expression normalization for world time. Sources state time the way
 * people write it — "2026Q2", "2026年上半年", "去年", "FY2025", "since 2024" —
 * and claims need it as a window. Every accepted form maps to an inclusive
 * `[from, to]` span in UTC (open sides are null) with the precision it was
 * stated at; relative expressions resolve against a reference instant (the
 * document's date), and return null without one rather than guessing.
 */

export type DatePrecision = 'instant' | 'day' | 'month' | 'quarter' | 'half' | 'year';

export interface DateSpan {
  from: string | null;
  to: string | null;
  precision: DatePrecision;
}

const CJK_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 上: 1, 下: 2 };

function utc(y: number, m: number, d: number, end = false): string {
  const date = end ? new Date(Date.UTC(y, m, d, 23, 59, 59, 999)) : new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  return date.toISOString();
}

function year(y: number): DateSpan {
  return { from: utc(y, 1, 1), to: utc(y, 12, 0, true), precision: 'year' };
}
function month(y: number, m: number): DateSpan | null {
  if (m < 1 || m > 12) return null;
  return { from: utc(y, m, 1), to: utc(y, m, 0, true), precision: 'month' };
}
function day(y: number, m: number, d: number): DateSpan | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const from = new Date(Date.UTC(y, m - 1, d));
  if (from.getUTCMonth() !== m - 1) return null; // e.g. Feb 30
  return { from: from.toISOString(), to: new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999)).toISOString(), precision: 'day' };
}
function quarter(y: number, q: number): DateSpan | null {
  if (q < 1 || q > 4) return null;
  const m = (q - 1) * 3 + 1;
  return { from: utc(y, m, 1), to: utc(y, m + 2, 0, true), precision: 'quarter' };
}
function half(y: number, h: number): DateSpan | null {
  if (h < 1 || h > 2) return null;
  const m = h === 1 ? 1 : 7;
  return { from: utc(y, m, 1), to: utc(y, m + 5, 0, true), precision: 'half' };
}

function absolute(raw: string): DateSpan | null {
  const t = raw.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?$/.exec(t))) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : { from: d.toISOString(), to: d.toISOString(), precision: 'instant' };
  }
  if ((m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(t))) return day(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(t))) return day(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{4})\s*[-/.年]?\s*(?:q|Q)\s*([1-4])$/.exec(t))) return quarter(+m[1], +m[2]);
  if ((m = /^(?:q|Q)([1-4])\s*[-/ ]?\s*(\d{4})$/.exec(t))) return quarter(+m[2], +m[1]);
  if ((m = /^(\d{4})\s*年?\s*第?([一二三四1-4])\s*季度?$/.exec(t))) return quarter(+m[1], CJK_NUM[m[2]] ?? +m[2]);
  if ((m = /^(\d{4})\s*[-/.年]?\s*(?:h|H)\s*([12])$/.exec(t))) return half(+m[1], +m[2]);
  if ((m = /^(\d{4})\s*年?\s*([上下])半年$/.exec(t))) return half(+m[1], CJK_NUM[m[2]]);
  if ((m = /^(\d{4})[-/.年](\d{1,2})月?$/.exec(t))) return month(+m[1], +m[2]);
  if ((m = /^(\d{4})\s*(?:年|年度|财年|fy)?$/i.exec(t)) || (m = /^(?:fy|FY)\s*(\d{4})$/.exec(t))) return year(+m[1]);
  return null;
}

function relative(raw: string, ref: string): DateSpan | null {
  const r = new Date(ref);
  if (Number.isNaN(r.getTime())) return null;
  const y = r.getUTCFullYear();
  const mo = r.getUTCMonth() + 1;
  const q = Math.floor((mo - 1) / 3) + 1;
  const t = raw.trim().toLowerCase();
  const yearOffset: Record<string, number> = { 今年: 0, 本年: 0, 'this year': 0, 去年: -1, 上年: -1, 'last year': -1, 前年: -2, 明年: 1, 'next year': 1 };
  if (t in yearOffset) return year(y + yearOffset[t]);
  const quarterOffset: Record<string, number> = { 本季度: 0, 本季: 0, 'this quarter': 0, 上季度: -1, 上一季度: -1, 'last quarter': -1, 下季度: 1, 'next quarter': 1 };
  if (t in quarterOffset) {
    const total = y * 4 + (q - 1) + quarterOffset[t];
    return quarter(Math.floor(total / 4), (total % 4) + 1);
  }
  const monthOffset: Record<string, number> = { 本月: 0, 'this month': 0, 上月: -1, 上个月: -1, 'last month': -1, 下月: 1, 'next month': 1 };
  if (t in monthOffset) {
    const total = y * 12 + (mo - 1) + monthOffset[t];
    return month(Math.floor(total / 12), (total % 12) + 1);
  }
  const m = /^(去年|今年|last year|this year)\s*(?:同期|同季|q([1-4])|第?([一二三四1-4])季度?)$/.exec(t);
  if (m) {
    const yy = m[1] === '去年' || m[1] === 'last year' ? y - 1 : y;
    const qq = m[2] ? +m[2] : m[3] ? CJK_NUM[m[3]] ?? +m[3] : q;
    return quarter(yy, qq);
  }
  if (t === '今天' || t === 'today') return day(y, mo, r.getUTCDate());
  return null;
}

/**
 * Parse one date expression. `ref` (ISO) anchors relative forms; without it
 * they return null. "since X" / "X以来" opens the end, "until X" / "截至X"
 * opens the start.
 */
export function normalizeDateExpr(expr: unknown, ref?: string | null): DateSpan | null {
  if (expr instanceof Date) return Number.isNaN(expr.getTime()) ? null : { from: expr.toISOString(), to: expr.toISOString(), precision: 'instant' };
  if (typeof expr === 'number' && Number.isInteger(expr) && expr >= 1900 && expr <= 2200) return year(expr);
  if (typeof expr !== 'string') return null;
  let t = expr.trim();
  if (!t) return null;
  let side: 'from' | 'to' | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^(?:since|from|自|从)\s*(.+?)\s*(?:起|以来)?$/i.exec(t)) || (m = /^(.+?)\s*(?:以来|起|之后|以后)$/.exec(t))) {
    side = 'from';
    t = m[1];
  } else if ((m = /^(?:until|till|before|截至|截止|直到|到)\s*(.+?)\s*(?:前|为止)?$/i.exec(t)) || (m = /^(.+?)\s*(?:之前|以前|前|为止)$/.exec(t))) {
    side = 'to';
    t = m[1];
  }
  const span = absolute(t) ?? (ref ? relative(t, ref) : null);
  if (!span) return null;
  if (side === 'from') return { from: span.from, to: null, precision: span.precision };
  if (side === 'to') return { from: null, to: span.to, precision: span.precision };
  return span;
}

/** The instant a date expression starts at (for single-valued fields such as an event date). */
export function dateStart(expr: unknown, ref?: string | null): string | null {
  return normalizeDateExpr(expr, ref)?.from ?? null;
}

/** The instant a date expression ends at. */
export function dateEnd(expr: unknown, ref?: string | null): string | null {
  return normalizeDateExpr(expr, ref)?.to ?? null;
}
