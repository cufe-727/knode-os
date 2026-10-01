import { KnodeConfig } from '../config.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { LlmClient } from '../llm/client.js';
import { Store } from '../store/db.js';
import { toDateString } from '../store/temporal.js';
import { ClaimItem, SearchResult } from '../types.js';
import { graphSearch } from '../graph/query.js';
import { search, SearchMode } from './search.js';

export interface AskResult {
  answer: string;
  citations: { ref: number; path: string; chunkId: string }[];
  gaps: string[];
  contexts: SearchResult[];
  facts: ClaimItem[];
}

const ASK_SYSTEM = `You answer questions from a personal knowledge base. You are given retrieved context chunks, each tagged [n], and optionally a "Known facts" list of extracted claims.

Rules:
- Answer in the question's language, concise but complete.
- Cite evidence inline as [n] after the claims it supports. Only cite chunks you actually used.
- Known facts marked [suspected] or [disputed] are unverified — if you use one, explicitly flag the uncertainty in your answer.
- If the context is insufficient or contradictory, say so explicitly.
- End with a JSON line: {"citations":[n,...],"gaps":["what the knowledge base is missing to answer better", ...]} (gaps may be empty).`;

/** Claims about entities mentioned in the retrieved chunks — structured evidence for the answer. */
async function factsForContexts(store: Store, chunkIds: string[], limit = 8): Promise<ClaimItem[]> {
  if (chunkIds.length === 0) return [];
  const ph = chunkIds.map((_, i) => `$${i + 1}`).join(',');
  const rows = await store.query<{
    id: string; subject: string; object: string | null; type: string; statement: string;
    status: string; valid_from: string | null; valid_to: string | null; path: string | null; evidence_count: number;
  }>(
    `SELECT DISTINCT cl.id, se.name AS subject, oe.name AS object, cl.type, cl.statement,
            cl.status, cl.valid_from, cl.valid_to, s.key AS path, cl.evidence_count
     FROM entity_mentions m
     JOIN claims cl ON cl.subject_id = m.entity_id AND cl.tx_to IS NULL
     JOIN entities se ON se.id = cl.subject_id AND se.tx_to IS NULL
     LEFT JOIN entities oe ON oe.id = cl.object_id
     LEFT JOIN scopes s ON s.id = cl.primary_scope_id
     WHERE m.chunk_id IN (${ph})
     LIMIT $${chunkIds.length + 1}`,
    [...chunkIds, limit],
  );
  return rows.map((r) => ({
    id: r.id, subject: r.subject, object: r.object, type: r.type, statement: r.statement,
    status: r.status, startDate: toDateString(r.valid_from), endDate: toDateString(r.valid_to), path: r.path,
    evidenceCount: r.evidence_count,
  }));
}

function renderFacts(facts: ClaimItem[]): string {
  if (facts.length === 0) return '';
  const lines = facts.map((f) => {
    const period = f.startDate || f.endDate ? ` (${f.startDate ?? '?'} ~ ${f.endDate ?? ''})` : '';
    return `- [${f.status}] ${f.statement}${period}`;
  });
  return `\n\n# Known facts\n${lines.join('\n')}`;
}

/**
 * RAG answer with citations and explicit gap analysis (gbrain's `think`):
 * selectable retrieval (hybrid by default, SAG opt-in) + graph expansion →
 * budgeted context → cited synthesis.
 */
export async function ask(
  store: Store,
  config: KnodeConfig,
  embedder: EmbeddingProvider,
  llm: LlmClient,
  question: string,
  opts: { k?: number; mode?: SearchMode } = {},
): Promise<AskResult> {
  const k = opts.k ?? 8;
  const mode = opts.mode ?? 'hybrid';
  const [retrieved, graph] = await Promise.all([
    search(store, embedder, question, { k, mode, heat: config.heat, sag: config.retrieval.sag }),
    graphSearch(store, question, { depth: 2, chunkLimit: 4, heat: config.heat }),
  ]);
  const seen = new Set(retrieved.map((r) => r.chunkId));
  const contexts = [...retrieved, ...graph.chunks.filter((c) => !seen.has(c.chunkId))].slice(0, k + 4);
  const facts = await factsForContexts(store, contexts.map((c) => c.chunkId));

  if (!llm.enabled) {
    return {
      answer: 'The Judge stage has no model (Settings → Ingest, or extraction.judgeLlm in knode.config.json) — returning retrieved context only.',
      citations: contexts.map((c, i) => ({ ref: i + 1, path: c.path, chunkId: c.chunkId })),
      gaps: [],
      contexts,
      facts,
    };
  }

  const contextBlock = contexts
    .map((c, i) => `[${i + 1}] (${c.path})\n${c.content.slice(0, 1500)}`)
    .join('\n\n');
  const raw = await llm.complete([
    { role: 'system', content: ASK_SYSTEM },
    { role: 'user', content: `# Context\n${contextBlock}${renderFacts(facts)}\n\n# Question\n${question}` },
  ], { maxTokens: 1500 });

  let answer = raw.trim();
  let gaps: string[] = [];
  let cited: number[] = [];
  const jsonMatch = answer.match(/\{["']citations["'][\s\S]*\}\s*$/);
  if (jsonMatch) {
    try {
      const meta = JSON.parse(jsonMatch[0]) as { citations?: number[]; gaps?: string[] };
      cited = (meta.citations ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= contexts.length);
      gaps = (meta.gaps ?? []).map(String).slice(0, 5);
      answer = answer.slice(0, jsonMatch.index).trim();
    } catch {
      /* keep raw answer */
    }
  }
  if (cited.length === 0) {
    cited = [...new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))].filter((n) => n >= 1 && n <= contexts.length);
  }
  return {
    answer,
    citations: cited.map((n) => ({ ref: n, path: contexts[n - 1].path, chunkId: contexts[n - 1].chunkId })),
    gaps,
    contexts,
    facts,
  };
}
