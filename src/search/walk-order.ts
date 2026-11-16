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

/** The clause of the question around [from, to): up to the separators either side. */
function clauseAround(q: string, from: number, to: number): string {
  const before = q.slice(0, from);
  const start = Math.max(...['，', ',', '。', '？', '?', '！', '!', '；', ';'].map((sep) => before.lastIndexOf(sep))) + 1;
  const rest = q.slice(to);
  const ends = ['，', ',', '。', '？', '?', '！', '!', '；', ';'].map((sep) => rest.indexOf(sep)).filter((i) => i >= 0);
  return q.slice(start, to + (ends.length ? Math.min(...ends) : rest.length));
}

/**
 * What the question asks to order, or null when it asks for no position. The
 * period, a level and "the severest" are read from the ordinal's own clause:
 * "周岚2024年加入清算组，清算组今年第一起事故" orders this year's, not 2024's.
 */
export function ordinalInQuestion(question: string): OrdinalAsk | null {
  const q = question;
  const at = (m: RegExpExecArray, kind: OrdinalAsk['kind'], n: number): OrdinalAsk => {
    const end = m.index + m[0].length;
    const clause = clauseAround(q, m.index, end);
    const lower = clause.toLowerCase();
    const explicit = /((?:19|20)\d\d)\s*年/.exec(clause) ?? /\b(?:in|of)\s+((?:19|20)\d\d)\b/i.exec(clause);
    const year = explicit ? Number(explicit[1]) : null;
    const period = /本月|这个月|当月|this month|of the month/.test(lower)
      ? { unit: 'month' as const, year }
      : year || /今年|本年|今年度|当年|this year|of the year/.test(lower) ? { unit: 'year' as const, year } : null;
    const levelMatch = /\b(?:P|SEV|S)\s?([0-5])(?![\d.])/i.exec(clause);
    return {
      text: m[0], end, kind, n, period,
      severest: /最严重|最高级|最高等级|级别最高|等级最高|most severe|highest[- ]severity|top[- ]severity|highest[- ]priority/.test(lower),
      level: levelMatch ? Number(levelMatch[1]) : null,
    };
  };
  let m = new RegExp(`第\\s*([一二两三四五六七八九十\\d]+)\\s*(?:${ZH_COUNTER})`).exec(q);
  if (m) {
    const n = chineseNumber(m[1]);
    if (n && n > 0) return at(m, 'nth', n);
  }
  m = new RegExp(`(?:最近|最新|最后)(?:一|的)?\\s*(?:${ZH_COUNTER})`).exec(q);
  if (m) return at(m, 'last', 1);
  m = new RegExp(`(?:最早|首)(?:一|的)?\\s*(?:${ZH_COUNTER})`).exec(q);
  if (m) return at(m, 'nth', 1);
  m = new RegExp(`(?:上一|前一)\\s*(?:${ZH_COUNTER})`).exec(q);
  if (m) return at(m, 'previous', 1);
  m = /\bthe\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th))\b/i.exec(q);
  if (m) {
    const w = m[1].toLowerCase();
    const n = EN_ORDINALS[w] ?? Number(w.replace(/\D/g, ''));
    if (n > 0) return at(m, 'nth', n);
  }
  m = /\bthe\s+(?:latest|most recent|last)\b/i.exec(q);
  if (m) return at(m, 'last', 1);
  m = /\b(?:the one before|the previous|the prior)\b/i.exec(q);
  if (m) return at(m, 'previous', 1);
  return null;
}

/**
 * The present a relative period ("今年", "this month") is read against: the day the question says it is asked as of
 * ("截至2025年5月21日", "as of 2025-05-21"), else the day its caller gives (`ask`'s `now`: an evaluation of a past
 * corpus sets its own), else the clock's. A knowledge base behind the clock is not read as current: its "今年" holds
 * nothing, and the note says what its latest source is (`latestSourceDate`).
 */
export function presentOf(asOf: string | null, now: string | null = null, today = new Date()): { date: string; by: 'question' | 'caller' | 'clock' } {
  if (asOf) return { date: asOf.slice(0, 10), by: 'question' };
  if (now) return { date: now.slice(0, 10), by: 'caller' };
  return { date: today.toISOString().slice(0, 10), by: 'clock' };
}

/**
 * The date of the knowledge base's latest source up to `upTo`: a source's date is its own, or else the earliest its
 * claims state (the week a report covers, not the launch it plans). Read only to say why a period holds nothing.
 */
export async function latestSourceDate(store: Store, upTo: string): Promise<string | null> {
  const bound = `${upTo.slice(0, 10)}T23:59:59Z`;
  let [row] = await store.query<{ at: string | Date | null }>(`SELECT max(doc_date) AS at FROM documents WHERE doc_date <= $1::timestamptz`, [bound]);
  if (!row?.at) {
    [row] = await store.query<{ at: string | Date | null }>(
      `SELECT max(at) AS at FROM (
         SELECT min(COALESCE(c.event_at, c.valid_from)) AS at FROM claims c JOIN chunks ch ON ch.id = c.chunk_id
         WHERE c.tx_to IS NULL AND COALESCE(c.event_at, c.valid_from) IS NOT NULL GROUP BY ch.document_id) d
       WHERE at <= $1::timestamptz`,
      [bound],
    );
  }
  return toDateString(row?.at ?? null);
}

export interface Placed {
  id: string;
  name?: string;
  /** YYYY-MM-DD, or null when nothing dates it. */
  date: string | null;
  /** What dates it: a claim or relation stating the kind of event asked about, or only its first sight. */
  datedBy?: 'event' | 'first seen';
  /** The lowest level number its claims state (P1 → 1), or null. */
  level: number | null;
}

/**
 * Where each entity stands for ordering. Its date is that of the event asked
 * about, when the question names one (`event`: the spellings of "发布", "事故"):
 * the claims and relations that state it, the earliest for "the first …", the
 * latest for "the latest …" (a product released in 2019 and again in 2026 was
 * last released in 2026). Otherwise, or when none states it, its first sight:
 * the earliest its own live claims state, else the earliest start of its
 * relations, else the date of the earliest document that mentions it (the
 * document's own date, or the earliest its claims state). Its level: the one
 * stated by its earliest claim that states one, dated by the claim or else by
 * its document (the report of the event, not a later summary that restates
 * it: the reports say P2 in the week and P1 in the month's summary), else the
 * level stated most often, the severer on a tie.
 */
export async function placeEntities(store: Store, ids: string[], event: { spellings: string[]; latest: boolean } | null = null): Promise<Map<string, Placed>> {
  const out = new Map<string, Placed>(ids.map((id) => [id, { id, date: null, level: null }]));
  if (ids.length === 0) return out;
  for (const r of await store.query<{ id: string; name: string }>(`SELECT id, name FROM entities WHERE id = ANY($1::text[])`, [ids])) out.get(r.id)!.name = r.name;
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
  const rels = await store.query<{ id: string; at: string | Date | null; description: string }>(
    `SELECT e.id, r.valid_from AS at, r.description FROM unnest($1::text[]) AS e(id)
     JOIN relations r ON (r.source_id = e.id OR r.target_id = e.id) AND r.tx_to IS NULL AND r.valid_from IS NOT NULL`,
    [ids],
  );
  const relDate = new Map<string, string>();
  for (const r of rels) {
    const d = toDateString(r.at);
    if (d && (!relDate.has(r.id) || d < relDate.get(r.id)!)) relDate.set(r.id, d);
  }
  // the event asked about, where a claim or a relation states it
  const states = (text: string) => !!event && event.spellings.some((w) => text.toLowerCase().includes(w));
  const events = new Map<string, string[]>();
  if (event) {
    for (const c of claims) {
      const d = toDateString(c.at) ?? (c.document_id ? docDates.get(c.document_id) ?? null : null);
      if (d && states(c.statement)) events.set(c.id, [...(events.get(c.id) ?? []), d]);
    }
    for (const r of rels) {
      const d = toDateString(r.at);
      if (d && states(r.description)) events.set(r.id, [...(events.get(r.id) ?? []), d]);
    }
  }
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
  for (const p of out.values()) {
    const dates = (events.get(p.id) ?? []).sort();
    if (dates.length) {
      p.date = event!.latest ? dates[dates.length - 1] : dates[0];
      p.datedBy = 'event';
    } else if (p.date) p.datedBy = 'first seen';
  }
  return out;
}

/**
 * Each document's date: its own, or else the day its live claims state most often (the earlier on a tie): the
 * week a report covers, not the old events a monthly summary restates nor the launch a report plans.
 */
export async function documentDates(store: Store, ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const [own, stated] = await Promise.all([
    store.query<{ id: string; at: string | Date | null }>(`SELECT id, doc_date AS at FROM documents WHERE id = ANY($1::text[])`, [ids]),
    store.query<{ id: string; at: string | Date | null }>(
      `SELECT DISTINCT ON (x.id) x.id, x.day AS at FROM (
         SELECT ch.document_id AS id, date_trunc('day', COALESCE(c.event_at, c.valid_from) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day, count(*) AS n
         FROM chunks ch JOIN claims c ON c.chunk_id = ch.id AND c.tx_to IS NULL AND COALESCE(c.event_at, c.valid_from) IS NOT NULL
         WHERE ch.document_id = ANY($1::text[]) GROUP BY 1, 2) x
       ORDER BY x.id, x.n DESC, x.day`,
      [ids],
    ),
  ]);
  const byClaims = new Map(stated.map((r) => [r.id, toDateString(r.at)]));
  const rows = own.map((r) => ({ id: r.id, at: r.at ?? byClaims.get(r.id) ?? null }));
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

/**
 * Order the candidates by date, within the period and level asked, and take
 * the one the question names. A relative period ("今年") is read against
 * `present`, a named one ("2025年") as named. The note says what was taken,
 * from how many, by which date, and lists the order, or says why nothing was.
 */
export function pickByOrder(ask: OrdinalAsk, candidates: Placed[], present: { date: string; by: string } | null = null): Pick {
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
    const now = present?.date ?? new Date().toISOString().slice(0, 10);
    const relative = ask.period.year === null && present && present.by !== 'question' ? ` (this ${ask.period.unit}: the ${present.by === 'clock' ? 'clock' : "caller's now"}, ${present.date})` : '';
    if (ask.period.unit === 'year') {
      const y = ask.period.year ?? Number(now.slice(0, 4));
      scope = dated.filter((c) => Number(c.date!.slice(0, 4)) === y);
      period = ` in ${y}${relative}`;
    } else {
      const month = ask.period.year ? `${ask.period.year}-${now.slice(5, 7)}` : now.slice(0, 7);
      scope = dated.filter((c) => c.date!.slice(0, 7) === month);
      period = ` in ${month}${relative}`;
    }
  }
  const what = `${level !== null ? `P${level} ` : ''}`;
  const base = { offered, inScope: pool.length, dated: scope.length };
  const undated = pool.length - dated.length;
  const sorted = [...scope].sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : a.id < b.id ? -1 : 1));
  const index = ask.kind === 'nth' ? ask.n - 1 : ask.kind === 'last' ? sorted.length - 1 : sorted.length - 2;
  const asked = ask.kind === 'nth' ? `the ${nth(ask.n)}` : ask.kind === 'last' ? 'the latest' : 'the one before the latest';
  const order = sorted.length ? `; in order: ${sorted.slice(0, 10).map((c) => `${c.name ?? c.id} (${c.date}${c.datedBy === 'first seen' ? ', first seen' : ''})`).join(', ')}${sorted.length > 10 ? ', …' : ''}` : '';
  if (index < 0 || index >= sorted.length) {
    return {
      ...base, picked: null,
      note: `not ordered: ${ask.text} asks for ${asked}, ${sorted.length} ${what}candidates are dated${period}${undated ? ` (${undated} have no date)` : ''}${order}`,
    };
  }
  const p = sorted[index];
  const tie = sorted.filter((c) => c.date === p.date).length > 1 ? ', tied on date and taken by name' : '';
  return {
    ...base, picked: p.id,
    note: `${asked} of ${sorted.length} ${what}dated${period}, by date (${p.date}${p.datedBy === 'first seen' ? ', first seen' : ''})${undated ? `; ${undated} without a date left out` : ''}${tie}${order}`,
  };
}
