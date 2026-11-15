import type { Judge } from '../judge.js';
import { hasCjk, normalizeAnswer } from '../metrics/text.js';
import { parseStructured } from '../prompts.js';
import type { AnswerRecord, GoldItem, ListSpec, ScoreRecord, Task } from '../types.js';
import { ListSpecSchema } from '../types.js';
import { judgeItemKey, repeatOf, scoreKey } from './keys.js';

/**
 * Scoring corpus-level lists (docs/design/23 §4): an aggregate, a timeline,
 * the sides of a contradiction or a profile, each answered as the same JSON
 * list and matched one-to-one against a gold list — without a model where the
 * gold allows it (an alias that occurs in the predicted label, or the
 * documents an item cites), by the judge otherwise. A timeline is also scored
 * on order and dates; a contradiction match needs one of the documents that
 * take that side. The task's correctness is set F1 (recall where the gold is
 * a sample), times order accuracy for a timeline. A structured query
 * (docs/design/28) matches by fields — every field of the gold item (a team,
 * a quarter, a count) named in one predicted label — and is right only when
 * the whole set is. A look-alike task names its distractors: the share of
 * predicted items that are the look-alike's is `distractor_rate`.
 */

const CJK_CLASS = '㐀-䶿一-鿿぀-ヿ가-힯';
const SPACE_BY_CJK = new RegExp(`\\s+(?=[${CJK_CLASS}])|(?<=[${CJK_CLASS}])\\s+`, 'gu');

/**
 * Thousands separators dropped: "1,000" and "1,347,307.69" as the digits
 * they are. Only a well-formed group (one to three digits, then groups of
 * exactly three) is folded, so "3,4" and "第1,2周" keep their comma.
 */
export function foldThousands(s: string): string {
  return s.normalize('NFKC').replace(/(?<![\d.,])\d{1,3}(?:,\d{3})+(?![\d]|,\d)/g, (m) => m.replace(/,/g, ''));
}

/** Normalized for matching: NFKC, lower case, thousands separators and punctuation folded; no spaces next to CJK, none between a number and its unit. */
export function matchForm(s: string): string {
  return normalizeAnswer(foldThousands(s)).replace(SPACE_BY_CJK, '').replace(/(?<=\d)\s+(?=[a-z%])/g, '').replace(/(?<=\d)\s+(?=\d)/g, ' ');
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isLatin = (c: string | undefined) => c !== undefined && /[a-z]/.test(c);

/** Does `needle` occur in `hay` as a whole term — a number not inside a longer number, a Latin word not inside a longer word? */
export function containsTerm(hay: string, needle: string): boolean {
  const h = matchForm(hay);
  const n = matchForm(needle);
  if (!n || (!hasCjk(n) && n.length < 2 && !isDigit(n))) return false;
  for (let i = h.indexOf(n); i >= 0; i = h.indexOf(n, i + 1)) {
    const before = h[i - 1];
    const after = h[i + n.length];
    const first = n[0];
    const last = n[n.length - 1];
    const okBefore = !(isDigit(first) && isDigit(before)) && !(isLatin(first) && isLatin(before)) && !(isDigit(first) && before === '.');
    const okAfter = !(isDigit(last) && isDigit(after)) && !(isLatin(last) && isLatin(after)) && !(isDigit(last) && after === '.' && isDigit(h[i + n.length + 1]));
    if (okBefore && okAfter) return true;
  }
  return false;
}

/** Pairs [predicted, gold] where the predicted label holds the gold label or one of its aliases, longest names first, each used once. */
export function matchByAlias(predicted: string[], gold: GoldItem[]): [number, number][] {
  const names = gold.flatMap((g, gi) => [g.label, ...g.aliases].map((name) => ({ gi, name })));
  names.sort((a, b) => matchForm(b.name).length - matchForm(a.name).length);
  const usedP = new Set<number>();
  const usedG = new Set<number>();
  const out: [number, number][] = [];
  for (const { gi, name } of names) {
    if (usedG.has(gi)) continue;
    const pi = predicted.findIndex((p, i) => !usedP.has(i) && containsTerm(p, name));
    if (pi < 0) continue;
    usedP.add(pi);
    usedG.add(gi);
    out.push([pi, gi]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Where a label that lists several things divides: 、 , ; / | and the words for "and" / "or", outside brackets. */
const LIST_SEPARATOR = /^(?:[、,;/|]|以及|和|与|及|或|\s+(?:and|or)\s+)/i;
const OPEN = '(（[【「『“';
const CLOSE = ')）]】」』”';

/** A label's parts at its top-level list separators (thousands separators kept), trimmed, empty ones dropped. */
export function listParts(label: string): string[] {
  const s = foldThousands(label);
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c) && depth > 0) depth--;
    else if (depth === 0) {
      const sep = s.slice(i).match(LIST_SEPARATOR);
      if (sep) {
        parts.push(s.slice(start, i));
        i += sep[0].length - 1;
        start = i + 1;
      }
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * An entry that lists several gold items in one label ("九部平台组、九部支付组
 * （归属不唯一）") stands for its parts, each counted as an item the answer
 * gave: it is a list written in one string, and scored as if written out, so
 * it can match one gold item per part, and a part that names nothing in the
 * gold lowers precision as a separate wrong entry would. Only when two or more
 * parts each name a different gold item: an entry that merely mentions two
 * names in one phrase ("九部平台组调往九部支付组") is one claim, and a label
 * whose parts name at most one gold item keeps its form (its precision does
 * not change for being written with a comma).
 */
export function splitListedItems<T extends { label: string }>(items: T[], gold: GoldItem[]): T[] {
  return items.flatMap((it) => {
    const parts = listParts(it.label);
    if (parts.length < 2 || matchByAlias(parts, gold).length < 2) return [it];
    return parts.map((label) => ({ ...it, label }));
  });
}

/** Pairs [predicted, gold] where the predicted label names every field of the gold item (one term of each group), each used once. */
export function matchByFields(predicted: string[], gold: GoldItem[]): [number, number][] {
  const usedP = new Set<number>();
  const out: [number, number][] = [];
  // the most specific items first, so a looser one does not take their label
  const order = gold.map((g, gi) => ({ g, gi })).sort((a, b) => (b.g.fields?.length ?? 0) - (a.g.fields?.length ?? 0));
  for (const { g, gi } of order) {
    if (!g.fields?.length) continue;
    const pi = predicted.findIndex((p, i) => !usedP.has(i) && g.fields!.every((group) => group.some((term) => containsTerm(p, term))));
    if (pi < 0) continue;
    usedP.add(pi);
    out.push([pi, gi]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** A cited path as a corpus document: prefixes the systems write stripped, a bare file name resolved when it names one document. */
export function evidenceDoc(cited: string, docs: Set<string>): string | undefined {
  const p = cited.trim().replace(/^\.\//, '').replace(/^(?:raw\/docs|raw|corpus)\//, '').replace(/[)\].,;:，。]+$/, '');
  if (docs.has(p)) return p;
  const base = p.split('/').pop();
  const named = [...docs].filter((d) => d.split('/').pop() === base);
  return named.length === 1 ? named[0] : undefined;
}

/** Pairs [predicted, gold] where the predicted item's evidence covers every document of the gold item. */
export function matchByDocs(evidence: string[][], gold: GoldItem[], docs: Set<string>): [number, number][] {
  const cited = evidence.map((ev) => new Set(ev.map((e) => evidenceDoc(e, docs)).filter((d): d is string => Boolean(d))));
  const usedP = new Set<number>();
  const out: [number, number][] = [];
  gold.forEach((g, gi) => {
    if (!g.docs?.length) return;
    const pi = cited.findIndex((c, i) => !usedP.has(i) && g.docs!.every((d) => c.has(d)));
    if (pi < 0) return;
    usedP.add(pi);
    out.push([pi, gi]);
  });
  return out.sort((a, b) => a[0] - b[0]);
}

/* ---------------------------------- dates ---------------------------------- */

export interface LooseDate {
  y?: number;
  m: number;
  d?: number;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A date as an answer writes it: 2026-04-12, 2026/4/12, 2026年4月12日, 4月12日, April 12, 2026, 12 April — or the gold's YYYY-MM. */
export function parseLooseDate(s: string): LooseDate | null {
  const t = s.normalize('NFKC').toLowerCase();
  let m = t.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})(?:\s*[-/.月]\s*(\d{1,2}))?/);
  if (m) return { y: +m[1], m: +m[2], ...(m[3] ? { d: +m[3] } : {}) };
  m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (m) return { m: +m[1], d: +m[2] };
  m = t.match(/(\d{1,2})\s*月/);
  if (m && !/\d\s*月\s*\d/.test(t)) return { m: +m[1] };
  m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/);
  if (m) return { m: MONTHS.indexOf(m[1]) + 1, d: +m[2], ...(m[3] ? { y: +m[3] } : {}) };
  m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?/);
  if (m) return { m: MONTHS.indexOf(m[2]) + 1, d: +m[1], ...(m[3] ? { y: +m[3] } : {}) };
  return null;
}

/** Does a predicted date name the gold date, at the gold's precision (a missing year is taken as the gold's)? */
export function sameDate(predicted: string, gold: string): boolean {
  const p = parseLooseDate(predicted);
  const g = parseLooseDate(gold);
  if (!p || !g) return false;
  if (p.y !== undefined && g.y !== undefined && p.y !== g.y) return false;
  if (p.m !== g.m) return false;
  return g.d === undefined || p.d === g.d;
}

/** Share of matched item pairs, among those whose gold dates differ, that the answer lists in the gold's order. */
export function orderAccuracy(pairs: [number, number][], gold: GoldItem[]): number | null {
  let right = 0;
  let total = 0;
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const [pa, ga] = pairs[i];
      const [pb, gb] = pairs[j];
      const da = gold[ga].date ?? '';
      const db = gold[gb].date ?? '';
      if (!da || !db || da === db) continue;
      total++;
      if ((pa < pb) === (da < db)) right++;
    }
  }
  return total ? right / total : null;
}

/* --------------------------------- scoring --------------------------------- */

export function listSpec(t: Task): ListSpec {
  return t.list ?? ListSpecSchema.parse({});
}

export interface ListInput {
  answers: AnswerRecord[];
  tasks: Map<string, Task>;
  corpusDocs: Map<string, Set<string>>;
}

type Put = (a: AnswerRecord, t: Task, metric: string, value: number | null, detail?: Record<string, unknown>) => void;

/** The gold as the judge sees it: label, date and aliases on one line. */
const goldLine = (g: GoldItem) => `${g.label}${g.date ? ` (${g.date})` : ''}${g.aliases.length ? ` / ${g.aliases.join(' / ')}` : ''}`;

export async function scoreLists(input: ListInput, judge: Judge): Promise<ScoreRecord[]> {
  const at = new Date().toISOString();
  const out: ScoreRecord[] = [];
  const put: Put = (a, t, metric, value, detail) =>
    out.push({ key: scoreKey(a, metric), pack: a.pack, system: a.system, suite: t.suite, taskId: t.id, taskType: t.type, metric, value, at, ...(repeatOf(a) !== undefined ? { repeat: repeatOf(a) } : {}), ...(detail ? { detail } : {}) });

  const toJudge: { id: string; a: AnswerRecord; t: Task; items: ReturnType<typeof parseStructured>['items'] }[] = [];
  for (const a of input.answers) {
    const t = input.tasks.get(`${a.pack}|${a.taskId}`);
    if (!t || !t.list || t.scoring !== 'set' || !t.items?.length || a.leaked?.length) continue;
    const spec = listSpec(t);
    const given = parseStructured(a.text).items.slice(0, spec.maxItems);
    // matched by name: an entry that lists several gold items counts as its parts
    const items = spec.match === 'alias' ? splitListedItems(given, t.items) : given;
    put(a, t, 'items_returned', items.length);
    if (spec.match === 'judge' && items.length) {
      toJudge.push({ id: judgeItemKey('list', a), a, t, items });
      continue;
    }
    const docs = input.corpusDocs.get(a.pack) ?? new Set<string>();
    const pairs = !items.length ? [] : spec.match === 'docs'
      ? matchByDocs(items.map((i) => i.evidence), t.items, docs)
      : spec.match === 'fields' ? matchByFields(items.map((i) => i.label), t.items)
        : matchByAlias(items.map((i) => i.label), t.items);
    listScores(a, t, spec, pairs, items, docs, put);
  }

  const verdicts = await judge.matchList(toJudge.map((j) => ({
    id: j.id,
    predicted: j.items.map((i) => `${i.label}${i.date ? ` (${i.date})` : ''}`),
    gold: j.t.items!.map(goldLine),
  })));
  for (const j of toJudge) {
    const v = verdicts.get(j.id);
    if (!v) continue;
    const gold = j.t.items!;
    const used = { p: new Set<number>(), g: new Set<number>() };
    const pairs = (v.pairs ?? []).filter(([p, g]) => Number.isInteger(p) && Number.isInteger(g) && p >= 0 && p < j.items.length && g >= 0 && g < gold.length)
      .filter(([p, g]) => (used.p.has(p) || used.g.has(g) ? false : (used.p.add(p), used.g.add(g), true)))
      .sort((x, y) => x[0] - y[0]);
    listScores(j.a, j.t, listSpec(j.t), pairs, j.items, input.corpusDocs.get(j.a.pack) ?? new Set(), put);
  }
  return out;
}

/** Set precision / recall / F1 over the matched pairs, and what the task type adds: order and dates, attribution. */
export function listScores(
  a: AnswerRecord, t: Task, spec: ListSpec, matched: [number, number][], items: { label: string; evidence: string[]; date?: string; confidence: number | null }[],
  docs: Set<string>, put: Put,
): void {
  const gold = t.items!;
  const cited = (i: number) => new Set(items[i].evidence.map((e) => evidenceDoc(e, docs)).filter((d): d is string => Boolean(d)));
  // "which sources": a side found without one of its documents is not found
  const pairs = spec.requireDocs ? matched.filter(([p, g]) => (gold[g].docs ?? []).some((d) => cited(p).has(d))) : matched;
  const totalWeight = gold.reduce((s, g) => s + g.weight, 0);
  const hitWeight = pairs.reduce((s, [, g]) => s + gold[g].weight, 0);
  const precision = items.length ? pairs.length / items.length : 0;
  const recall = totalWeight ? hitWeight / totalWeight : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  put(a, t, 'set_precision', precision);
  put(a, t, 'set_recall', recall, { matched: pairs.map(([p, g]) => [items[p].label, gold[g].label]) });
  put(a, t, 'set_f1', f1);
  // exact: the whole set, nothing missing and nothing extra
  let correctness = spec.primary === 'recall' ? recall : spec.primary === 'exact' ? (pairs.length === gold.length && items.length === gold.length ? 1 : 0) : f1;
  if (spec.ordered) {
    const order = orderAccuracy(pairs, gold);
    put(a, t, 'order_accuracy', order);
    if (order !== null) correctness *= order;
    const dated = pairs.filter(([p, g]) => gold[g].date && items[p].date);
    put(a, t, 'date_accuracy', pairs.length ? dated.filter(([p, g]) => sameDate(items[p].date!, gold[g].date!)).length / pairs.length : null);
  }
  const attributed = pairs.filter(([, g]) => gold[g].docs?.length);
  if (attributed.length) {
    put(a, t, 'attribution_recall', attributed.reduce((s, [p, g]) => s + gold[g].docs!.filter((d) => cited(p).has(d)).length / gold[g].docs!.length, 0) / attributed.length);
  }
  put(a, t, 'correctness', correctness, { metric: spec.primary === 'recall' ? 'set_recall' : spec.primary === 'exact' ? 'exact_set' : 'set_f1', ...(spec.ordered ? { times: 'order_accuracy' } : {}) });
  // a look-alike's items given for the asked entity's
  const distractors = Array.isArray(t.meta?.distractors) ? (t.meta!.distractors as unknown[]).map(String) : [];
  if (distractors.length) {
    const took = items.filter((it, i) => !pairs.some(([p]) => p === i) && distractors.some((d) => containsTerm(it.label, d))).length;
    put(a, t, 'distractor_rate', items.length ? took / items.length : 0);
    put(a, t, 'stale_answer', took > 0 ? 1 : 0);
  }
  // wrong, and said with confidence (no confidence given counts as confident)
  if (items.length) {
    const stated = items.map((it) => it.confidence ?? 1);
    put(a, t, 'confident_wrong', correctness < 0.5 && stated.reduce((x, y) => x + y, 0) / stated.length >= 0.7 ? 1 : 0);
  }
  const conf = items.map((it, i) => (it.confidence === null ? null : (it.confidence - (pairs.some(([p]) => p === i) ? 1 : 0)) ** 2)).filter((x): x is number => x !== null);
  if (conf.length) put(a, t, 'brier', conf.reduce((s, x) => s + x, 0) / conf.length);
}
