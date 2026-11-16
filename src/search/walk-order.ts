import { Store } from '../store/db.js';
import { toDateString } from '../store/temporal.js';

/**
 * The ordering step of the relation walk (docs/design/30 §3): "今年第二起最严重一档的
 * 故障", "the latest incident", "上一起事故" ask the walk to order what the previous
 * hop reached by date and take one, not to follow a relation. The question
 * says which one (the Nth, the last, the one before the last), over what
 * period (this year, this month: the latest year or month the candidates are
 * dated in, or a year it names), and optionally of which severity (the
 * severest level the candidates are stated at, or a level it names: P1).
 *
 * A candidate's date is the earliest date its own claims state (event or
 * validity), else the earliest start of its relations. A candidate with no
 * date cannot be placed: it is left out of the order, and when fewer dated
 * candidates remain than the position asked for, nothing is picked and the
 * walk goes on as if the question had not ordered (the pick says why).
 */

export interface OrdinalAsk {
  /** The words that ask: "今年第一起", "the second … of the year". */
  text: string;
  /** Where they end in the question: the noun they order comes after. */
  end: number;
  kind: 'nth' | 'last' | 'previous';
  /** For `nth`: 1 for the first. */
  n: number;
  period: { unit: 'year' | 'month'; year: number | null } | null;
  /** "最严重一档", "most severe": the lowest-numbered level stated among the candidates. */
  severest: boolean;
  /** A level the question names ("P1事故"), as its number. */
  level: number | null;
}

const ZH_DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 一 … 九十九 and plain digits. */
export function chineseNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (m) return (m[1] ? ZH_DIGITS[m[1]] : 1) * 10 + (m[2] ? ZH_DIGITS[m[2]] : 0);
  return s.length === 1 ? (ZH_DIGITS[s] ?? null) : null;
}

const EN_ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const ZH_COUNTER = '起|个|次|件|项|笔|单|宗|轮|场|位|名';

/** What the question asks to order, or null when it asks for no position. */
export function ordinalInQuestion(question: string): OrdinalAsk | null {
  const q = question;
  const lower = q.toLowerCase();
  const severest = /最严重|最高级|最高等级|级别最高|等级最高|most severe|highest[- ]severity|top[- ]severity|highest[- ]priority/.test(lower);
  const levelMatch = /\b(?:P|SEV|S)\s?([0-5])(?![\d.])/i.exec(q);
  const level = levelMatch ? Number(levelMatch[1]) : null;
  const explicitYear = /((?:19|20)\d\d)\s*年/.exec(q) ?? /\b(?:in|of)\s+((?:19|20)\d\d)\b/i.exec(q);
  const year = explicitYear ? Number(explicitYear[1]) : null;
  const periodNear = (from: number, to: number) => {
    const span = lower.slice(Math.max(0, from - 12), Math.min(lower.length, to + 24));
    if (/今年|本年|今年度|当年|this year|of the year/.test(span) || year) return { unit: 'year' as const, year };
    if (/本月|这个月|当月|this month|of the month/.test(span)) return { unit: 'month' as const, year };
    return null;
  };
  let m = new RegExp(`第\\s*([一二两三四五六七八九十\\d]+)\\s*(?:${ZH_COUNTER})`).exec(q);
  if (m) {
    const n = chineseNumber(m[1]);
    if (n && n > 0) return { text: m[0], end: m.index + m[0].length, kind: 'nth', n, period: periodNear(m.index, m.index + m[0].length), severest, level };
  }
  m = new RegExp(`(?:最近|最新|最后)(?:一|的)?\\s*(?:${ZH_COUNTER})`).exec(q);
  if (m) return { text: m[0], end: m.index + m[0].length, kind: 'last', n: 1, period: periodNear(m.index, m.index + m[0].length), severest, level };
  m = new RegExp(`(?:最早|首)(?:一|的)?\\s*(?:${ZH_COUNTER})`).exec(q);
  if (m) return { text: m[0], end: m.index + m[0].length, kind: 'nth', n: 1, period: periodNear(m.index, m.index + m[0].length), severest, level };
  m = new RegExp(`(?:上一|前一)\\s*(?:${ZH_COUNTER})`).exec(q);
  if (m) return { text: m[0], end: m.index + m[0].length, kind: 'previous', n: 1, period: periodNear(m.index, m.index + m[0].length), severest, level };
  m = /\bthe\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th))\b/i.exec(q);
  if (m) {
    const w = m[1].toLowerCase();
    const n = EN_ORDINALS[w] ?? Number(w.replace(/\D/g, ''));
    if (n > 0) return { text: m[0], end: m.index + m[0].length, kind: 'nth', n, period: periodNear(m.index, m.index + m[0].length), severest, level };
  }
  m = /\bthe\s+(?:latest|most recent|last)\b/i.exec(q);
  if (m) return { text: m[0], end: m.index + m[0].length, kind: 'last', n: 1, period: periodNear(m.index, m.index + m[0].length), severest, level };
  m = /\b(?:the one before|the previous|the prior)\b/i.exec(q);
  if (m) return { text: m[0], end: m.index + m[0].length, kind: 'previous', n: 1, period: periodNear(m.index, m.index + m[0].length), severest, level };
  return null;
}

export interface Placed {
  id: string;
  /** YYYY-MM-DD, or null when nothing dates it. */
  date: string | null;
  /** The lowest level number its claims state (P1 → 1), or null. */
  level: number | null;
}

/**
 * Where each entity stands for ordering. Its date: the earliest its own live
 * claims state (event or validity), else the earliest start of its relations,
 * else the date of the earliest document that mentions it (the document's
 * own date, or the earliest its claims state). Its level: the one stated by
 * its earliest claim that states one, dated by the claim or else by its
 * document (the report of the event, not a later summary that restates it:
 * the reports say P2 in the week and P1 in the month's summary), else the
 * level stated most often, the severer on a tie.
 */
export async function placeEntities(store: Store, ids: string[]): Promise<Map<string, Placed>> {
  const out = new Map<string, Placed>(ids.map((id) => [id, { id, date: null, level: null }]));
  if (ids.length === 0) return out;
  // a claim's own date, and its document's for a level stated undated
  const claims = await store.query<{ id: string; at: string | Date | null; document_id: string | null; statement: string }>(
    `SELECT c.subject_id AS id, COALESCE(c.event_at, c.valid_from) AS at, c.statement, ch.document_id
     FROM claims c LEFT JOIN chunks ch ON ch.id = c.chunk_id
     WHERE c.subject_id = ANY($1::text[]) AND c.tx_to IS NULL`,
    [ids],
  );
  const mentioned = await store.query<{ id: string; document_id: string }>(
    `SELECT DISTINCT entity_id AS id, document_id FROM entity_mentions WHERE entity_id = ANY($1::text[])`,
    [ids],
  );
  const docDates = await documentDates(store, [...new Set([...claims.map((c) => c.document_id), ...mentioned.map((m) => m.document_id)].filter((d): d is string => Boolean(d)))]);
  const rels = await store.query<{ id: string; at: string | Date | null }>(
    `SELECT e.id, min(r.valid_from) AS at FROM unnest($1::text[]) AS e(id)
     JOIN relations r ON (r.source_id = e.id OR r.target_id = e.id) AND r.tx_to IS NULL AND r.valid_from IS NOT NULL
     GROUP BY 1`,
    [ids],
  );
  const relDate = new Map(rels.map((r) => [r.id, toDateString(r.at)]));
  const levels = new Map<string, { at: string | null; level: number }[]>();
  for (const c of claims) {
    const p = out.get(c.id);
    if (!p) continue;
    const d = toDateString(c.at);
    if (d && (!p.date || d < p.date)) p.date = d;
    const stated = [...c.statement.matchAll(/\b(?:P|SEV|S)\s?([0-5])(?![\d.])/gi)].map((m) => Number(m[1]));
    if (stated.length) levels.set(c.id, [...(levels.get(c.id) ?? []), { at: d ?? (c.document_id ? docDates.get(c.document_id) ?? null : null), level: Math.min(...stated) }]);
  }
  for (const [id, stated] of levels) {
    const dated = stated.filter((x) => x.at).sort((a, b) => (a.at! < b.at! ? -1 : a.at! > b.at! ? 1 : a.level - b.level));
    if (dated.length) {
      out.get(id)!.level = dated[0].level;
      continue;
    }
    const count = new Map<number, number>();
    for (const x of stated) count.set(x.level, (count.get(x.level) ?? 0) + 1);
    out.get(id)!.level = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  }
  for (const p of out.values()) if (!p.date) p.date = relDate.get(p.id) ?? null;
  // nothing of its own dates it: the earliest dated document that mentions it
  const undated = new Set([...out.values()].filter((p) => !p.date).map((p) => p.id));
  for (const m of mentioned) {
    if (!undated.has(m.id)) continue;
    const p = out.get(m.id)!;
    const d = docDates.get(m.document_id) ?? null;
    if (d && (!p.date || d < p.date)) p.date = d;
  }
  return out;
}

/** Each document's date: its own, or else the earliest date its live claims state. */
export async function documentDates(store: Store, ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const rows = await store.query<{ id: string; at: string | Date | null }>(
    `SELECT d.id, COALESCE(d.doc_date, min(COALESCE(c.event_at, c.valid_from))) AS at
     FROM documents d LEFT JOIN chunks ch ON ch.document_id = d.id LEFT JOIN claims c ON c.chunk_id = ch.id AND c.tx_to IS NULL
     WHERE d.id = ANY($1::text[]) GROUP BY d.id, d.doc_date`,
    [ids],
  );
  for (const r of rows) out.set(r.id, toDateString(r.at));
  return out;
}

export interface Pick {
  /** The entity taken, or null when the order could not be made. */
  picked: string | null;
  /** Candidates offered, those of the asked level and period, and those of them with a date. */
  offered: number;
  inScope: number;
  dated: number;
  /** "the 2nd of 4 P1 dated in 2025, by date (2025-04-28)", or why nothing was picked. */
  note: string;
}

const nth = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

/** Order the candidates by date, within the period and level asked, and take the one the question names. */
export function pickByOrder(ask: OrdinalAsk, candidates: Placed[]): Pick {
  const offered = candidates.length;
  let pool = candidates;
  // the level: the one named, or the severest stated among the candidates; a candidate with no stated level is not of it
  const levels = pool.map((c) => c.level).filter((l): l is number => l !== null);
  const level = ask.level ?? (ask.severest && levels.length ? Math.min(...levels) : null);
  if (level !== null) pool = pool.filter((c) => c.level === level);
  const dated = pool.filter((c) => c.date);
  let scope = dated;
  let period = '';
  if (ask.period) {
    if (ask.period.unit === 'year') {
      const y = ask.period.year ?? Math.max(...dated.map((c) => Number(c.date!.slice(0, 4))));
      scope = dated.filter((c) => Number(c.date!.slice(0, 4)) === y);
      period = Number.isFinite(y) ? ` in ${y}` : '';
    } else {
      const latest = dated.map((c) => c.date!.slice(0, 7)).sort().pop();
      scope = dated.filter((c) => c.date!.slice(0, 7) === latest);
      period = latest ? ` in ${latest}` : '';
    }
  }
  const what = `${level !== null ? `P${level} ` : ''}`;
  const base = { offered, inScope: pool.length, dated: scope.length };
  const undated = pool.length - dated.length;
  const sorted = [...scope].sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : a.id < b.id ? -1 : 1));
  const index = ask.kind === 'nth' ? ask.n - 1 : ask.kind === 'last' ? sorted.length - 1 : sorted.length - 2;
  if (index < 0 || index >= sorted.length) {
    return {
      ...base, picked: null,
      note: `not ordered: ${ask.text} asks for ${ask.kind === 'nth' ? `the ${nth(ask.n)}` : ask.kind === 'last' ? 'the latest' : 'the one before the latest'}, ${sorted.length} ${what}candidates are dated${period}${undated ? ` (${undated} have no date)` : ''}`,
    };
  }
  const p = sorted[index];
  const tie = sorted.filter((c) => c.date === p.date).length > 1 ? ', tied on date and taken by name' : '';
  return {
    ...base, picked: p.id,
    note: `${ask.kind === 'nth' ? `the ${nth(ask.n)}` : ask.kind === 'last' ? 'the latest' : 'the one before the latest'} of ${sorted.length} ${what}dated${period}, by date (${p.date})${undated ? `; ${undated} without a date left out` : ''}${tie}`,
  };
}
