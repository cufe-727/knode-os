import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LlmClient } from '../llm/client.js';
import type { CallUsage } from '../llm/usage.js';
import { mapLimit } from '../bench/util.js';
import { Meter } from './meter.js';
import { QuotaGuard } from './quota.js';

/**
 * The judge (docs/design/23 §6): a model of another family than the one
 * every system answers with (Claude judging Codex), asked in batches of a few
 * items per call so a pilot fits a plan's quota. Items are anonymous — the
 * caller strips what identifies a system and mixes systems within a batch —
 * and every verdict is cached by what was asked, so a rerun never asks twice.
 */

export const JUDGE_SYSTEM = '__judge__';

export interface JudgeOptions {
  client: LlmClient;
  meter: Meter;
  quota?: QuotaGuard;
  cacheFile?: string;
  batchSize?: number;
  concurrency?: number;
}

type Verdicts<T> = Map<string, T>;

export class Judge {
  private readonly cache = new Map<string, unknown>();
  private readonly batchSize: number;

  constructor(private readonly opts: JudgeOptions) {
    this.batchSize = opts.batchSize ?? 8;
    if (opts.cacheFile && fs.existsSync(opts.cacheFile)) {
      for (const line of fs.readFileSync(opts.cacheFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as { k: string; v: unknown };
          this.cache.set(r.k, r.v);
        } catch {
          /* torn line */
        }
      }
    }
    if (opts.cacheFile) fs.mkdirSync(path.dirname(opts.cacheFile), { recursive: true });
  }

  get label(): string {
    return this.opts.client.label;
  }

  private remember(k: string, v: unknown): void {
    this.cache.set(k, v);
    if (this.opts.cacheFile) fs.appendFileSync(this.opts.cacheFile, JSON.stringify({ k, v }) + '\n');
  }

  /**
   * Ask `system` about `items` a batch at a time; `render` gives each item's
   * block, the model answers {"verdicts":[{"id":…, …}]}. Items already judged
   * come from the cache; an item the model left out comes back undefined.
   */
  async batch<I extends { id: string }, V>(kind: string, system: string, items: I[], render: (item: I) => unknown): Promise<Verdicts<V>> {
    const out: Verdicts<V> = new Map();
    const keyOf = (item: I) => crypto.createHash('sha256').update(JSON.stringify([kind, system, render(item)])).digest('hex');
    const todo: I[] = [];
    for (const item of items) {
      const hit = this.cache.get(keyOf(item));
      if (hit !== undefined) out.set(item.id, hit as V);
      else todo.push(item);
    }
    const batches: I[][] = [];
    for (let i = 0; i < todo.length; i += this.batchSize) batches.push(todo.slice(i, i + this.batchSize));
    await mapLimit(batches, this.opts.concurrency ?? 2, async (group) => {
      const user = JSON.stringify({ items: group.map((item) => ({ id: item.id, ...(render(item) as object) })) }, null, 1);
      let usage: CallUsage | null = null;
      const t0 = Date.now();
      const call = () => this.opts.client.completeJson<{ verdicts?: (V & { id?: string })[] }>(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        { maxTokens: 400 * group.length + 400, onUsage: (u) => (usage = u) },
      );
      let reply: { verdicts?: (V & { id?: string })[] };
      try {
        // a plan's limit can last hours: wait it out (6 h at the guard's 5-minute poll) rather than lose the batch
        reply = this.opts.quota ? await this.opts.quota.retryRefused(call, 72) : await call();
        this.opts.meter.record({ system: JUDGE_SYSTEM, stage: kind, model: this.opts.client.model || this.opts.client.label, ms: Date.now() - t0, ok: true, replayed: false, usage });
      } catch (err) {
        this.opts.meter.record({ system: JUDGE_SYSTEM, stage: kind, model: this.opts.client.model || this.opts.client.label, ms: Date.now() - t0, ok: false, replayed: false, usage });
        throw err;
      }
      const byId = new Map((reply.verdicts ?? []).filter((v) => v && typeof v.id === 'string').map((v) => [v.id as string, v]));
      for (const item of group) {
        const v = byId.get(item.id);
        if (v === undefined) continue;
        this.remember(keyOf(item), v);
        out.set(item.id, v as V);
      }
    }, (err) => {
      throw err;
    });
    return out;
  }

  /* --------------------------------- grading -------------------------------- */

  async gradeAnswers(items: GradeItem[]): Promise<Verdicts<GradeVerdict>> {
    const raw = await this.batch<GradeItem, GradeVerdict>('grade', GRADE_SYSTEM, items, (i) => ({
      question: i.question,
      ...(i.expectAbstain ? { expectAbstain: true } : { reference: i.reference }),
      ...(i.keypoints?.length ? { keypoints: i.keypoints.map((k, n) => `${n}: ${k}`) } : {}),
      answer: i.answer.slice(0, 6000),
    }));
    for (const [id, v] of raw) raw.set(id, { ...v, score: clampScore(v.score), keypoints: Array.isArray(v.keypoints) ? v.keypoints.map(Number).filter(Number.isInteger) : [] });
    return raw;
  }

  async factPresent(items: { id: string; fact: string; units: string[] }[]): Promise<Verdicts<{ present: boolean; unit?: number }>> {
    return this.batch('coverage', COVERAGE_SYSTEM, items, (i) => ({ fact: i.fact, knowledge: i.units.map((u, n) => `[${n}] ${u.slice(0, 1200)}`) }));
  }

  async claimSupport(items: { id: string; claim: string; sources: string[] }[]): Promise<Verdicts<{ verdict: SupportVerdict }>> {
    return this.batch('support', SUPPORT_SYSTEM, items, (i) => ({ claim: i.claim, sources: i.sources.map((s, n) => `[${n}] ${s.slice(0, 1500)}`) }));
  }

  async decompose(items: { id: string; text: string }[]): Promise<Verdicts<{ claims: string[] }>> {
    return this.batch('decompose', DECOMPOSE_SYSTEM, items, (i) => ({ text: i.text.slice(0, 4000) }));
  }

  async matchItems(items: { id: string; predicted: string[]; gold: string[] }[]): Promise<Verdicts<{ pairs: [number, number][] }>> {
    return this.batch('match', MATCH_SYSTEM, items, (i) => ({
      predicted: i.predicted.map((p, n) => `${n}: ${p}`),
      gold: i.gold.map((g, n) => `${n}: ${g}`),
    }));
  }

  /** Corpus-level lists (aggregate, timeline, contradiction, profile): a stricter match than themes — same name, number and date. */
  async matchList(items: { id: string; predicted: string[]; gold: string[] }[]): Promise<Verdicts<{ pairs: [number, number][] }>> {
    return this.batch('list', LIST_MATCH_SYSTEM, items, (i) => ({
      predicted: i.predicted.map((p, n) => `${n}: ${p.slice(0, 400)}`),
      gold: i.gold.map((g, n) => `${n}: ${g.slice(0, 400)}`),
    }));
  }

  async linkCorrect(items: { id: string; head: string; relation: string; tail: string; sources: string[] }[]): Promise<Verdicts<{ correct: boolean }>> {
    return this.batch('link', LINK_SYSTEM, items, (i) => ({ link: `${i.head} —${i.relation}→ ${i.tail}`, sources: i.sources.map((s, n) => `[${n}] ${s.slice(0, 1200)}`) }));
  }

  async samePair(items: { id: string; a: string; b: string }[]): Promise<Verdicts<{ same: boolean }>> {
    return this.batch('same', SAME_SYSTEM, items, (i) => ({ a: i.a.slice(0, 600), b: i.b.slice(0, 600) }));
  }

  async contradicts(items: { id: string; a: string; b: string }[]): Promise<Verdicts<{ contradict: boolean }>> {
    return this.batch('contradict', CONTRADICT_SYSTEM, items, (i) => ({ a: i.a.slice(0, 800), b: i.b.slice(0, 800) }));
  }
}

export interface GradeItem {
  id: string;
  question: string;
  reference?: string;
  keypoints?: string[];
  answer: string;
  expectAbstain?: boolean;
}

export interface GradeVerdict {
  score: 0 | 1 | 2;
  keypoints: number[];
  abstained: boolean;
  hallucinated: boolean;
  reason?: string;
}

export type SupportVerdict = 'supported' | 'inference' | 'unsupported' | 'contradicted';

function clampScore(v: unknown): 0 | 1 | 2 {
  const n = Math.round(Number(v));
  return n >= 2 ? 2 : n === 1 ? 1 : 0;
}

const JSON_SHAPE = (fields: string) => `Answer with one JSON object: {"verdicts":[{"id":"<item id>", ${fields}}, …]} — one verdict per item, in any order.`;

export const GRADE_SYSTEM = `You grade answers to questions about a private document collection. Items are independent and come from different systems in random order; judge only content, never length, style, citation format or language (answers and references may be Chinese or English).

For an item with a reference answer:
- score 2: states the reference's key information with no material error
- score 1: partly right — some key information, or a minor error or omission
- score 0: wrong, off-topic, or declines although the reference shows the question is answerable
For an item with "expectAbstain": true the sources do not contain the answer:
- score 2: clearly says the information is not available (a guess clearly labelled as one is fine)
- score 0: asserts an answer as fact
"keypoints": the indices of listed key points the answer states correctly.
"abstained": true when the answer declines or says the sources do not tell.
"hallucinated": true when it asserts something false or contradicting the reference.
${JSON_SHAPE('"score":0|1|2, "keypoints":[int], "abstained":bool, "hallucinated":bool, "reason":"≤15 words"')}`;

export const COVERAGE_SYSTEM = `For each item, decide whether the knowledge snippets state the given fact — explicitly or as a direct paraphrase or implication a reader would accept. Partial matches that lose the fact's key detail (a number, a date, who did it) do not count.
${JSON_SHAPE('"present":bool, "unit":<index of the snippet that states it, or -1>')}`;

export const SUPPORT_SYSTEM = `For each item, decide how the source passages bear on the claim:
- "supported": a passage states it (paraphrase is fine)
- "inference": no passage states it, but it follows from combining the passages
- "unsupported": the passages neither state nor imply it
- "contradicted": a passage says otherwise
${JSON_SHAPE('"verdict":"supported"|"inference"|"unsupported"|"contradicted"')}`;

export const DECOMPOSE_SYSTEM = `Split each text into atomic claims: one checkable assertion each, self-contained (resolve pronouns, keep dates and numbers), in the text's own language. Skip headings, navigation and link markup. At most 12 claims per text.
${JSON_SHAPE('"claims":["…"]')}`;

export const MATCH_SYSTEM = `Each item has predicted entries and gold entries. Pair a predicted entry with a gold entry when it expresses the same theme, need or item (wording and language may differ; a broader or vaguer entry does not match a specific gold one). Each entry is used at most once.
${JSON_SHAPE('"pairs":[[<predicted index>,<gold index>], …]')}`;

export const LIST_MATCH_SYSTEM = `Each item has the list an answer gave and the gold list (one entry per line; gold entries may give alternative names after " / " and a date in parentheses). Pair a predicted entry with a gold entry when they state the same thing: the same listed thing, fact, event, change of state or side of a disagreement. Wording and language may differ. Do not pair when the predicted entry names a different person, figure or date, when it is broader or vaguer than the gold entry, or when it merges several gold entries into one (pair it with at most one of them). Each entry is used at most once.
${JSON_SHAPE('"pairs":[[<predicted index>,<gold index>], …]')}`;

export const LINK_SYSTEM = `Each item is a link a knowledge base drew between two things, with the source passages. Decide whether the sources support that relation between them (the relation label may be loose; the connection must be real and of that kind).
${JSON_SHAPE('"correct":bool')}`;

export const SAME_SYSTEM = `Each item has two entries from a knowledge base. Decide whether they describe the same real-world entity (same person, company, product, place, concept) under different names or spellings.
${JSON_SHAPE('"same":bool')}`;

export const CONTRADICT_SYSTEM = `Each item has two statements from one knowledge base. Decide whether they contradict each other (both cannot be true at the same time; statements about different dates do not contradict).
${JSON_SHAPE('"contradict":bool')}`;
