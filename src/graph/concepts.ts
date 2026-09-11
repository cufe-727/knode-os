import { ScopeWriter } from '../lineage/writer.js';

/**
 * Tier-0 concept extraction (LazyGraphRAG-style): zero-LLM keyword / noun-
 * phrase mining that gives every document a baseline concept co-occurrence
 * graph the moment it is ingested. Quality is deliberately modest — the point
 * is 100% coverage at zero cost; tier-1 LLM extraction upgrades hot documents
 * later.
 */

const MAX_CONCEPTS_PER_DOC = 8;

const EN_STOP = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were', 'has', 'have', 'had',
  'not', 'but', 'all', 'any', 'can', 'will', 'would', 'should', 'could', 'into', 'over', 'under',
  'about', 'after', 'before', 'between', 'they', 'them', 'their', 'there', 'here', 'when', 'what',
  'which', 'while', 'these', 'those', 'then', 'than', 'also', 'each', 'other', 'more', 'most',
  'some', 'such', 'only', 'very', 'just', 'been', 'being', 'does', 'doing', 'how', 'why', 'where',
  'note', 'notes', 'todo', 'https', 'http', 'www', 'com', 'org',
]);

const CJK_STOP = new Set([
  '我们', '你们', '他们', '这个', '那个', '这些', '那些', '因为', '所以', '但是', '如果', '虽然',
  '而且', '或者', '以及', '通过', '对于', '关于', '可以', '需要', '使用', '进行', '一个', '一些',
  '没有', '就是', '也是', '都是', '不是', '还是', '已经', '现在', '时候', '什么', '怎么', '为了',
  '其中', '之后', '之前', '以上', '以下', '如下', '例如', '比如', '包括', '主要', '同时', '然后',
]);

/** Extract candidate concept terms from document text. Deterministic, no LLM. */
export function extractConcepts(text: string): string[] {
  const freq = new Map<string, number>();
  const bump = (term: string, n = 1) => freq.set(term, (freq.get(term) ?? 0) + n);

  // strip code blocks/urls — they produce junk terms
  const body = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');

  // 1. Latin proper-noun phrases: runs of Capitalized words ("Knowledge Graph")
  for (const m of body.matchAll(/\b([A-Z][a-zA-Z0-9]+(?:[ -][A-Z][a-zA-Z0-9]+){0,3})\b/g)) {
    const term = m[1].trim();
    const lc = term.toLowerCase();
    if (term.length < 3 || EN_STOP.has(lc)) continue;
    bump(term);
  }
  // 2. Acronyms and code-ish identifiers in backticks
  for (const m of body.matchAll(/\b([A-Z]{2,8})\b/g)) {
    if (m[1].length >= 2 && !EN_STOP.has(m[1].toLowerCase())) bump(m[1]);
  }
  for (const m of body.matchAll(/`([a-zA-Z][\w./-]{2,40})`/g)) {
    bump(m[1]);
  }

  // 3. CJK terms: sliding-window substrings (length 2–4) over CJK runs,
  //    frequency-thresholded, longest-match preferred
  const cjkFreq = new Map<string, number>();
  for (const run of body.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g)) {
    const s = run[0];
    for (let len = 2; len <= 4; len++) {
      for (let i = 0; i + len <= s.length; i++) {
        const sub = s.slice(i, i + len);
        if (CJK_STOP.has(sub)) continue;
        cjkFreq.set(sub, (cjkFreq.get(sub) ?? 0) + 1);
      }
    }
  }
  const cjkTerms = [...cjkFreq.entries()]
    .filter(([, n]) => n >= 4)
    .sort((a, b) => b[1] * b[0].length - a[1] * a[0].length);
  const chosen: string[] = [];
  for (const [term, n] of cjkTerms) {
    if (chosen.length >= MAX_CONCEPTS_PER_DOC) break;
    // skip substrings of an already-chosen longer term
    if (chosen.some((c) => c.includes(term))) continue;
    chosen.push(term);
    bump(term, n);
  }

  return [...freq.entries()]
    .filter(([term, n]) => n >= 2 || term.length >= 6)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CONCEPTS_PER_DOC)
    .map(([term]) => term);
}

interface PageContext {
  documentId: string;
  chunkIds: { id: string; content: string }[];
}

/** Persist tier-0 concepts as evidence: concept entities, chunk mentions, weak co_occurs edges. */
export async function wireConcepts(w: ScopeWriter, page: PageContext, concepts: string[]): Promise<{ entities: number; relations: number }> {
  const ids: string[] = [];
  for (const term of concepts) {
    const needle = term.toLowerCase();
    const hits = page.chunkIds.filter((c) => c.content.toLowerCase().includes(needle));
    const id = await w.entity({ name: term, type: 'concept' }, { extractor: 'tier0.concept', segmentId: hits[0]?.id ?? page.chunkIds[0]?.id ?? null });
    ids.push(id);
    for (const h of hits.slice(0, 4)) await w.mention(id, h.id, page.documentId);
    if (hits.length === 0 && page.chunkIds[0]) await w.mention(id, page.chunkIds[0].id, page.documentId);
  }
  const unique = [...new Set(ids)];
  const relations = await w.coOccurrence(unique, { weight: 0.1, window: 6, extractor: 'tier0.concept' });
  return { entities: unique.length, relations };
}
