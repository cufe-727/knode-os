import { KnodeConfig } from '../config.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { LlmClient } from '../llm/client.js';
import { Store } from '../store/db.js';
import { ClaimItem, SearchResult } from '../types.js';
import { graphSearch } from '../graph/query.js';
import { EXCERPT_CHARS, excerptsForQuestion, isListQuestion } from './excerpts.js';
import { factsForQuestion, namedEntities, namedSurface, QuestionFact } from './facts.js';
import { search, SearchMode } from './search.js';

export interface AskResult {
  answer: string;
  /** What the answer cited: a retrieved chunk, or a known fact by its source (then `chunkId` is the chunk it was read from, '' when that is gone). */
  citations: { ref: number; path: string; chunkId: string }[];
  gaps: string[];
  contexts: SearchResult[];
  facts: ClaimItem[];
}

const ASK_SYSTEM = `You answer questions from a personal knowledge base. You are given retrieved context chunks, each tagged [n] — one marked "excerpt" holds only the lines of its document that name what the question asks about — and optionally a "Known facts" list: claims extracted from the whole knowledge base, each tagged [n] too, with its date and the document it comes from. The facts reach documents the chunks do not; a question that asks for every case, a list or a history is answered from both.

Rules:
- Answer in the question's language, concise but complete.
- Cite evidence inline as [n] after the claims it supports. Only cite chunks and facts you actually used.
- Known facts marked [suspected] or [disputed] are unverified — if you use one, explicitly flag the uncertainty in your answer. One marked [opinion], [prediction] or [rumor] is a view, a forecast or hearsay from the sources, not an established fact: say so when you use it.
- If the context is insufficient or contradictory, say so explicitly.
- End with a JSON line: {"citations":[n,...],"gaps":["what the knowledge base is missing to answer better", ...]} (gaps may be empty).`;

/** `[fact]` / `[suspected]` for a fact; a view, forecast or rumour is tagged by its kind, with the status when hedged. */
export function claimTag(c: { status: string; kind?: string | null }): string {
  const kind = c.kind ?? 'fact';
  if (kind === 'fact') return c.status;
  return c.status === 'fact' ? kind : `${kind}, ${c.status}`;
}

/** The facts as the prompt lists them: numbered on from the chunks, each with its tag, date and source. */
function renderFacts(facts: ClaimItem[], firstRef: number): string {
  if (facts.length === 0) return '';
  const lines = facts.map((f, i) => {
    const period = f.startDate || f.endDate ? ` (${f.startDate ?? '?'} ~ ${f.endDate ?? ''})` : '';
    const when = f.eventDate ? ` (${f.eventDate})` : period;
    return `[${firstRef + i}] [${claimTag(f)}] ${f.statement}${when}${f.path ? ` — ${f.path}` : ''}`;
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
  opts: { k?: number; mode?: SearchMode; /** The question's embedding, when the caller has it already. */ queryVector?: number[]; /** Known facts listed at most (default 24). */ facts?: number; /** Characters of excerpts for a list question at most (default `EXCERPT_CHARS`; 0 for none). */ excerpts?: number } = {},
): Promise<AskResult> {
  const k = opts.k ?? 8;
  const mode = opts.mode ?? 'hybrid';
  // embedded once, for the search and for ranking the facts; a provider that cannot serve it leaves both to their other signals
  let queryVector = opts.queryVector;
  if (!queryVector && mode !== 'keyword') {
    try {
      queryVector = (await embedder.embed([question]))[0];
    } catch {
      queryVector = undefined;
    }
  }
  const [retrieved, graph, named] = await Promise.all([
    search(store, embedder, question, { k, mode, heat: config.heat, sag: config.retrieval.sag, queryVector }),
    graphSearch(store, question, { depth: 2, chunkLimit: 4, heat: config.heat }),
    namedEntities(store, question),
  ]);
  const seen = new Set(retrieved.map((r) => r.chunkId));
  const found = [...retrieved, ...graph.chunks.filter((c) => !seen.has(c.chunkId))].slice(0, k + 4);
  // a question asking for every case is answered from many documents: more kinds of fact, and the lines of
  // further documents that name what it asks about
  const list = isListQuestion(question);
  const excerptBudget = list ? (opts.excerpts ?? EXCERPT_CHARS) : 0;
  const [facts, excerpts]: [QuestionFact[], SearchResult[]] = await Promise.all([
    factsForQuestion(store, question, found, { limit: opts.facts, queryVector, model: embedder.model, named, list }),
    excerptBudget > 0
      ? namedSurface(store, named).then((s) => excerptsForQuestion(store, question, found, { budget: excerptBudget, names: s.names, namedDocs: s.docs }))
      : Promise.resolve([]),
  ]);
  const contexts = [...found, ...excerpts];
  // what a reference number stands for: the chunks first, then the facts
  const refs = [
    ...contexts.map((c) => ({ path: c.path, chunkId: c.chunkId })),
    ...facts.map((f) => ({ path: f.path ?? '', chunkId: f.chunkId ?? '' })),
  ];

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
    .map((c, i) => `[${i + 1}] (${c.path}${c.excerpt ? ', excerpt' : ''})\n${c.content.slice(0, 1500)}`)
    .join('\n\n');
  const raw = await llm.complete([
    { role: 'system', content: ASK_SYSTEM },
    { role: 'user', content: `# Context\n${contextBlock}${renderFacts(facts, contexts.length + 1)}\n\n# Question\n${question}` },
  ], { maxTokens: 1500 });

  let answer = raw.trim();
  let gaps: string[] = [];
  let cited: number[] = [];
  const jsonMatch = answer.match(/\{["']citations["'][\s\S]*\}\s*$/);
  if (jsonMatch) {
    try {
      const meta = JSON.parse(jsonMatch[0]) as { citations?: number[]; gaps?: string[] };
      cited = (meta.citations ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= refs.length);
      gaps = (meta.gaps ?? []).map(String).slice(0, 5);
      answer = answer.slice(0, jsonMatch.index).trim();
    } catch {
      /* keep raw answer */
    }
  }
  if (cited.length === 0) {
    cited = [...new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))].filter((n) => n >= 1 && n <= refs.length);
  }
  return {
    answer,
    // a fact whose source is no longer known has nothing to cite
    citations: cited.filter((n) => refs[n - 1].path).map((n) => ({ ref: n, ...refs[n - 1] })),
    gaps,
    contexts,
    facts,
  };
}
