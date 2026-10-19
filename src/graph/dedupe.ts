import crypto from 'node:crypto';
import { KnodeConfig } from '../config.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { writeDeps } from '../lineage/deps.js';
import { LlmClient } from '../llm/client.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { setSuggestionStatus } from '../store/queries.js';
import { applyMerge } from './merge.js';
import { typesCompatible } from './normalize.js';

/**
 * Duplicate-entity audit. Finds pairs that probably name the same thing and
 * files them as `merge` suggestions for a person to accept — the write-time
 * resolver only merges on exact key equality; everything fuzzier ends here.
 *
 * It runs twice over: right after every tier-1 pass with `focus` set to the
 * entities that pass wrote, so a duplicate surfaces minutes after its document
 * arrives, and nightly over every pair as the backstop (docs/design/09). A
 * merge is a reversible link either way, which is why it may run that early
 * while write-time resolution stays exact.
 *
 * Signals, strongest first:
 *   1. same bare name key (corporate suffix stripped) — 0.98
 *   2. a shared alias / name key (e.g. both carry the ticker)  — 0.95
 *   3. short name is a prefix of a longer name of the same declared type
 *      (宁德时代 / 宁德时代新能源科技, Tesla / Tesla Motors) — 0.85
 *   4. embedding similarity of "name (type): description" ≥ threshold — the
 *      cosine itself; vectors are cached in entity_embeddings by fold_sha so
 *      an entity is only re-embedded when its folded row changed. Skipped for
 *      the local hashing embedder, whose distances mean nothing.
 *
 * Pairs already linked, or rejected once, are never proposed again.
 */

export interface DedupeOptions {
  onProgress?: (msg: string) => void;
  /** Cosine similarity floor for the embedding signal. */
  threshold?: number;
  /** Most-mentioned entities considered for the embedding pass. */
  maxEmbedded?: number;
  maxSuggestions?: number;
  /**
   * Only score pairs with at least one entity in this set — the entities a
   * tier-1 pass just wrote. Absent = every pair (the nightly audit). The
   * embedding signal then embeds just these and looks for their neighbours
   * among the vectors already cached.
   */
  focus?: string[];
}

export interface DedupeStats {
  candidates: number;
  suggested: number;
  embedded: number;
  /** Candidates the LLM judge looked at (review.llmJudge). */
  judged: number;
  /** Judged "different" with enough confidence: recorded as rejected, never re-proposed. */
  llmRejected: number;
  /** Merged without a person (review.llmJudge = auto). */
  autoMerged: number;
}

export interface MergeVerdict {
  same: boolean;
  confidence: number;
  reason: string;
  model: string;
}

interface EntityLite {
  id: string;
  name: string;
  type: string;
  description: string;
  aliases: string[];
  name_key: string | null;
  mention_count: number;
  evidence_count: number;
  fold_sha: string;
}

interface Candidate {
  a: EntityLite;
  b: EntityLite;
  score: number;
  reason: string;
}

export function mergeSuggestionId(a: string, b: string): string {
  const [x, y] = [a, b].sort();
  return crypto.createHash('sha256').update(`merge|${x}|${y}`).digest('hex').slice(0, 16);
}

function survivor(a: EntityLite, b: EntityLite): [keep: EntityLite, fold: EntityLite] {
  const score = (e: EntityLite) => e.mention_count * 10 + e.evidence_count + (e.type !== 'concept' ? 5 : 0);
  return score(a) >= score(b) ? [a, b] : [b, a];
}

export async function auditDuplicateEntities(
  ctx: { store: Store; embedder: EmbeddingProvider; config: KnodeConfig; llm?: LlmClient },
  opts: DedupeOptions = {},
): Promise<DedupeStats> {
  const { store } = ctx;
  const progress = opts.onProgress ?? (() => {});
  const threshold = opts.threshold ?? 0.92;
  const stats: DedupeStats = { candidates: 0, suggested: 0, embedded: 0, judged: 0, llmRejected: 0, autoMerged: 0 };

  const entities = await store.query<EntityLite>(
    `SELECT id, name, type, description, aliases, name_key, mention_count, evidence_count, fold_sha
     FROM entities WHERE tx_to IS NULL AND canonical_id IS NULL`,
  );
  const byId = new Map(entities.map((e) => [e.id, e]));
  const focus = opts.focus ? new Set(opts.focus.filter((id) => byId.has(id))) : null;
  if (focus && focus.size === 0) return stats;
  const inFocus = (a: EntityLite, b: EntityLite) => !focus || focus.has(a.id) || focus.has(b.id);
  const candidates = new Map<string, Candidate>();
  const propose = (a: EntityLite, b: EntityLite, score: number, reason: string) => {
    if (a.id === b.id || !typesCompatible(a.type, b.type) || !inFocus(a, b)) return;
    const id = mergeSuggestionId(a.id, b.id);
    const prev = candidates.get(id);
    if (!prev || prev.score < score) candidates.set(id, { a, b, score, reason });
  };

  // 1. same bare key
  const byBare = new Map<string, EntityLite[]>();
  for (const e of entities) {
    if (!e.name_key || e.name_key.length < 2) continue;
    (byBare.get(e.name_key) ?? byBare.set(e.name_key, []).get(e.name_key)!).push(e);
  }
  for (const group of byBare.values()) {
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) propose(group[i], group[j], 0.98, `同一规范化名称 "${group[i].name_key}"`);
  }

  // 2. shared keys: an identical spelling (0.95) or the same name once corporate suffixes are stripped (0.9)
  const shared = await store.query<{ a: string; b: string; alias_key: string; kinds: string }>(
    `SELECT ka.entity_id AS a, kb.entity_id AS b, ka.alias_key, ka.kind || '/' || kb.kind AS kinds
     FROM entity_alias_keys ka
     JOIN entity_alias_keys kb ON kb.alias_key = ka.alias_key AND kb.entity_id > ka.entity_id
     JOIN entities ea ON ea.id = ka.entity_id AND ea.tx_to IS NULL AND ea.canonical_id IS NULL
     JOIN entities eb ON eb.id = kb.entity_id AND eb.tx_to IS NULL AND eb.canonical_id IS NULL
     WHERE length(ka.alias_key) >= 2`,
  );
  for (const r of shared) {
    const a = byId.get(r.a), b = byId.get(r.b);
    if (!a || !b) continue;
    if (r.kinds === 'exact/exact') propose(a, b, 0.95, `共享别名/名称 "${r.alias_key}"`);
    else propose(a, b, 0.9, `去掉公司后缀后同名 "${r.alias_key}"`);
  }

  // 3. short name is a prefix of a longer one, same declared (non-placeholder) type
  const typed = entities.filter((e) => e.name_key && e.type !== 'concept' && e.type !== 'other');
  const isCjk = (s: string) => /[\u3400-\u9fff]/.test(s);
  const prefix = (short: EntityLite, long: EntityLite) => {
    const k = short.name_key!;
    if (k.length < (isCjk(k) ? 2 : 4)) return;
    if (long.id === short.id || long.type !== short.type) return;
    const lk = long.name_key!;
    if (lk.length <= k.length || lk.length - k.length > 12 || !lk.startsWith(k)) return;
    propose(short, long, 0.85, `"${short.name}" 是 "${long.name}" 的前缀（同为 ${short.type}）`);
  };
  if (focus) {
    // each focus entity against every other, in both roles — not every pair
    for (const f of typed.filter((e) => focus.has(e.id))) {
      for (const other of typed) {
        prefix(f, other);
        prefix(other, f);
      }
    }
  } else {
    for (const short of typed) for (const long of typed) prefix(short, long);
  }

  // 4. embedding similarity (real embedders only)
  if (ctx.config.embedding.provider !== 'local' && ctx.embedder.model !== 'local-hash-v1') {
    const pool = entities
      .filter((e) => (!focus || focus.has(e.id)) && (e.type !== 'concept' || e.mention_count >= 3))
      .sort((a, b) => b.mention_count - a.mention_count)
      .slice(0, opts.maxEmbedded ?? 600);
    const ids = pool.map((e) => e.id);
    const have = new Map<string, string>();
    if (ids.length > 0) {
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      for (const r of await store.query<{ entity_id: string; fold_sha: string }>(`SELECT entity_id, fold_sha FROM entity_embeddings WHERE entity_id IN (${ph})`, ids)) {
        have.set(r.entity_id, r.fold_sha);
      }
    }
    const stale = pool.filter((e) => have.get(e.id) !== e.fold_sha);
    for (let i = 0; i < stale.length; i += 32) {
      const batch = stale.slice(i, i + 32);
      try {
        const vecs = await ctx.embedder.embed(batch.map((e) => `${e.name} (${e.type})${e.aliases?.length ? ` [${e.aliases.join(', ')}]` : ''}: ${e.description || ''}`.slice(0, 500)));
        for (let k = 0; k < batch.length; k++) {
          await store.query(
            `INSERT INTO entity_embeddings (entity_id, fold_sha, model, embedding) VALUES ($1, $2, $3, $4::${VECTOR_TYPE})
             ON CONFLICT (entity_id) DO UPDATE SET fold_sha = EXCLUDED.fold_sha, model = EXCLUDED.model, embedding = EXCLUDED.embedding`,
            [batch[k].id, batch[k].fold_sha, ctx.embedder.model, toVectorLiteral(vecs[k])],
          );
          stats.embedded++;
        }
      } catch (err) {
        progress(`dedupe: embedding batch failed: ${err instanceof Error ? err.message : err}`);
        break;
      }
    }
    for (const e of pool.slice(0, 300)) {
      const rows = await store.query<{ entity_id: string; sim: number }>(
        `SELECT b.entity_id, (1 - (a.embedding <=> b.embedding))::float AS sim
         FROM entity_embeddings a JOIN entity_embeddings b ON b.entity_id <> a.entity_id
         JOIN entities eb ON eb.id = b.entity_id AND eb.tx_to IS NULL AND eb.canonical_id IS NULL
         WHERE a.entity_id = $1
         ORDER BY a.embedding <=> b.embedding LIMIT 3`,
        [e.id],
      );
      for (const r of rows) {
        const other = byId.get(r.entity_id);
        if (other && r.sim >= threshold) propose(e, other, Number(r.sim.toFixed(3)), `语义相似度 ${r.sim.toFixed(2)}`);
      }
    }
  }

  stats.candidates = candidates.size;
  if (candidates.size === 0) return stats;

  // never re-propose a pair a person already rejected, or one already linked;
  // one array parameter, since a nightly run scores more pairs than a statement can bind
  const ids = [...candidates.keys()];
  const decided = new Set(
    (await store.query<{ id: string }>(`SELECT id FROM suggestions WHERE id = ANY($1::text[]) AND status IN ('rejected', 'accepted')`, [ids])).map((r) => r.id),
  );
  const ranked = [...candidates.entries()].filter(([id]) => !decided.has(id)).sort((x, y) => y[1].score - x[1].score).slice(0, opts.maxSuggestions ?? 50);

  // 3b. the LLM judge (review.llmJudge): a second opinion with the grounding text in front of it
  const review = ctx.config.review;
  const judgeMode = review?.llmJudge ?? 'off';
  const verdicts = new Map<string, MergeVerdict>();
  if (judgeMode !== 'off' && ctx.llm?.enabled) {
    for (const [id, c] of ranked.slice(0, review?.maxJudgedPerRun ?? 30)) {
      const prompt = await judgePrompt(store, c.a, c.b);
      try {
        const raw = await ctx.llm.completeJson<{ same?: unknown; confidence?: unknown; reason?: unknown }>(
          [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }], { maxTokens: 300 },
        );
        verdicts.set(id, { same: raw.same === true, confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)), reason: String(raw.reason ?? '').slice(0, 600), model: ctx.llm.label });
        stats.judged++;
      } catch (err) {
        progress(`dedupe: judge failed for ${c.a.name} / ${c.b.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  for (const [id, c] of ranked) {
    const [keep, fold] = survivor(c.a, c.b);
    const verdict = verdicts.get(id);
    const title = `合并重复实体: ${fold.name} → ${keep.name}`;
    const body = [
      `"${fold.name}"（${fold.type}，${fold.mention_count} 次提及）看起来与 "${keep.name}"（${keep.type}，${keep.mention_count} 次提及）是同一实体。`,
      `依据：${c.reason}。`,
      verdict ? `LLM 判定：${verdict.same ? '相同' : '不同'}（置信 ${verdict.confidence.toFixed(2)}，${verdict.model}）：${verdict.reason}` : null,
      `接受后 "${fold.name}" 会指向 "${keep.name}"（可撤销：knode-os entities unmerge ${fold.id}）；两者的别名、断言与关系在读取时合并显示，证据本身不改写。`,
    ].filter(Boolean).join('\n');
    await store.query(
      `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload)
       VALUES ($1, 'merge', $2, $3, $4::jsonb, 'pending', $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, evidence = EXCLUDED.evidence, payload = EXCLUDED.payload,
         status = CASE WHEN suggestions.status = 'stale' THEN 'pending' ELSE suggestions.status END`,
      [id, title, body, JSON.stringify([`${fold.name} ↔ ${keep.name}`, c.reason]), JSON.stringify({ entityId: fold.id, canonicalId: keep.id, score: c.score, reason: c.reason, llm: verdict ?? null })],
    );
    await writeDeps(store, { kind: 'suggestion', id }, [
      { kind: 'entity', id: keep.id, required: true },
      { kind: 'entity', id: fold.id, required: true },
    ]);
    if (verdict && !verdict.same && verdict.confidence >= (review?.llmMinConfidence ?? 0.6)) {
      // remembered as a decision so the pair is never proposed again; a person can still merge by hand
      await setSuggestionStatus(store, id, 'rejected', 'llm-judge');
      stats.llmRejected++;
      continue;
    }
    if (verdict && verdict.same && judgeMode === 'auto' && verdict.confidence >= (review?.autoMergeMinConfidence ?? 0.95)) {
      try {
        await applyMerge(store, { entityId: fold.id, canonicalId: keep.id, reason: `llm-judge ${verdict.confidence.toFixed(2)}: ${verdict.reason}`, actor: 'llm-judge' });
        await setSuggestionStatus(store, id, 'accepted', 'llm-judge');
        stats.autoMerged++;
        continue;
      } catch (err) {
        progress(`dedupe: auto-merge failed for ${fold.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
    stats.suggested++;
  }
  if (stats.suggested > 0 || stats.autoMerged > 0 || stats.llmRejected > 0) {
    progress(`dedupe: ${stats.suggested} merge candidates queued as suggestions (${stats.candidates} pairs scored${stats.judged ? `, ${stats.judged} judged by LLM` : ''}${stats.autoMerged ? `, ${stats.autoMerged} merged automatically` : ''}${stats.llmRejected ? `, ${stats.llmRejected} rejected by the judge` : ''})`);
  }
  return stats;
}

async function excerptsFor(store: Store, entityId: string, n = 2): Promise<string[]> {
  const rows = await store.query<{ content: string }>(
    `SELECT DISTINCT c.content FROM entity_mentions m JOIN chunks c ON c.id = m.chunk_id WHERE m.entity_id = $1 LIMIT $2`,
    [entityId, n],
  );
  return rows.map((r) => r.content.replace(/\s+/g, ' ').slice(0, 400));
}

async function judgePrompt(store: Store, a: EntityLite, b: EntityLite): Promise<{ system: string; user: string }> {
  const system = `You decide whether two entities in a knowledge graph denote the same real-world thing (the same company, person, product …), not merely related things. A parent company and its subsidiary, a company and its product, a fund and its manager are DIFFERENT. Judge from names, aliases, descriptions and the text excerpts. Respond with JSON only: {"same": true|false, "confidence": 0.0-1.0, "reason": "one or two sentences in the language of the names"}`;
  const describe = async (label: string, e: EntityLite) => [
    `${label}: ${e.name} (${e.type})`,
    e.aliases?.length ? `  aliases: ${e.aliases.join(', ')}` : null,
    e.description ? `  description: ${e.description.slice(0, 300)}` : null,
    ...(await excerptsFor(store, e.id)).map((x) => `  excerpt: ${x}`),
  ].filter(Boolean).join('\n');
  return { system, user: `${await describe('Entity A', a)}\n\n${await describe('Entity B', b)}` };
}

/** File one merge candidate found outside the audit (a verify page's sameAs), or record a notSameAs decision. */
export async function fileMergeCandidate(
  store: Store,
  a: { id: string; name: string; type: string; mention_count: number; evidence_count: number },
  b: { id: string; name: string; type: string; mention_count: number; evidence_count: number },
  reason: string,
  opts: { evidencePath?: string; decision?: 'pending' | 'rejected'; actor?: string } = {},
): Promise<string> {
  const id = mergeSuggestionId(a.id, b.id);
  const [keep, fold] = survivor({ ...a, description: '', aliases: [], name_key: null, fold_sha: '' }, { ...b, description: '', aliases: [], name_key: null, fold_sha: '' });
  const [existing] = await store.query<{ status: string }>(`SELECT status FROM suggestions WHERE id = $1`, [id]);
  if (existing && existing.status === 'accepted') return id;
  await store.query(
    `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload)
     VALUES ($1, 'merge', $2, $3, $4::jsonb, 'pending', $5::jsonb)
     ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, evidence = EXCLUDED.evidence, payload = EXCLUDED.payload,
       status = CASE WHEN suggestions.status IN ('stale', 'rejected') THEN 'pending' ELSE suggestions.status END`,
    [id, `合并重复实体: ${fold.name} → ${keep.name}`, `${reason}${opts.evidencePath ? `（见 ${opts.evidencePath}）` : ''}`, JSON.stringify([reason, opts.evidencePath].filter(Boolean)), JSON.stringify({ entityId: fold.id, canonicalId: keep.id, score: 0.9, reason, evidencePath: opts.evidencePath ?? null })],
  );
  await writeDeps(store, { kind: 'suggestion', id }, [{ kind: 'entity', id: keep.id, required: true }, { kind: 'entity', id: fold.id, required: true }]);
  if (opts.decision === 'rejected') await setSuggestionStatus(store, id, 'rejected', opts.actor ?? 'verify');
  return id;
}
