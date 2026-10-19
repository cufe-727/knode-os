import crypto from 'node:crypto';
import { KnodeConfig } from '../config.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { writeDeps } from '../lineage/deps.js';
import { LlmClient } from '../llm/client.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { toDateString, toIso } from '../store/temporal.js';
import { applyClaimMerge, reanchorClaimGroups } from './claim-merge.js';

/**
 * Duplicate-claim audit (docs/design/10 §4). A claim's id is its subject plus
 * its statement, so the same fact in other words is another claim; this finds
 * such pairs and merges them (reversibly, graph/claim-merge.ts), files the
 * uncertain ones as suggestions, and turns real disagreements into
 * "contradicting claims" suggestions.
 *
 * Only representative claims of the same canonical subject are compared (plus
 * the swapped subject/object group). Candidates come from three signals —
 * identical once normalized, embedding similarity of "subject: statement",
 * shared key numbers (with real vectors, only where the two statements' cosine
 * still reaches a lower floor) — then deterministic checks settle what they can
 * (different periods), and the Judge stage classifies the rest in batches as
 * same / contains / conflict / different_time / unrelated. Every verdict is
 * remembered in claim_pair_verdicts, so no pair is judged twice. A run judges
 * at most review.claimMergeMaxJudgedPerRun pairs, the most promising first
 * (judgeOrder); the rest have no verdict yet and come up again next time.
 *
 * Runs after every tier-1 pass over the claims that pass wrote, and nightly
 * over everything (with re-anchoring of groups whose representative lost its
 * sources).
 */

export interface ClaimDedupeOptions {
  onProgress?: (msg: string) => void;
  /** Only claims in this set are compared against their subject's claims; absent = every claim (the nightly run). */
  focus?: string[];
  /** Cosine floor for the embedding signal. */
  threshold?: number;
  /** Cosine floor for a pair that shares a key number, when real vectors are in use. */
  numberThreshold?: number;
  /** Pairs per judge call. */
  pairsPerCall?: number;
}

export interface ClaimDedupeStats {
  candidates: number;
  /** Identical once normalized: merged without a model. */
  identical: number;
  /** Settled as different periods without a model. */
  differentTime: number;
  judged: number;
  /** Pairs that needed the judge but did not fit under review.claimMergeMaxJudgedPerRun: left for a later run. */
  deferred: number;
  merged: number;
  suggested: number;
  conflicts: number;
  embedded: number;
  reanchored: number;
}

export type ClaimRelation = 'same' | 'contains' | 'conflict' | 'different_time' | 'unrelated';

interface ClaimLite {
  id: string;
  subject: string;
  object: string | null;
  subject_name: string;
  statement: string;
  status: string;
  type: string;
  valid_from: string | Date | null;
  valid_to: string | Date | null;
  event_at: string | Date | null;
  evidence_count: number;
  members: number;
  tx_from: string | Date;
  source_path: string | null;
  excerpt: string | null;
}

interface Pair {
  id: string;
  a: ClaimLite;
  b: ClaimLite;
  /** Signals that brought the pair up. */
  why: string[];
  /** The similarity signal's score: embedding cosine, or wording overlap without real vectors; 0 when it did not bring the pair up. */
  similarity: number;
  /** Embedding cosine of a pair only a shared number brought up (real vectors); 0 otherwise. */
  cosine: number;
  /** Key numbers the two statements share. */
  shared: number;
  /** Guards that keep a judged pair from merging without a person. */
  guards: string[];
}

interface Verdict {
  relation: ClaimRelation;
  keep: 'a' | 'b' | null;
  confidence: number;
  reason: string;
  model: string;
}

/* ------------------------------- text checks ------------------------------- */

export function claimPairId(a: string, b: string): string {
  const [x, y] = [a, b].sort();
  return crypto.createHash('sha256').update(`claim-pair|${x}|${y}`).digest('hex').slice(0, 16);
}

/** Letters and digits only, NFKC-folded and lower-cased: "…增长 20%。" and "…增长20％" meet. */
export function statementKey(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const UNIT = '万亿|亿美元|亿港元|亿元|亿|万吨|万元|万|千万|百万|个百分点|pct|bp|%|倍|美元|港元|元|吨|gwh|gw|mwh|mw';
const NUMBER = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT})`, 'gi');

export interface KeyNumber {
  value: number;
  /** Decimal places as written: 36.19 → 2, 36.2 → 1, 15 → 0. */
  decimals: number;
  unit: string;
}

/** Numbers that carry a unit ("6.88亿元", "30%", "2 pct"), normalized: the facts a restatement keeps. */
export function numbersOf(s: string): KeyNumber[] {
  const text = s.normalize('NFKC').replace(/(\d),(?=\d{3})/g, '$1');
  const out: KeyNumber[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const unit = m[2].toLowerCase().replace(/^亿元$/, '亿').replace(/^万元$/, '万').replace(/^个百分点$/, 'pct');
    out.push({ value: Number(m[1]), decimals: m[1].split('.')[1]?.length ?? 0, unit });
  }
  return out;
}

export function keyNumbers(s: string): Set<string> {
  return new Set(numbersOf(s).map((n) => `${n.value}${n.unit}`));
}

/**
 * The same figure, allowing for rounding: compared at the coarser of the two
 * precisions, so 36.19亿 and 36.2亿, 0.45% and 0.5%, 14.9% and 15% agree.
 */
export function sameNumber(a: KeyNumber, b: KeyNumber): boolean {
  if (a.unit !== b.unit) return false;
  const scale = 10 ** Math.min(a.decimals, b.decimals);
  return Math.round(a.value * scale + 1e-9) === Math.round(b.value * scale + 1e-9);
}

/** Every number of `x` has a counterpart in `y`. */
function numbersWithin(x: KeyNumber[], y: KeyNumber[]): boolean {
  return x.every((n) => y.some((m) => sameNumber(n, m)));
}

const CN_QUARTER: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, '1': 1, '2': 2, '3': 3, '4': 4 };

function yearOf(y: string): number {
  return y.length === 2 ? 2000 + Number(y) : Number(y);
}

/**
 * The periods a statement names, as [first month, last month] (months counted
 * from year 0): years, quarters, halves and months with a year attached
 * ("2025年四季度", "25Q4", "Q4 2025", "4Q25", "2025年上半年", "1H25", "2025年3月",
 * "2025年"). Periods without a year ("四季度", "去年") are left out.
 */
export function periodsOf(s: string): [number, number][] {
  let text = s.normalize('NFKC').toLowerCase();
  const out: [number, number][] = [];
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => [number, number] | null) => {
    text = text.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpMatchArray;
      const p = fn(m);
      if (p) out.push(p);
      return ' ';
    });
  };
  const quarter = (y: number, q: number): [number, number] => [y * 12 + (q - 1) * 3, y * 12 + q * 3 - 1];
  const half = (y: number, h: number): [number, number] => [y * 12 + (h - 1) * 6, y * 12 + h * 6 - 1];
  take(/(?<![\d.])(20\d{2}|\d{2})\s*年?\s*(?:第\s*)?([一二三四1-4])\s*季度?/g, (m) => quarter(yearOf(m[1]), CN_QUARTER[m[2]]));
  take(/(?<![\d.])(20\d{2}|\d{2})\s*年?\s*q([1-4])(?!\d)/g, (m) => quarter(yearOf(m[1]), Number(m[2])));
  take(/q([1-4])\s*(20\d{2})(?!\d)/g, (m) => quarter(yearOf(m[2]), Number(m[1])));
  take(/(?<![\d.])([1-4])q(\d{2})(?!\d)/g, (m) => quarter(yearOf(m[2]), Number(m[1])));
  take(/(?<![\d.])(20\d{2}|\d{2})\s*年?\s*(上半年|下半年|h1|h2)/g, (m) => half(yearOf(m[1]), m[2] === '上半年' || m[2] === 'h1' ? 1 : 2));
  take(/(?<![\d.])([12])h(\d{2})(?!\d)/g, (m) => half(yearOf(m[2]), Number(m[1])));
  take(/(?<![\d.])(20\d{2})\s*年\s*(\d{1,2})\s*月/g, (m) => {
    const month = Number(m[2]);
    return month >= 1 && month <= 12 ? [Number(m[1]) * 12 + month - 1, Number(m[1]) * 12 + month - 1] : null;
  });
  // a year only where the text marks it as one — a bare 2000 may well be an amount
  take(/(?<![\d.])(?:fy\s*(20\d{2})|(20\d{2})\s*(?:年|财年|e\b))/g, (m) => {
    const y = Number(m[1] ?? m[2]);
    return [y * 12, y * 12 + 11];
  });
  return out;
}

/** Both name periods and none of A's overlaps any of B's. */
export function periodsDisjoint(a: [number, number][], b: [number, number][]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  return !a.some(([s1, e1]) => b.some(([s2, e2]) => s1 <= e2 && s2 <= e1));
}

const NEGATION = /未|没有|没能|否认|并非|并未|不会|不再|不是|无法|尚未|\bnot\b|\bno\b|\bnever\b|n't/i;

export function negated(s: string): boolean {
  return NEGATION.test(s.normalize('NFKC'));
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2));
}

function overlap(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return inter / Math.max(1, Math.min(ta.size, tb.size));
}

/** The claims' own validity windows are both known and do not meet. */
function windowsDisjoint(a: ClaimLite, b: ClaimLite): boolean {
  const af = toIso(a.valid_from);
  const bf = toIso(b.valid_from);
  if (!af || !bf) return false;
  const at = toIso(a.valid_to);
  const bt = toIso(b.valid_to);
  return Boolean((at && at < bf) || (bt && bt < af));
}

/* --------------------------------- the audit -------------------------------- */

export async function auditDuplicateClaims(
  ctx: { store: Store; embedder: EmbeddingProvider; config: KnodeConfig; llm?: LlmClient },
  opts: ClaimDedupeOptions = {},
): Promise<ClaimDedupeStats> {
  const { store, config } = ctx;
  const progress = opts.onProgress ?? (() => {});
  const stats: ClaimDedupeStats = { candidates: 0, identical: 0, differentTime: 0, judged: 0, deferred: 0, merged: 0, suggested: 0, conflicts: 0, embedded: 0, reanchored: 0 };
  const mode = config.review?.claimMerge ?? 'auto';
  if (mode === 'off') return stats;
  const minConfidence = config.review?.claimMergeMinConfidence ?? 0.9;
  const maxJudged = Math.max(0, config.review?.claimMergeMaxJudgedPerRun ?? 1200);
  const llmMin = config.review?.llmMinConfidence ?? 0.6;
  const threshold = opts.threshold ?? 0.85;
  const numberThreshold = opts.numberThreshold ?? 0.7;

  if (!opts.focus) stats.reanchored = await reanchorClaimGroups(store, { onProgress: progress });

  // every representative claim, with its canonical subject / object
  const claims = await store.query<ClaimLite>(
    `SELECT c.id, COALESCE(se.canonical_id, c.subject_id) AS subject, COALESCE(oe.canonical_id, c.object_id) AS object,
            se.name AS subject_name, c.statement, c.status, c.type, c.valid_from, c.valid_to, c.event_at,
            c.evidence_count, (SELECT count(*)::int FROM claims m WHERE m.canonical_id = c.id) AS members,
            c.tx_from, s.key AS source_path, ch.content AS excerpt
     FROM claims c
     JOIN entities se ON se.id = c.subject_id
     LEFT JOIN entities oe ON oe.id = c.object_id
     LEFT JOIN scopes s ON s.id = c.primary_scope_id
     LEFT JOIN chunks ch ON ch.id = c.chunk_id
     WHERE c.tx_to IS NULL AND c.canonical_id IS NULL AND c.status <> 'absent'`,
  );
  const byId = new Map(claims.map((c) => [c.id, c]));
  const focus = opts.focus ? [...new Set(opts.focus)].map((id) => byId.get(id)).filter((c): c is ClaimLite => Boolean(c)) : claims;
  if (focus.length === 0) return stats;
  const bySubject = new Map<string, ClaimLite[]>();
  const bySwapped = new Map<string, ClaimLite[]>();
  for (const c of claims) {
    (bySubject.get(c.subject) ?? bySubject.set(c.subject, []).get(c.subject)!).push(c);
    if (c.object) {
      const k = `${c.object}|${c.subject}`;
      (bySwapped.get(k) ?? bySwapped.set(k, []).get(k)!).push(c);
    }
  }
  const blockOf = (f: ClaimLite): ClaimLite[] => {
    const same = bySubject.get(f.subject) ?? [];
    const swapped = f.object ? bySwapped.get(`${f.subject}|${f.object}`) ?? [] : [];
    return [...same, ...swapped].filter((c) => c.id !== f.id);
  };

  /* candidates from text alone */
  const pairs = new Map<string, Pair>();
  const propose = (a: ClaimLite, b: ClaimLite, why: string, score: { similarity?: number; shared?: number } = {}) => {
    const id = claimPairId(a.id, b.id);
    const pair = pairs.get(id) ?? pairs.set(id, { id, a, b, why: [], similarity: 0, cosine: 0, shared: 0, guards: [] }).get(id)!;
    if (!pair.why.includes(why)) pair.why.push(why);
    pair.similarity = Math.max(pair.similarity, score.similarity ?? 0);
    pair.shared = Math.max(pair.shared, score.shared ?? 0);
  };
  const realVectors = config.embedding.provider !== 'local' && ctx.embedder.model !== 'local-hash-v1';
  for (const f of focus) {
    const fKey = statementKey(f.statement);
    const fNums = numbersOf(f.statement);
    for (const c of blockOf(f)) {
      if (statementKey(c.statement) === fKey) {
        propose(f, c, 'identical');
        continue;
      }
      const shared = numbersOf(c.statement).filter((n) => fNums.some((m) => sameNumber(n, m)));
      if (shared.length > 0) propose(f, c, `数字相同 ${shared.slice(0, 3).map((n) => `${n.value}${n.unit}`).join('、')}`, { shared: shared.length });
      else if (!realVectors) {
        const words = overlap(f.statement, c.statement);
        if (words >= 0.6) propose(f, c, '措辞重叠', { similarity: words });
      }
    }
  }

  /* candidates from embeddings: nearest claims of the same subject */
  if (realVectors) {
    const needed = new Set<string>();
    for (const f of focus) {
      const block = blockOf(f);
      if (block.length === 0) continue;
      needed.add(f.id);
      for (const c of block) needed.add(c.id);
    }
    stats.embedded = await ensureClaimEmbeddings(store, ctx.embedder, [...needed].map((id) => byId.get(id)!).filter(Boolean), progress);
    for (const f of focus) {
      const block = blockOf(f);
      if (block.length === 0) continue;
      const rows = await store.query<{ claim_id: string; sim: number }>(
        `SELECT b.claim_id, (1 - (a.embedding <=> b.embedding))::float AS sim
         FROM claim_embeddings a JOIN claim_embeddings b ON b.claim_id = ANY($2::text[])
         WHERE a.claim_id = $1
         ORDER BY a.embedding <=> b.embedding LIMIT 5`,
        [f.id, block.map((c) => c.id)],
      );
      for (const r of rows) {
        const other = byId.get(r.claim_id);
        if (other && r.sim >= threshold) propose(f, other, `语义相似度 ${r.sim.toFixed(2)}`, { similarity: r.sim });
      }
    }

    // A shared number lowers the cosine bar instead of replacing it: on finance's judged
    // pairs (2026-10-19), those it alone brought up gave 3 merges, suggestions or
    // contradictions in 8,527 below cosine 0.70, and 137 in 7,304 from 0.70 to 0.85.
    // A claim with no vector yet (its embedding failed) waits for one.
    const numberOnly = [...pairs.values()].filter((p) => p.similarity === 0 && !p.why.includes('identical'));
    for (let i = 0; i < numberOnly.length; i += 5000) {
      const slice = numberOnly.slice(i, i + 5000);
      const rows = await store.query<{ a: string; b: string; sim: number }>(
        `SELECT x.a, x.b, (1 - (ea.embedding <=> eb.embedding))::float AS sim
         FROM unnest($1::text[], $2::text[]) AS x(a, b)
         JOIN claim_embeddings ea ON ea.claim_id = x.a JOIN claim_embeddings eb ON eb.claim_id = x.b`,
        [slice.map((p) => p.a.id), slice.map((p) => p.b.id)],
      );
      for (const r of rows) pairs.get(claimPairId(r.a, r.b))!.cosine = r.sim;
    }
    for (const p of numberOnly) if (p.cosine < numberThreshold) pairs.delete(p.id);
  }
  stats.candidates = pairs.size;
  if (pairs.size === 0) return stats;

  /* pairs already decided: a remembered verdict, or a person's answer to a suggestion */
  // one array parameter: a nightly run brings up more pairs than a statement can bind (65,535)
  const ids = [...pairs.keys()];
  const decided = new Set([
    ...(await store.query<{ pair_id: string }>(`SELECT pair_id FROM claim_pair_verdicts WHERE pair_id = ANY($1::text[])`, [ids])).map((r) => r.pair_id),
    ...(await store.query<{ id: string }>(`SELECT id FROM suggestions WHERE id = ANY($1::text[]) AND status IN ('accepted', 'rejected')`, [ids])).map((r) => r.id),
  ]);

  const toJudge: Pair[] = [];
  const outcomes: { pair: Pair; verdict: Verdict }[] = [];
  for (const pair of pairs.values()) {
    if (decided.has(pair.id)) continue;
    const { a, b } = pair;
    if (pair.why.includes('identical')) {
      outcomes.push({ pair, verdict: { relation: 'same', keep: null, confidence: 1, reason: '规范化后逐字相同', model: 'rule' } });
      stats.identical++;
      continue;
    }
    if (windowsDisjoint(a, b) || periodsDisjoint(periodsOf(a.statement), periodsOf(b.statement))) {
      outcomes.push({ pair, verdict: { relation: 'different_time', keep: null, confidence: 1, reason: '时期不同', model: 'rule' } });
      stats.differentTime++;
      continue;
    }
    const na = numbersOf(a.statement);
    const nb = numbersOf(b.statement);
    if (na.length > 0 && nb.length > 0 && !numbersWithin(na, nb) && !numbersWithin(nb, na)) pair.guards.push('数字不一致');
    if (negated(a.statement) !== negated(b.statement)) pair.guards.push('否定不一致');
    if ((a.status === 'fact' && b.status === 'disputed') || (a.status === 'disputed' && b.status === 'fact')) pair.guards.push('状态冲突');
    toJudge.push(pair);
  }

  /* the Judge stage, in batches, most promising first: at most claimMergeMaxJudgedPerRun pairs a run (the rule-settled ones above never wait) */
  if (toJudge.length > 0 && ctx.llm?.enabled) {
    const per = Math.max(1, opts.pairsPerCall ?? 12);
    const sent = judgeOrder(toJudge).slice(0, maxJudged);
    stats.deferred = toJudge.length - sent.length;
    for (let i = 0; i < sent.length; i += per) {
      const batch = sent.slice(i, i + per);
      try {
        const verdicts = await judgeBatch(ctx.llm, batch);
        for (const [k, v] of verdicts) {
          outcomes.push({ pair: batch[k], verdict: v });
          stats.judged++;
        }
      } catch (err) {
        progress(`claims: judge failed for a batch of ${batch.length}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /* act on the verdicts; a claim merged earlier in this run answers through its representative */
  const repOf = new Map<string, string>();
  const current = (c: ClaimLite): ClaimLite => {
    let id = c.id;
    while (repOf.has(id)) id = repOf.get(id)!;
    return byId.get(id) ?? c;
  };
  for (const { pair, verdict } of outcomes) {
    await rememberVerdict(store, pair, verdict);
    const { relation, confidence } = verdict;
    if (relation === 'same' || relation === 'contains') {
      const identical = verdict.model === 'rule';
      const a = current(pair.a);
      const b = current(pair.b);
      if (a.id === b.id) continue;
      const [keep, fold] = representative({ ...pair, a, b }, verdict);
      const auto = identical || (mode === 'auto' && confidence >= minConfidence && pair.guards.length === 0);
      if (auto) {
        try {
          await applyClaimMerge(store, {
            claimId: fold.id,
            canonicalId: keep.id,
            kind: relation === 'contains' ? 'contains' : 'same_as',
            reason: identical ? '规范化后逐字相同' : `judge ${confidence.toFixed(2)}: ${verdict.reason}`,
            confidence,
            actor: identical ? 'claim-dedupe' : 'llm-judge',
          });
          repOf.set(fold.id, keep.id);
          keep.members += fold.members + 1;
          fold.members = 0;
          stats.merged++;
          continue;
        } catch (err) {
          progress(`claims: merge failed for ${fold.id}: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (confidence >= llmMin) {
        await fileMergeSuggestion(store, pair, verdict, keep, fold);
        stats.suggested++;
      }
    } else if (relation === 'conflict' && confidence >= llmMin) {
      // filed between representatives: two wordings of one side are one contradiction
      const a = current(pair.a);
      const b = current(pair.b);
      if (a.id !== b.id && (await fileConflict(store, { ...pair, a, b }, verdict))) stats.conflicts++;
    }
  }
  if (stats.merged || stats.suggested || stats.conflicts || stats.deferred) {
    progress(`claims: ${stats.merged} merged, ${stats.suggested} merge suggestions, ${stats.conflicts} contradictions (${stats.candidates} pairs, ${stats.judged} judged${stats.deferred ? `, ${stats.deferred} left for later` : ''})`);
  }
  return stats;
}

/**
 * Pairs in the order the Judge stage takes them, so that a capped run spends
 * its calls where a verdict changes something: pairs the similarity signal
 * brought up before pairs that only share a number; then pairs no guard holds
 * back (only they can merge on the verdict); then the higher similarity (the
 * higher cosine, among pairs that only share a number), the more shared key
 * numbers, the newer claim; the pair id settles the rest. Ranking finance's
 * 28,974 judged pairs (2026-10-19) this way puts 681 of the 1,628 verdicts that
 * merged, suggested or flagged anything among the first 1,200; in the order
 * they were judged there were 141. Among the 7,304 that only shared a number
 * at cosine 0.70 or more, the first 500 by cosine hold 41 of their 137 such
 * verdicts; by shared numbers and age, 14.
 */
function judgeOrder(pairs: Pair[]): Pair[] {
  const newest = new Map(pairs.map((p) => {
    const a = toIso(p.a.tx_from) ?? '';
    const b = toIso(p.b.tx_from) ?? '';
    return [p.id, a > b ? a : b];
  }));
  const text = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return [...pairs].sort((x, y) =>
    Number(y.similarity > 0) - Number(x.similarity > 0)
    || Number(x.guards.length > 0) - Number(y.guards.length > 0)
    || y.similarity - x.similarity
    || y.cosine - x.cosine
    || y.shared - x.shared
    || text(newest.get(y.id)!, newest.get(x.id)!)
    || text(x.id, y.id));
}

/** The representative of a pair: an established group keeps its own; else the judge's pick, more evidence, earlier. */
function representative(pair: Pair, verdict: Verdict): [keep: ClaimLite, fold: ClaimLite] {
  const { a, b } = pair;
  if (a.members !== b.members && (a.members > 0 || b.members > 0)) return a.members > b.members ? [a, b] : [b, a];
  if (verdict.keep === 'a') return [a, b];
  if (verdict.keep === 'b') return [b, a];
  if (a.evidence_count !== b.evidence_count) return a.evidence_count > b.evidence_count ? [a, b] : [b, a];
  const ta = toIso(a.tx_from) ?? '';
  const tb = toIso(b.tx_from) ?? '';
  return ta <= tb ? [a, b] : [b, a];
}

async function ensureClaimEmbeddings(store: Store, embedder: EmbeddingProvider, claims: ClaimLite[], progress: (msg: string) => void): Promise<number> {
  if (claims.length === 0) return 0;
  const have = new Set<string>();
  for (let i = 0; i < claims.length; i += 500) {
    const slice = claims.slice(i, i + 500);
    const ph = slice.map((_, k) => `$${k + 2}`).join(',');
    for (const r of await store.query<{ claim_id: string }>(`SELECT claim_id FROM claim_embeddings WHERE model = $1 AND claim_id IN (${ph})`, [embedder.model, ...slice.map((c) => c.id)])) {
      have.add(r.claim_id);
    }
  }
  const missing = claims.filter((c) => !have.has(c.id));
  let embedded = 0;
  for (let i = 0; i < missing.length; i += 32) {
    const batch = missing.slice(i, i + 32);
    try {
      const vecs = await embedder.embed(batch.map((c) => `${c.subject_name}：${c.statement}`.slice(0, 500)));
      for (let k = 0; k < batch.length; k++) {
        await store.query(
          `INSERT INTO claim_embeddings (claim_id, model, embedding) VALUES ($1, $2, $3::${VECTOR_TYPE})
           ON CONFLICT (claim_id) DO UPDATE SET model = EXCLUDED.model, embedding = EXCLUDED.embedding`,
          [batch[k].id, embedder.model, toVectorLiteral(vecs[k])],
        );
        embedded++;
      }
    } catch (err) {
      progress(`claims: embedding batch failed: ${err instanceof Error ? err.message : err}`);
      break;
    }
  }
  return embedded;
}

const JUDGE_SYSTEM = `You compare pairs of factual claims from a knowledge base. Both claims of a pair are about the same subject. For each pair, say how claim A relates to claim B:
- same: they assert the same facts, for the same period, with the same numbers — only the wording differs.
- contains: one asserts everything the other does and more (same period; the numbers they share agree). keep = the fuller one.
- conflict: the same fact for the same period, but the numbers or the conclusion disagree.
- different_time: the same kind of fact or measure for different periods (quarters, years, an actual result vs a forecast).
- unrelated: anything else, including partial overlaps where each states something the other does not.
Judge only from the statements, their dates and the excerpts. Figures that agree after rounding (36.19 and 36.2, 0.45% and 0.5%, 14.9% and 15%) are the same figure; figures that differ beyond rounding are never same. When unsure, answer unrelated with a low confidence.
For same, keep is the clearer and more complete claim ("a" or "b"). confidence is 0–1. reason: one sentence in the claims' language.
Respond with JSON only: {"verdicts":[{"pair":1,"relation":"same|contains|conflict|different_time|unrelated","keep":"a|b","confidence":0.0,"reason":"…"}]}`;

function describeClaim(label: string, c: ClaimLite): string {
  const when = [toDateString(c.event_at) && `event ${toDateString(c.event_at)}`, toDateString(c.valid_from) && `holds ${toDateString(c.valid_from)} ~ ${toDateString(c.valid_to) ?? ''}`]
    .filter(Boolean).join('; ');
  return [
    `${label}: "${c.statement}"`,
    `   type: ${c.type}; status: ${c.status}${when ? `; ${when}` : ''}; source: ${c.source_path ?? 'unknown'}`,
    c.excerpt ? `   excerpt: ${c.excerpt.replace(/\s+/g, ' ').slice(0, 300)}` : null,
  ].filter(Boolean).join('\n');
}

async function judgeBatch(llm: LlmClient, batch: Pair[]): Promise<Map<number, Verdict>> {
  const user = batch.map((p, i) => `Pair ${i + 1} — subject: ${p.a.subject_name}\n${describeClaim('A', p.a)}\n${describeClaim('B', p.b)}`).join('\n\n');
  const raw = await llm.completeJson<{ verdicts?: { pair?: unknown; relation?: unknown; keep?: unknown; confidence?: unknown; reason?: unknown }[] }>(
    [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: user }],
    { maxTokens: 400 + 220 * batch.length },
  );
  const out = new Map<number, Verdict>();
  const relations: ClaimRelation[] = ['same', 'contains', 'conflict', 'different_time', 'unrelated'];
  for (const v of raw.verdicts ?? []) {
    const k = Number(v.pair) - 1;
    if (!Number.isInteger(k) || k < 0 || k >= batch.length || out.has(k)) continue;
    const relation = relations.includes(v.relation as ClaimRelation) ? (v.relation as ClaimRelation) : 'unrelated';
    out.set(k, {
      relation,
      keep: v.keep === 'a' || v.keep === 'b' ? v.keep : null,
      confidence: Math.max(0, Math.min(1, Number(v.confidence) || 0)),
      reason: String(v.reason ?? '').slice(0, 400),
      model: llm.label,
    });
  }
  return out;
}

async function rememberVerdict(store: Store, pair: Pair, v: Verdict): Promise<void> {
  await store.query(
    `INSERT INTO claim_pair_verdicts (pair_id, a_id, b_id, relation, confidence, reason, model, judged_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (pair_id) DO UPDATE SET relation = EXCLUDED.relation, confidence = EXCLUDED.confidence,
       reason = EXCLUDED.reason, model = EXCLUDED.model, judged_at = EXCLUDED.judged_at`,
    [pair.id, pair.a.id, pair.b.id, v.relation, v.confidence, v.reason, v.model],
  );
}

function sourceLine(c: ClaimLite): string {
  return `${c.statement}（${c.source_path ?? '?'}${c.evidence_count > 1 ? `，${c.evidence_count} 个来源` : ''}）`;
}

async function fileMergeSuggestion(store: Store, pair: Pair, v: Verdict, keep: ClaimLite, fold: ClaimLite): Promise<void> {
  const body = [
    `- 保留：${sourceLine(keep)}`,
    `- 并入：${sourceLine(fold)}`,
    `- 判断：${v.relation === 'contains' ? '前者包含后者' : '同一事实'}（置信 ${v.confidence.toFixed(2)}，${v.model}）：${v.reason}`,
    pair.guards.length ? `- 需要人看：${pair.guards.join('、')}` : null,
    `接受后两条合为一条、来源合并计数；可撤销：knode-os claim unmerge ${fold.id}`,
  ].filter(Boolean).join('\n');
  await store.query(
    `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload)
     VALUES ($1, 'claim-merge', $2, $3, $4::jsonb, 'pending', $5::jsonb)
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, evidence = EXCLUDED.evidence, payload = EXCLUDED.payload,
       status = CASE WHEN suggestions.status = 'stale' THEN 'pending' ELSE suggestions.status END`,
    [
      pair.id,
      `合并重复断言: ${keep.subject_name}`,
      body,
      JSON.stringify([keep.statement, fold.statement]),
      JSON.stringify({ claimId: fold.id, canonicalId: keep.id, kind: v.relation === 'contains' ? 'contains' : 'same_as', confidence: v.confidence, reason: v.reason }),
    ],
  );
  await writeDeps(store, { kind: 'suggestion', id: pair.id }, [{ kind: 'claim', id: keep.id, required: true }, { kind: 'claim', id: fold.id, required: true }]);
}

/** File a "contradicting claims" suggestion; false when that pair already has one. */
async function fileConflict(store: Store, pair: Pair, v: Verdict): Promise<boolean> {
  const id = crypto.createHash('sha256').update(`claim-conflict|${claimPairId(pair.a.id, pair.b.id)}`).digest('hex').slice(0, 16);
  const body = [
    `- A：${sourceLine(pair.a)}`,
    `- B：${sourceLine(pair.b)}`,
    `- 判断：同一事实、同一时期，但说法不一致（置信 ${v.confidence.toFixed(2)}，${v.model}）：${v.reason}`,
    '建议人工核实哪条为准，或保留两条并在 wiki 里注明分歧。',
  ].join('\n');
  const inserted = await store.query<{ id: string }>(
    `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload)
     VALUES ($1, 'knowledge', $2, $3, $4::jsonb, 'pending', $5::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id`,
    [id, `矛盾的断言: ${pair.a.subject_name}`, body, JSON.stringify([pair.a.statement, pair.b.statement]), JSON.stringify({ kind: 'claim-conflict', a: pair.a.id, b: pair.b.id, verdict: v })],
  );
  if (inserted.length === 0) return false;
  await writeDeps(store, { kind: 'suggestion', id }, [{ kind: 'claim', id: pair.a.id, required: true }, { kind: 'claim', id: pair.b.id, required: true }]);
  return true;
}
