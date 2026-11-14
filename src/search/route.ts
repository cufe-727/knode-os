import { LlmClient } from '../llm/client.js';
import { resolveTemporal } from '../store/resolver.js';
import { isListQuestion } from './excerpts.js';

/**
 * What kind of question `ask` is answering (docs/design/30 §1).
 *
 * The 2026-11 corpus benchmark scored `ask` 0.52 on aggregate tasks and 0.29
 * on deep-hop ones: one top-k search cannot list every case, and one search
 * cannot cross two relations. So `ask` routes:
 *
 *   lookup     "what / who / when is X": today's single-shot path, same cost.
 *   list       "which / list every …": the claims about what the question
 *              names, enumerated (src/search/enumerate.ts), not the top few.
 *   aggregate  "how many / how often / the most …": the same enumeration with
 *              counts over the whole match, not over what fits in a prompt.
 *   timeline   "history of / since 2024 / in chronological order": the
 *              enumeration in event-time order, replaced facts included.
 *   multihop   "the X of the Y that …": a bounded walk entity → relations →
 *              entity, reading the passages where each hop's two ends meet.
 *
 * Rules decide, from the question's wording; they cost nothing. With
 * `classifier: 'model'` a question the rules call a lookup only for want of a
 * cue is put to the Judge stage's model once (a short JSON answer); the rules'
 * answer stands when that call fails.
 */

export type QuestionKind = 'lookup' | 'list' | 'aggregate' | 'timeline' | 'multihop';

export interface QuestionRoute {
  kind: QuestionKind;
  /** World-time window the question names ("in 2025", "since March 2026", "2026Q2"), as ISO instants. */
  range: { from: string | null; to: string | null; text: string } | null;
  /** Which rule or step decided. */
  by: string;
}

const TIMELINE = [
  /时间线|时间轴|从早到晚|从晚到早|按时间(顺序)?|先后顺序|历次|演变|变迁|历程|沿革/,
  /\btimeline\b|\bchronolog|\bhistory of\b|\bin (chronological )?order\b|\bover time\b|\bevolv(e|ed|ing)\b|\bhow has .+ changed\b|\bsequence of\b/i,
];

const AGGREGATE = [
  /多少|几[次个家条篇份项位年月天]|总共|一共|合计|总数|总额|平均|最多|最少|最高|最低|排名|占比|增长了?多少|频率/,
  /\bhow (many|much|often)\b|\bcount\b|\bnumber of\b|\btotal\b|\bsum\b|\baverage\b|\bmean\b|\b(most|least|highest|lowest|largest|smallest)\b|\brank(ed|ing)?\b|\bpercentage\b/i,
];

/**
 * A question that crosses a relation before it can be answered: a noun phrase
 * qualified by a clause ("the company that acquired X"), a chain of "of the"
 * ("the CEO of the parent of X"), a possessive chain, or a Chinese 的-chain
 * ("X的母公司的CEO"). A miss costs what today's path costs; a false hit costs
 * a walk over a few relations.
 */
const MULTIHOP = [
  /\b(?:the|a|an)\s+(?:[\w-]+\s+){0,3}?(?:that|which|who|whose)\s+(?!is\b|are\b|was\b|were\b)\w+/i,
  /\bof the\b[^?]*\bof (?:the\b|[A-Z])/,
  /'s\s+[\w-]+(?:\s+[\w-]+)?'s\b/,
  /\b(?:where|when) (?:was|did|is) the\s+[\w-]+\s+(?:that|which|who)\b/i,
  /的[^，。？?、\s]{1,12}的[^，。？?、\s]{1,12}(是谁|是什么|是哪|在哪|叫什么|有哪些|有多少)/,
  /(所在|隶属|母公司|子公司|创始人|投资方|收购方|前任|继任)[^，。？?]{0,8}的/,
];

/**
 * A chain of questions: one part introduces something it does not name, by
 * asking for it ("是谁处理好的？", "哪个项目？", "who fixed INC-7?") or by
 * describing it ("提出风险R-03的人", "修复它的工程师", "一起由客户升级的事故",
 * "an engineer"), and a later clause asks about it by a back-reference ("此人",
 * "那个项目", "同一个客户", "新负责人", "that person", "their project"). The
 * benchmark's deep-hop and nonlexical-hop questions are all of this shape, and
 * none of them matched MULTIHOP, which wants the hops inside one noun phrase.
 *
 * A back-reference to something the question names ("What is Atlas? When did
 * it launch?") is not a chain: "it", "its" and a bare "其" are not read as
 * back-references, and an introducer must come before the back-reference.
 * Which-questions over a plural ("which incidents … ? Which were they") are
 * lists, not chains.
 */
const CHAIN_INTRO = [
  // an interrogative that asks for a person or a thing, not a time or an amount
  /谁|哪(?:一)?[个位家起项名组件条]|哪些人/,
  // an indefinite one, or a description of one: "一起由客户升级的事故", "提出R-03的人", "升级的那起事故", "换了负责人"
  /[一另]\s*[起个位名家项件条](?![月日年周])|的(?:人|工程师|同事|员工|那位|那个|那起|那一起)|换了?\S{0,3}(?:负责人|owner)/,
  /\bwho(?:m|se)?\b|\bwhich\s+(?!\w+s\b)(?!(?:is|are|was|were|has|have|had|does|do|did|will|would|can|could|this|these|those|of)\b)\w+|\b(?:a|an|another|some|one)\s+(?:[\w-]+\s+)?(?:person|engineer|employee|colleague|project|team|customer|client|incident|risk|company|owner|manager)\b/i,
];

/** A reference back to something an earlier clause introduced. */
const CHAIN_BACK = [
  /此人|该人|这个人|那个人|这位|那位|(?<![其吉])[他她]|(?<!其)它|对方|同一(?![周天日月年时期次类种样]|[个位家起名项件]?(?:问题|事))|那(?:一)?[个位家起项名件条组]|该(?:项目|组|客户|事故|风险|员工|工程师|同事)|新(?:的)?负责人|前者|后者/,
  /\b(?:that|this|the same)\s+(?:person|engineer|employee|colleague|project|team|customer|client|incident|risk|company|owner|manager|one)\b|\b(?:he|she|him|her|his|hers|they|them|their|theirs)\b|\bthe new (?:owner|lead|manager|assignee)\b|\bthe (?:former|latter)\b/i,
];

/** Where a clause ends: a sentence or a comma, a dash, a semicolon, a line. */
const CLAUSE_END = /[。？?！!；;，,—\n]|\.\s/g;

/** True when a later clause refers back to something an earlier part introduced without naming it. */
export function isChainQuestion(question: string): boolean {
  const ends = [...question.matchAll(CLAUSE_END)].map((m) => (m.index ?? 0) + m[0].length);
  if (ends.length === 0) return false;
  for (const start of ends) {
    const rest = question.slice(start);
    for (const re of CHAIN_BACK) {
      const m = re.exec(rest);
      if (!m) continue;
      const before = question.slice(0, start + (m.index ?? 0));
      if (CHAIN_INTRO.some((intro) => intro.test(before))) return true;
    }
  }
  return false;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * The time window a question names, in a form `resolveTemporal` reads: a year,
 * a quarter or half, a month, "between A and B", "since A", "before B" (and
 * the Chinese forms). Null when it names none, or names it in a way these
 * patterns do not read.
 */
export function questionRange(question: string): QuestionRoute['range'] {
  const q = question;
  const monthOf = (name: string) => String(MONTHS.indexOf(name.toLowerCase()) + 1).padStart(2, '0');
  // Chinese forms first: they carry their own markers
  let m = /(\d{4})\s*年\s*(\d{1,2})\s*月?\s*(?:至|到|-|—|~)\s*(\d{4})\s*年\s*(\d{1,2})\s*月/.exec(q);
  if (m) return parse(`${m[1]}-${m[2].padStart(2, '0')}..${m[3]}-${m[4].padStart(2, '0')}`, m[0]);
  m = /(\d{4})\s*年?\s*(?:至|到|-|—|~)\s*(\d{4})\s*年/.exec(q);
  if (m) return parse(`${m[1]}..${m[2]}`, m[0]);
  m = /(?:自|从)\s*(\d{4})\s*年(?:\s*(\d{1,2})\s*月)?\s*(?:以来|起|开始)?/.exec(q);
  if (m && /以来|起|开始|至今/.test(q)) return parse(`${m[1]}${m[2] ? `-${m[2].padStart(2, '0')}` : ''}..`, m[0]);
  m = /(\d{4})\s*年\s*(\d{1,2})\s*月/.exec(q);
  if (m) return parse(`${m[1]}-${m[2].padStart(2, '0')}`, m[0]);
  m = /(\d{4})\s*年\s*(上半年|下半年|第?[一二三四1-4]\s*季度|Q[1-4])/i.exec(q);
  if (m) {
    const part = m[2];
    const quarter = /[一1]/.test(part) ? 1 : /[二2]/.test(part) ? 2 : /[三3]/.test(part) ? 3 : 4;
    const token = part === '上半年' ? `${m[1]}-01..${m[1]}-06` : part === '下半年' ? `${m[1]}-07..${m[1]}-12` : `${m[1]}Q${quarter}`;
    return parse(token, m[0]);
  }
  // English
  m = /\bbetween\s+(\d{4})(?:-(\d{2}))?\s+and\s+(\d{4})(?:-(\d{2}))?\b/i.exec(q);
  if (m) return parse(`${m[1]}${m[2] ? `-${m[2]}` : ''}..${m[3]}${m[4] ? `-${m[4]}` : ''}`, m[0]);
  m = /\bfrom\s+(\d{4})\s+(?:to|until|through)\s+(\d{4})\b/i.exec(q);
  if (m) return parse(`${m[1]}..${m[2]}`, m[0]);
  m = new RegExp(`\\b(?:since|after|from)\\s+(?:(${MONTHS.join('|')})\\s+)?(\\d{4})\\b`, 'i').exec(q);
  if (m) return parse(`${m[2]}${m[1] ? `-${monthOf(m[1])}` : ''}..`, m[0]);
  m = new RegExp(`\\b(?:before|until|prior to)\\s+(?:(${MONTHS.join('|')})\\s+)?(\\d{4})\\b`, 'i').exec(q);
  if (m) return parse(`..${m[2]}${m[1] ? `-${monthOf(m[1])}` : ''}`, m[0]);
  m = /\b(Q[1-4])\s*(\d{4})\b|\b(\d{4})\s*(Q[1-4])\b/i.exec(q);
  if (m) return parse(`${m[2] ?? m[3]}${(m[1] ?? m[4]).toUpperCase()}`, m[0]);
  m = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{4})\\b`, 'i').exec(q);
  if (m) return parse(`${m[2]}-${monthOf(m[1])}`, m[0]);
  m = /\b(\d{4})-(\d{2})\b/.exec(q);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return parse(`${m[1]}-${m[2]}`, m[0]);
  m = /(?:\bin\s+|\bduring\s+|\bof\s+)(\d{4})\b|(\d{4})\s*年/.exec(q);
  if (m) return parse(m[1] ?? m[2], m[0]);
  return null;
}

function parse(token: string, text: string): QuestionRoute['range'] {
  const year = Number(/\d{4}/.exec(token)?.[0]);
  if (!(year >= 1900 && year <= 2200)) return null;
  try {
    const t = resolveTemporal({ validRange: token });
    if (!t.validFrom && !t.validTo) return null;
    return { from: t.validFrom, to: t.validTo, text: text.trim() };
  } catch {
    return null;
  }
}

/** The kind of a question by its wording alone. */
export function classifyQuestion(question: string): QuestionRoute {
  const range = questionRange(question);
  if (TIMELINE.some((re) => re.test(question))) return { kind: 'timeline', range, by: 'rule:timeline' };
  // before the counts and lists: what those would enumerate is the thing the question has yet to find
  if (isChainQuestion(question)) return { kind: 'multihop', range, by: 'rule:chain' };
  if (AGGREGATE.some((re) => re.test(question))) return { kind: 'aggregate', range, by: 'rule:aggregate' };
  if (isListQuestion(question)) return { kind: 'list', range, by: 'rule:list' };
  if (MULTIHOP.some((re) => re.test(question))) return { kind: 'multihop', range, by: 'rule:multihop' };
  // a window and a plural is a list in time: "what did Acme announce in 2025"
  if (range && /\b(announce|release|launch|report|publish|sign|acquire)\w*\b|发布|宣布|签署|收购|报道/.test(question)) return { kind: 'list', range, by: 'rule:range' };
  return { kind: 'lookup', range, by: 'rule:default' };
}

const KINDS: QuestionKind[] = ['lookup', 'list', 'aggregate', 'timeline', 'multihop'];

const CLASSIFY_PROMPT = `Classify the question for a knowledge-base retriever. Kinds:
- lookup: one fact or description about something named ("what is X", "who founded X", "when did X happen").
- list: every case / item matching a condition ("which papers…", "list all…").
- aggregate: a count, total, average, maximum or ranking over many cases.
- timeline: how something developed over time, in order.
- multihop: needs one fact to find the thing another fact is about ("the CEO of the company that acquired X").
Answer with JSON only: {"kind": "<one of lookup|list|aggregate|timeline|multihop>"}`;

/**
 * `classifyQuestion`, and with `classifier: 'model'` one small model call
 * for a question the rules only defaulted to a lookup.
 */
export async function routeQuestion(question: string, opts: { classifier?: 'rules' | 'model'; llm?: LlmClient } = {}): Promise<QuestionRoute> {
  const ruled = classifyQuestion(question);
  if (opts.classifier !== 'model' || ruled.by !== 'rule:default' || !opts.llm?.enabled) return ruled;
  try {
    const r = await opts.llm.completeJson<{ kind?: string }>([
      { role: 'system', content: CLASSIFY_PROMPT },
      { role: 'user', content: question },
    ], { maxTokens: 30 });
    const kind = String(r?.kind ?? '').toLowerCase() as QuestionKind;
    return KINDS.includes(kind) ? { kind, range: ruled.range, by: 'model' } : ruled;
  } catch {
    return ruled;
  }
}
