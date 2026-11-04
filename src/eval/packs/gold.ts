import crypto from 'node:crypto';
import { mapLimit } from '../../bench/util.js';
import type { LlmClient } from '../../llm/client.js';
import { foldSpace, seededKey } from '../pack.js';
import { Bm25, chunkDocs } from '../retrieval.js';
import type { GoldFact, Task } from '../types.js';

/**
 * Gold and tasks for packs whose sources come without them (docs/design/23
 * §2). An author model (Claude — another family than the Codex answerer)
 * drafts atomic facts with an exact quote, and every quote is checked to be
 * a substring of its document; tasks are written from those facts, then each
 * is answered by the author reading only its evidence (the oracle check) and
 * dropped when that answer does not match — gold an oracle cannot recover is
 * noise. Unanswerable questions are kept only when the author, shown the
 * passages most likely to answer them, agrees the corpus does not.
 */

export interface DocText {
  path: string;
  text: string;
  date?: string;
}

const id = (...parts: string[]) => crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 10);

function langName(lang: string): string {
  return lang === 'zh' ? 'Chinese' : 'English';
}

/* ------------------------------- gold facts ------------------------------- */

export async function extractFacts(author: LlmClient, docs: DocText[], opts: { lang: string; perDoc?: number; maxChars?: number; batch?: number; log?: (m: string) => void }): Promise<GoldFact[]> {
  const perDoc = opts.perDoc ?? 6;
  const maxChars = opts.maxChars ?? 7000;
  const batches: DocText[][] = [];
  for (let i = 0; i < docs.length; i += opts.batch ?? 3) batches.push(docs.slice(i, i + (opts.batch ?? 3)));
  const out: GoldFact[] = [];
  let rejected = 0;
  await mapLimit(batches, 3, async (group, bi) => {
    const reply = await author.completeJson<{ facts?: { doc?: string; text?: string; quote?: string; entities?: string[]; date?: string; kind?: string }[] }>([
      { role: 'system', content: `You write gold facts for a benchmark. For each document, list up to ${perDoc} atomic facts a reader could look up in it: one checkable statement each (who/what/when/how much), self-contained, written in ${langName(opts.lang)}. For each fact give "quote": a short span copied EXACTLY, character for character, from the document that states it (8–60 characters). Prefer specific facts (names, numbers, dates, decisions, opinions attributed to someone) over generic ones. Skip boilerplate.
Answer with JSON: {"facts":[{"doc":"<path>","text":"…","quote":"…","entities":["…"],"date":"YYYY-MM-DD or empty","kind":"fact|opinion|prediction|event"}]}` },
      { role: 'user', content: group.map((d) => `<document path="${d.path}"${d.date ? ` date="${d.date}"` : ''}>\n${d.text.slice(0, maxChars)}\n</document>`).join('\n\n') },
    ], { maxTokens: 4000 });
    for (const f of reply.facts ?? []) {
      const doc = group.find((d) => d.path === f.doc);
      if (!doc || !f.text || !f.quote) continue;
      if (!foldSpace(doc.text).includes(foldSpace(f.quote))) {
        rejected++;
        continue;
      }
      out.push({ id: `f-${id(doc.path, f.quote)}`, text: f.text.trim(), doc: doc.path, quote: f.quote, entities: (f.entities ?? []).map(String).filter(Boolean).slice(0, 6), ...(f.date ? { date: f.date } : {}), kind: f.kind ?? 'fact' });
    }
    if ((bi + 1) % 10 === 0) opts.log?.(`facts: ${bi + 1}/${batches.length} batches, ${out.length} kept, ${rejected} quotes rejected`);
  }, (err) => opts.log?.(`facts batch failed: ${err instanceof Error ? err.message : String(err)}`));
  const seen = new Set<string>();
  return out.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
}

/* --------------------------------- tasks --------------------------------- */

export interface TaskPlan {
  single?: number;
  multi?: number;
  temporal?: number;
  unanswerable?: number;
  global?: number;
}

type Draft = Omit<Task, 'evidence'> & { evidence: Task['evidence'] };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');

function pick<T>(items: T[], n: number, seed: string | number, key: (t: T) => string): T[] {
  return [...items].sort((a, b) => seededKey(seed, key(a)).localeCompare(seededKey(seed, key(b)))).slice(0, n);
}

export async function generateTasks(author: LlmClient, facts: GoldFact[], docs: DocText[], opts: { lang: string; plan: TaskPlan; seed?: string | number; prefix?: string; log?: (m: string) => void }): Promise<Task[]> {
  const seed = opts.seed ?? 0;
  const lang = langName(opts.lang);
  const prefix = opts.prefix ?? 't';
  const drafts: Draft[] = [];
  const byId = new Map(facts.map((f) => [f.id, f]));
  const docText = new Map(docs.map((d) => [d.path, d.text]));

  // single-hop: one fact each, paraphrased so the question does not copy the quote
  const singles = pick(facts.filter((f) => f.kind !== 'opinion'), opts.plan.single ?? 0, seed, (f) => f.id);
  for (let i = 0; i < singles.length; i += 10) {
    const group = singles.slice(i, i + 10);
    const r = await author.completeJson<{ tasks?: { fact?: string; question?: string; answer?: string; short?: boolean }[] }>([
      { role: 'system', content: `Write one benchmark question per fact, in ${lang}. The question must be answerable from the fact's document alone, stand on its own (name the people, companies, places involved), and paraphrase rather than copy the quote. "answer": the short answer. "short": true when the answer is a name, number, date or a few words.
Answer with JSON: {"tasks":[{"fact":"<fact id>","question":"…","answer":"…","short":true}]}` },
      { role: 'user', content: JSON.stringify(group.map((f) => ({ fact: f.id, text: f.text, quote: f.quote, doc: f.doc }))) },
    ], { maxTokens: 3000 });
    for (const t of r.tasks ?? []) {
      const f = t.fact ? byId.get(t.fact) : undefined;
      if (!f || !t.question || !t.answer) continue;
      drafts.push({ id: `${prefix}-s-${id(f.id)}`, suite: 'usage', type: 'single-hop', lang: opts.lang, question: t.question, answer: t.answer, scoring: t.short ? 'exact' : 'judge', evidence: [{ doc: f.doc, quote: f.quote }], primary: true });
    }
  }

  // multi-hop: two facts from different documents that share an entity
  const byEntity = new Map<string, GoldFact[]>();
  for (const f of facts) for (const e of f.entities) (byEntity.get(norm(e)) ?? byEntity.set(norm(e), []).get(norm(e))!).push(f);
  const pairs: [GoldFact, GoldFact, string][] = [];
  for (const [e, list] of byEntity) {
    if (e.length < 2) continue;
    const docsOf = [...new Set(list.map((f) => f.doc))];
    if (docsOf.length < 2) continue;
    const a = list.find((f) => f.doc === docsOf[0])!;
    const b = list.find((f) => f.doc === docsOf[1])!;
    pairs.push([a, b, e]);
  }
  const chosenPairs = pick(pairs, opts.plan.multi ?? 0, seed, ([a, b]) => a.id + b.id);
  for (let i = 0; i < chosenPairs.length; i += 6) {
    const group = chosenPairs.slice(i, i + 6);
    const r = await author.completeJson<{ tasks?: { pair?: number; question?: string; answer?: string; keypoints?: string[] }[] }>([
      { role: 'system', content: `Each item has two facts from different documents that share an entity. Write one question in ${lang} that needs BOTH facts to answer (a bridge: find X in one, then ask about X in the other; or a comparison). It must stand on its own. Give the answer and 2–3 keypoints the answer must contain.
Answer with JSON: {"tasks":[{"pair":<index>,"question":"…","answer":"…","keypoints":["…"]}]}` },
      { role: 'user', content: JSON.stringify(group.map(([a, b, e], k) => ({ pair: k, shared: e, fact1: a.text, fact2: b.text }))) },
    ], { maxTokens: 3000 });
    for (const t of r.tasks ?? []) {
      const p = typeof t.pair === 'number' ? group[t.pair] : undefined;
      if (!p || !t.question || !t.answer) continue;
      drafts.push({ id: `${prefix}-m-${id(p[0].id, p[1].id)}`, suite: 'usage', type: 'multi-hop', lang: opts.lang, question: t.question, answer: t.answer, keypoints: t.keypoints?.slice(0, 4), scoring: 'judge', evidence: [{ doc: p[0].doc, quote: p[0].quote }, { doc: p[1].doc, quote: p[1].quote }], primary: true });
    }
  }

  // temporal: dated facts — when something happened, or which of two came first
  const dated = facts.filter((f) => f.date && /^\d{4}/.test(f.date));
  const temporal = pick(dated, opts.plan.temporal ?? 0, seed, (f) => f.id);
  if (temporal.length) {
    const r = await author.completeJson<{ tasks?: { fact?: string; question?: string; answer?: string }[] }>([
      { role: 'system', content: `Write one time question per dated fact, in ${lang}: when it happened, how long before or after something else in the fact, or what held as of a date. Stand-alone; give the answer.
Answer with JSON: {"tasks":[{"fact":"<fact id>","question":"…","answer":"…"}]}` },
      { role: 'user', content: JSON.stringify(temporal.map((f) => ({ fact: f.id, text: f.text, date: f.date }))) },
    ], { maxTokens: 3000 });
    for (const t of r.tasks ?? []) {
      const f = t.fact ? byId.get(t.fact) : undefined;
      if (!f || !t.question || !t.answer) continue;
      drafts.push({ id: `${prefix}-t-${id(f.id)}`, suite: 'usage', type: 'temporal', lang: opts.lang, question: t.question, answer: t.answer, scoring: 'judge', evidence: [{ doc: f.doc, quote: f.quote }] });
    }
  }

  // global: questions over many facts, scored by keypoints
  if (opts.plan.global) {
    const sample = pick(facts, 60, seed, (f) => f.id);
    const r = await author.completeJson<{ tasks?: { question?: string; keypoints?: string[]; facts?: string[] }[] }>([
      { role: 'system', content: `From these facts drawn across a document collection, write ${opts.plan.global} broad questions in ${lang} that need many documents to answer well (main themes, how views differ, what changed over time). For each give 4–6 keypoints a good answer contains, each backed by the listed facts, and the fact ids behind them.
Answer with JSON: {"tasks":[{"question":"…","keypoints":["…"],"facts":["<fact id>"]}]}` },
      { role: 'user', content: JSON.stringify(sample.map((f) => ({ id: f.id, text: f.text }))) },
    ], { maxTokens: 3000 });
    for (const t of r.tasks ?? []) {
      if (!t.question || !t.keypoints?.length) continue;
      const ev = [...new Set((t.facts ?? []).map((x) => byId.get(x)?.doc).filter((d): d is string => Boolean(d)))].map((doc) => ({ doc }));
      drafts.push({ id: `${prefix}-g-${id(t.question)}`, suite: 'usage', type: 'global', lang: opts.lang, question: t.question, answer: t.keypoints.join('; '), keypoints: t.keypoints, scoring: 'keypoints', evidence: ev });
    }
  }

  const kept = await oracleCheck(author, drafts, docText, lang, opts.log);

  // unanswerable: plausible questions the corpus does not answer, confirmed against the likeliest passages
  if (opts.plan.unanswerable) {
    const entities = [...byEntity.keys()].slice(0, 80);
    const r = await author.completeJson<{ questions?: string[] }>([
      { role: 'system', content: `Write ${opts.plan.unanswerable * 2} questions in ${lang} about the entities below that sound natural for this collection but that these facts do NOT answer (ask for a detail none of them gives — a figure, a date, a reason, a person). Stand-alone.
Answer with JSON: {"questions":["…"]}` },
      { role: 'user', content: JSON.stringify({ entities, facts: pick(facts, 40, seed, (f) => f.id).map((f) => f.text) }) },
    ], { maxTokens: 2000 });
    const index = new Bm25(chunkDocs(docs.map((d) => ({ path: d.path, text: d.text }))), (c) => c.text);
    const qs = (r.questions ?? []).filter(Boolean);
    const check = await author.completeJson<{ verdicts?: { i?: number; answerable?: boolean }[] }>([
      { role: 'system', content: 'For each question, decide whether the passages answer it. Answer with JSON: {"verdicts":[{"i":<index>,"answerable":true|false}]}' },
      { role: 'user', content: JSON.stringify(qs.map((q, i) => ({ i, question: q, passages: index.search(q, 5).map((h) => h.item.text.slice(0, 800)) }))) },
    ], { maxTokens: 2000 });
    const no = new Set((check.verdicts ?? []).filter((v) => v.answerable === false && typeof v.i === 'number').map((v) => v.i!));
    qs.filter((_, i) => no.has(i)).slice(0, opts.plan.unanswerable).forEach((q) => {
      kept.push({ id: `${prefix}-u-${id(q)}`, suite: 'usage', type: 'unanswerable', lang: opts.lang, question: q, scoring: 'abstain', evidence: [] });
    });
  }
  opts.log?.(`tasks: ${drafts.length} drafted, ${kept.length} kept after the oracle check`);
  return kept;
}

/** Keep the drafts the author, reading only their evidence, answers the way the gold does. */
export async function oracleCheck(author: LlmClient, drafts: Draft[], docText: Map<string, string>, lang: string, log?: (m: string) => void): Promise<Draft[]> {
  const kept: Draft[] = [];
  for (let i = 0; i < drafts.length; i += 6) {
    const group = drafts.slice(i, i + 6);
    const r = await author.completeJson<{ verdicts?: { i?: number; consistent?: boolean }[] }>([
      { role: 'system', content: `For each item, read only the evidence documents, answer the question yourself, then say whether your answer agrees with the gold answer (same key information). Questions and documents may be in ${lang} or English.
Answer with JSON: {"verdicts":[{"i":<index>,"consistent":true|false}]}` },
      { role: 'user', content: JSON.stringify(group.map((t, k) => ({ i: k, question: t.question, gold: t.answer, evidence: t.evidence.map((e) => (docText.get(e.doc) ?? '').slice(0, 5000)) }))) },
    ], { maxTokens: 1500 }).catch((err) => {
      log?.(`oracle check failed: ${err instanceof Error ? err.message : String(err)}`);
      return { verdicts: [] };
    });
    const ok = new Set((r.verdicts ?? []).filter((v) => v.consistent && typeof v.i === 'number').map((v) => v.i!));
    group.forEach((t, k) => ok.has(k) && kept.push(t));
  }
  return kept;
}
