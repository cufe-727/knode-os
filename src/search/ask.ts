import { defaultAskRouterConfig, KnodeConfig } from '../config.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { LlmClient } from '../llm/client.js';
import { Store } from '../store/db.js';
import { ClaimItem, SearchResult } from '../types.js';
import { graphSearch } from '../graph/query.js';
import { EXCERPT_CHARS, excerptsForQuestion, isListQuestion } from './excerpts.js';
import { factsForQuestion, namedEntities, namedSurface, QuestionFact } from './facts.js';
import { search, SearchMode } from './search.js';
import { EnumeratedClaim, Enumeration, enumerateClaims, typesInQuestion } from './enumerate.js';
import { QuestionKind, QuestionRoute, questionRange, routeQuestion } from './route.js';
import { stepsAsFacts, walkRelations } from './walk.js';

/** Characters of a retrieved passage the answering model is shown. */
export const ASK_CONTEXT_CHARS = 1500;

export interface AskResult {
  answer: string;
  /** What the answer cited: a retrieved chunk, or a known fact by its source (then `chunkId` is the chunk it was read from, '' when that is gone). */
  citations: { ref: number; path: string; chunkId: string }[];
  gaps: string[];
  contexts: SearchResult[];
  facts: ClaimItem[];
  /** How the question was routed and what each route did (docs/design/30). */
  route: AskRoute;
}

export interface AskRoute {
  kind: QuestionKind;
  /** Which rule, the model, or the caller decided; `fallback:…` when a route found nothing and the lookup path answered. */
  by: string;
  range: QuestionRoute['range'];
  /** For list, aggregate and timeline: what the enumeration matched and listed. */
  enumerated?: { matched: number; listed: number; documents: number; capped: boolean; types: string[]; entities: number };
  /** For multi-hop: the relations walked and the entities reached. */
  walked?: { hops: number; relations: number; reached: number; bridges: number };
}

const ASK_SYSTEM = `You answer questions from a personal knowledge base. You are given retrieved context chunks, each tagged [n] — one marked "excerpt" holds only the lines of its document that name what the question asks about — and optionally a "Known facts" list: claims extracted from the whole knowledge base, each tagged [n] too, with its date and the document it comes from. The facts reach documents the chunks do not; a question that asks for every case, a list or a history is answered from both.

Rules:
- Answer in the question's language, concise but complete.
- Cite evidence inline as [n] after the claims it supports. Only cite chunks and facts you actually used.
- Known facts marked [suspected] or [disputed] are unverified — if you use one, explicitly flag the uncertainty in your answer. One marked [opinion], [prediction] or [rumor] is a view, a forecast or hearsay from the sources, not an established fact: say so when you use it.
- If the context is insufficient or contradictory, say so explicitly.
- End with a JSON line: {"citations":[n,...],"gaps":["what the knowledge base is missing to answer better", ...]} (gaps may be empty).`;

/** The rule an enumerated answer adds: the facts are the whole match, and the counts are over it. */
const ENUMERATED_RULE = `
- Known facts marked "enumerated" are every claim the knowledge base holds about what the question names (in the period it names): answer a list with every relevant item, merging the same item stated by several sources; count distinct items or events, not lines; the "Counts" section is computed over all matching claims, including any not listed. A fact marked "replaced later" was true until a newer fact replaced it: use it for history, not as the current state.`;

/** `[fact]` / `[suspected]` for a fact; a view, forecast or rumour is tagged by its kind, with the status when hedged. */
export function claimTag(c: { status: string; kind?: string | null }): string {
  const kind = c.kind ?? 'fact';
  if (kind === 'fact') return c.status;
  return c.status === 'fact' ? kind : `${kind}, ${c.status}`;
}

/** A fact as the prompt may list it: a claim, an enumerated claim, or a relation walked. */
type PromptFact = ClaimItem & { chunkId?: string | null; superseded?: boolean; sources?: string[]; date?: string | null };

/** The facts as the prompt lists them: numbered on from the chunks, each with its tag, date and source. */
function renderFacts(facts: PromptFact[], firstRef: number, heading = 'Known facts'): string {
  if (facts.length === 0) return '';
  const lines = facts.map((f, i) => {
    const period = f.startDate || f.endDate ? ` (${f.startDate ?? '?'} ~ ${f.endDate ?? ''})` : '';
    const when = f.eventDate ? ` (${f.eventDate})` : f.date && !period ? ` (${f.date})` : period;
    const more = f.sources && f.sources.length > 1 ? ` (+${f.sources.length - 1} more source${f.sources.length > 2 ? 's' : ''})` : '';
    return `[${firstRef + i}] [${claimTag(f)}${f.superseded ? '; replaced later' : ''}] ${f.statement}${when}${f.path ? ` — ${f.path}${more}` : ''}`;
  });
  return `\n\n# ${heading}\n${lines.join('\n')}`;
}

/** The counts an enumerated answer is given: over every match, not over the claims listed. */
function renderCounts(e: Enumeration, kind: QuestionKind): string {
  const total = `${e.capped ? 'at least ' : ''}${e.matched} matching claims from ${e.documents} documents`;
  const row = (label: string, groups: [string, number][]) => (groups.length > 1 ? `\n${label}: ${groups.map(([k, n]) => `${k} ${n}`).join(', ')}` : '');
  if (kind === 'list') return `\n\n# Counts\n${total}`;
  return `\n\n# Counts\n${total}${row('By month', e.byMonth)}${row('By claim type', e.byType)}${row('By subject', e.bySubject)}`;
}

/** The claims that replaced claims the retrieved passages state, as facts, when the facts do not hold them yet. */
function currentFacts(contexts: SearchResult[], facts: ClaimItem[]): PromptFact[] {
  const have = new Set(facts.map((f) => f.id));
  const out: PromptFact[] = [];
  for (const c of contexts) {
    for (const cur of c.current ?? []) {
      if (have.has(cur.now.id)) continue;
      have.add(cur.now.id);
      out.push({
        id: cur.now.id, subject: '', object: null, type: 'current', statement: `${cur.now.statement} (replaces: ${cur.was.statement})`,
        status: 'fact', startDate: null, endDate: null, eventDate: cur.now.date, path: cur.now.path, chunkId: null,
      });
    }
  }
  return out.slice(0, 8);
}

/**
 * RAG answer with citations and explicit gap analysis (gbrain's `think`),
 * routed by the kind of question (docs/design/30):
 *
 *   lookup     selectable retrieval (hybrid by default, SAG opt-in) + graph
 *              expansion → budgeted context → cited synthesis. One search,
 *              one completion: what every question got before the router.
 *   list / aggregate / timeline
 *              the claims about what the question names, enumerated by SQL
 *              (entity, claim type, time window) with counts over the whole
 *              match, beside a short search and the excerpts; falls back to
 *              the lookup path when nothing is enumerated.
 *   multihop   SAG search plus a bounded relation walk from the named
 *              entities, with the passages that state each hop.
 *
 * Every route ends in the same single completion. Routing costs no model
 * call unless `retrieval.router.classifier` is `model` (then at most one).
 */
export async function ask(
  store: Store,
  config: KnodeConfig,
  embedder: EmbeddingProvider,
  llm: LlmClient,
  question: string,
  opts: {
    k?: number;
    mode?: SearchMode;
    /** The question's embedding, when the caller has it already. */
    queryVector?: number[];
    /** Known facts listed at most (default 24; an enumerated answer lists up to `retrieval.router.enumerateLimit`). */
    facts?: number;
    /** Characters of excerpts for a list question at most (default `EXCERPT_CHARS`; 0 for none). */
    excerpts?: number;
    /** Route the question this way instead of classifying it; `auto` (default) classifies. */
    route?: QuestionKind | 'auto';
    /** false: its searches record no hits (an evaluation answering against the index as built, docs/design/31 D3). */
    track?: boolean;
  } = {},
): Promise<AskResult> {
  const router = { ...defaultAskRouterConfig(), ...config.retrieval.router };
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
  const routed: QuestionRoute = opts.route && opts.route !== 'auto'
    ? { kind: opts.route, range: questionRange(question), by: 'caller' }
    : await routeQuestion(question, { classifier: router.classifier, llm });
  const env: RouteEnv = { store, config, embedder, llm, question, opts, queryVector, router, routed };

  if (routed.kind === 'list' || routed.kind === 'aggregate' || routed.kind === 'timeline') {
    const enumerated = await enumeratedAnswer(env);
    if (enumerated) return enumerated;
    return lookupAnswer({ ...env, routed: { ...routed, by: `fallback:${routed.by}` } });
  }
  if (routed.kind === 'multihop') return multihopAnswer(env);
  return lookupAnswer(env);
}

interface RouteEnv {
  store: Store;
  config: KnodeConfig;
  embedder: EmbeddingProvider;
  llm: LlmClient;
  question: string;
  opts: { k?: number; mode?: SearchMode; facts?: number; excerpts?: number; track?: boolean };
  queryVector: number[] | undefined;
  router: ReturnType<typeof defaultAskRouterConfig>;
  routed: QuestionRoute;
}

const routeOf = (r: QuestionRoute, extra: Partial<AskRoute> = {}): AskRoute => ({ kind: r.kind, by: r.by, range: r.range, ...extra });

/** The single-shot path: one search, a depth-2 graph search, ranked facts, excerpts for a list question. */
async function lookupAnswer(env: RouteEnv): Promise<AskResult> {
  const { store, config, embedder, question, opts, queryVector } = env;
  const k = opts.k ?? 8;
  const mode = opts.mode ?? 'hybrid';
  const [retrieved, graph, named] = await Promise.all([
    search(store, embedder, question, { k, mode, heat: config.heat, sag: config.retrieval.sag, rerank: config.retrieval.rerank, queryVector, track: opts.track }),
    graphSearch(store, question, { depth: 2, chunkLimit: 4, heat: config.heat, track: opts.track }),
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
  return compose(env, contexts, [...facts, ...currentFacts(contexts, facts)], '', routeOf(env.routed));
}

/**
 * List, aggregate and timeline: the enumeration of the claims about the named
 * entities (or of the claim types the question names), the relevance-ranked
 * facts a list question gets (relations, neighbours, variants), a short
 * search and the excerpts. Null when nothing is enumerated.
 */
async function enumeratedAnswer(env: RouteEnv): Promise<AskResult | null> {
  const { store, config, embedder, question, opts, queryVector, router, routed } = env;
  const named = await namedEntities(store, question);
  const types = await typesInQuestion(store, question);
  if (named.length === 0 && types.length === 0) return null;
  const timeline = routed.kind === 'timeline';
  const limit = Math.max(1, router.enumerateLimit);
  const query = { entities: named, types, range: routed.range, includeSuperseded: timeline, order: 'timeline' as const, limit };
  let enumeration = await enumerateClaims(store, query);
  let usedTypes = types;
  // a type the question seems to name, but no claim of it about these entities: every type
  if (enumeration.matched === 0 && types.length > 0 && named.length > 0) {
    enumeration = await enumerateClaims(store, { ...query, types: [] });
    usedTypes = [];
  }
  if (enumeration.matched === 0) return null;

  // the passages: a short search, not the top eight, and the lines of the named entities' other documents
  const k = Math.min(opts.k ?? 8, 4);
  const retrieved = await search(store, embedder, question, { k, mode: opts.mode ?? 'hybrid', heat: config.heat, sag: config.retrieval.sag, rerank: config.retrieval.rerank, queryVector, track: opts.track });
  const excerptBudget = opts.excerpts ?? EXCERPT_CHARS;
  const [ranked, excerpts]: [QuestionFact[], SearchResult[]] = await Promise.all([
    factsForQuestion(store, question, retrieved, { limit, queryVector, model: embedder.model, named, list: true }),
    excerptBudget > 0 && named.length > 0
      ? namedSurface(store, named).then((s) => excerptsForQuestion(store, question, retrieved, { budget: excerptBudget, names: s.names, namedDocs: s.docs }))
      : Promise.resolve([]),
  ]);
  const inRange = (f: { eventDate?: string | null; startDate: string | null }) => {
    const d = f.eventDate ?? f.startDate;
    if (!routed.range || !d) return true;
    return (!routed.range.from || d >= routed.range.from.slice(0, 10)) && (!routed.range.to || d <= routed.range.to.slice(0, 10));
  };
  const relevant = ranked.filter(inRange);
  const enumerated = new Set(enumeration.claims.map((c) => c.id));

  let facts: PromptFact[];
  if (timeline) {
    // one chronology: the enumerated claims and the ranked facts the enumeration does not hold, oldest first
    const dateOf = (f: PromptFact) => f.date ?? f.eventDate ?? f.startDate ?? null;
    const extra = relevant.filter((f) => !enumerated.has(f.id)).slice(0, Math.ceil(limit / 4));
    facts = [...enumeration.claims, ...extra]
      .map((f, i) => ({ f, i }))
      .sort((a, b) => {
        const da = dateOf(a.f);
        const db = dateOf(b.f);
        if (da && db && da !== db) return da < db ? -1 : 1;
        if (!da !== !db) return da ? -1 : 1;
        return a.i - b.i;
      })
      .map((x) => x.f);
  } else {
    // the best-matching facts first (a third of the room), then every enumerated claim, then the rest of the ranked
    const head = relevant.slice(0, Math.ceil(limit / 3));
    const inHead = new Set(head.map((f) => f.id));
    const rest: PromptFact[] = enumeration.claims.filter((c) => !inHead.has(c.id));
    const tail = relevant.slice(head.length).filter((f) => !enumerated.has(f.id));
    facts = [...head, ...rest, ...tail].slice(0, limit);
  }
  const byId = new Map<string, EnumeratedClaim>(enumeration.claims.map((c) => [c.id, c]));
  facts = facts.map((f) => byId.get(f.id) ?? f);

  const contexts = [...retrieved, ...excerpts];
  const listed = facts.filter((f) => enumerated.has(f.id)).length;
  const heading = `Known facts (enumerated: ${listed} of ${enumeration.capped ? 'at least ' : ''}${enumeration.matched} matching claims listed${routed.range ? `, ${routed.range.text}` : ''})`;
  return compose(env, contexts, [...facts, ...currentFacts(contexts, facts)], renderCounts(enumeration, routed.kind), routeOf(routed, {
    enumerated: { matched: enumeration.matched, listed, documents: enumeration.documents, capped: enumeration.capped, types: usedTypes, entities: named.length },
  }), heading);
}

/** Multi-hop: SAG search, and a bounded walk over the named entities' relations with the passages stating each hop. */
async function multihopAnswer(env: RouteEnv): Promise<AskResult> {
  const { store, config, embedder, question, opts, queryVector, router } = env;
  const k = opts.k ?? 8;
  const named = await namedEntities(store, question);
  const [retrieved, walk] = await Promise.all([
    search(store, embedder, question, { k, mode: 'sag', heat: config.heat, sag: config.retrieval.sag, rerank: config.retrieval.rerank, queryVector, track: opts.track }),
    walkRelations(store, question, named, { maxHops: router.maxHops, queryVector, model: embedder.model }),
  ]);
  const seen = new Set(retrieved.map((r) => r.chunkId));
  // the passages that state the hops share the top of the context with the search: a chain's later hops are
  // rarely what a search of the whole question finds
  const bridges = walk.bridges.filter((c) => !seen.has(c.chunkId));
  const half = Math.ceil(k / 2);
  const found = [...retrieved.slice(0, half), ...bridges.slice(0, k - half), ...retrieved.slice(half), ...bridges.slice(k - half)].slice(0, k + 4);
  const ranked = await factsForQuestion(store, question, found, { limit: opts.facts, queryVector, model: embedder.model, named: [...named, ...walk.reached] });
  const steps = stepsAsFacts(walk.steps);
  const stepIds = new Set(steps.map((s) => s.id));
  const facts: PromptFact[] = [...steps, ...ranked.filter((f) => !stepIds.has(f.id))];
  return compose(env, found, [...facts, ...currentFacts(found, facts)], '', routeOf(env.routed, {
    walked: { hops: walk.steps.reduce((n, s) => Math.max(n, s.hop), 0), relations: walk.steps.length, reached: walk.reached.length, bridges: walk.bridges.length },
  }));
}

/** The one completion every route ends in, and its citations. */
async function compose(env: RouteEnv, contexts: SearchResult[], facts: PromptFact[], extra: string, route: AskRoute, heading?: string): Promise<AskResult> {
  const { llm, question } = env;
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
      route,
    };
  }

  const contextBlock = contexts
    .map((c, i) => `[${i + 1}] (${c.path}${c.excerpt ? ', excerpt' : ''})\n${c.content.slice(0, ASK_CONTEXT_CHARS)}`)
    .join('\n\n');
  const raw = await llm.complete([
    { role: 'system', content: route.enumerated ? `${ASK_SYSTEM}${ENUMERATED_RULE}` : ASK_SYSTEM },
    { role: 'user', content: `# Context\n${contextBlock}${renderFacts(facts, contexts.length + 1, heading)}${extra}\n\n# Question\n${question}` },
  ], { maxTokens: route.enumerated ? 3000 : 1500 });

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
    route,
  };
}
