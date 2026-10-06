import { LLM_EXTRACT_INPUT_CHARS } from '../constants.js';
import { dateEnd, dateStart } from '../store/dates.js';
import { Queryable } from '../store/migrations.js';
import { ScopeWriter } from '../lineage/writer.js';
import { LlmClient } from '../llm/client.js';
import { builtinOntology, Ontology, promptFragment } from './ontology.js';
import {
  CLAIM_STATUS,
  ExtractedClaim,
  ExtractedEntity,
  ExtractedRelation,
  PageContext,
} from './store.js';

/**
 * Tier-1 LLM extraction: named entities, typed relations and claims from raw
 * document text. Extraction (llmExtract) is pure — no DB writes — so results
 * can be persisted to the document sidecar and replayed for free on rebuild;
 * applyExtraction writes them as evidence of the calling scope.
 */

/**
 * Per-call caps. They keep the JSON short enough to come back whole — a
 * truncated response fails to parse and wastes the call — and are counted per
 * call, so a long document read in segments gets them once per segment.
 */
export const EXTRACT_CAPS = { entities: 25, relations: 30, claims: 25 } as const;

function extractSystemPrompt(ont: Ontology, withClaims: boolean, askSubject: boolean): string {
  const vocab = promptFragment(ont);
  const base = `You are a knowledge-graph extraction engine. Extract the most important named entities and the relations between them from the text.

Rules:
- Entity types: ${vocab.entityTypes}.
- Relation types (direction reads "source <type> target"; an inverse spelling such as "parent_of" is accepted and flipped):
${vocab.relationTypes}
- Only entities that matter to the text; at most ${EXTRACT_CAPS.entities} entities and ${EXTRACT_CAPS.relations} relations.
- Keep names short and canonical (e.g. "PostgreSQL", not "the PostgreSQL database"); put other spellings, abbreviations and tickers in aliases.
- Never extract a generic reference as an entity (公司, 本公司, 该公司, 我们, 作者, "the company", "the firm", "the author"): put what it says under the entity it refers to when the text makes that clear, otherwise leave it out.
- description: one sentence, factual, in the document's language.
- relation validFrom/validTo: ISO-8601 dates when the document says since when / until when the relation holds (ownership, supply contracts, employment), else null.
- sameAs: when an entity is one of the "Known entities" given with the document under another spelling, keep your spelling as name and put the known name in sameAs; otherwise null.`;
  const subjectRule = askSubject
    ? `
- subject: the one entity this whole document is mainly about, judged from the title and this opening part, also listed in entities; null when the document covers many unrelated subjects (an archive, a digest, a feed).`
    : '';
  const subjectField = askSubject ? `"subject":{"name","type"}|null,` : '';
  if (!withClaims) {
    return base + subjectRule + `\nRespond with JSON only: {${subjectField}"entities":[{"name","type","description","aliases":[],"sameAs"}],"relations":[{"source","target","type","description","validFrom","validTo"}]}`;
  }
  return base + subjectRule + `

Also extract claims — specific, informative factual assertions stated in the document:
- subject: must be one of the extracted entity names. object: the affected entity name, or null.
- type: a short category label you choose (e.g. "capability", "decision", "benchmark").
- statement: one self-contained sentence in the document's language.
- status: "fact" (the document states it as confirmed), "suspected" (unverified/hedged), or "disputed" (the document contradicts or questions it).
- eventDate: when the statement is about something that happened at a time (a result, a deal, an appointment), that date; else null.
- startDate/endDate: the period during which the statement holds (a role, a contract, a guidance window), else null.
- Dates are ISO-8601 at the stated precision (YYYY, YYYY-MM, YYYY-MM-DD or YYYY-Qn). Resolve relative expressions ("last year", "去年", "本季度") against the time the passage itself says it was written (a post's timestamp, a dated heading) when it states one, otherwise against the document date given with the input; if neither is known, leave relative dates null.
- Only claims that carry real information; skip trivia; at most ${EXTRACT_CAPS.claims} claims.
Respond with JSON only: {${subjectField}"entities":[{"name","type","description","aliases":[],"sameAs"}],"relations":[{"source","target","type","description","validFrom","validTo"}],"claims":[{"subject","object","type","statement","status","eventDate","startDate","endDate"}]}`;
}

export interface KnownEntity {
  name: string;
  type: string;
  aliases: string[];
}

function knownEntitiesBlock(known: KnownEntity[]): string {
  if (known.length === 0) return '';
  const lines = known.map((k) => `- ${k.name} (${k.type}${k.aliases.length ? `; aliases: ${k.aliases.join(', ')}` : ''})`);
  return `Known entities already in the knowledge graph — reuse these canonical names, or reference one via sameAs when you extract it under another spelling:\n${lines.join('\n')}\n\n`;
}

/**
 * Entities the graph already holds that appear in `text` (by name or alias),
 * hottest first — the candidate list the tier-1 prompt shows so the LLM
 * links to them instead of minting near-duplicates.
 */
export async function knownEntitiesIn(q: Queryable, text: string, limit = 30): Promise<KnownEntity[]> {
  const rows = await q.query<{ name: string; type: string; aliases: string[] }>(
    `SELECT name, type, aliases FROM entities
     WHERE tx_to IS NULL AND canonical_id IS NULL AND type <> 'concept' AND mention_count >= 2
     ORDER BY mention_count DESC LIMIT 500`,
  );
  const lc = text.toLowerCase();
  const out: KnownEntity[] = [];
  for (const r of rows) {
    const aliases = Array.isArray(r.aliases) ? r.aliases.map(String) : [];
    const needles = [r.name, ...aliases].map((x) => x.toLowerCase()).filter((x) => x.length >= 2);
    if (needles.some((n) => lc.includes(n))) out.push({ name: r.name, type: r.type, aliases });
    if (out.length >= limit) break;
  }
  return out;
}

/** Where a segment sits in a long document (docs/design/10): shown to the model above the text. */
export interface SegmentContext {
  index: number;
  total: number;
  heading: string | null;
}

export interface ExtractResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  claims: ExtractedClaim[];
  /** Asked of a long document's first segment only. */
  subject?: { name: string; type: string } | null;
}

/**
 * Call the LLM and return the raw entity/relation/claim lists. Pure
 * extraction, no DB writes; the result is persisted to the document's sidecar
 * so a DB rebuild can replay it without paying the LLM again.
 *
 * `segment` marks one part of a long document: the header names the part and
 * its section, `subject` (answered by the first part) tells the others what
 * the document is about, and `askSubject` asks the first part for it.
 */
export async function llmExtract(
  llm: LlmClient,
  page: { path: string; title: string },
  content: string,
  opts: {
    model?: string;
    claims?: boolean;
    ontology?: Ontology;
    knownEntities?: KnownEntity[];
    docDate?: string | null;
    /** Text read per call; default LLM_EXTRACT_INPUT_CHARS. */
    maxChars?: number;
    segment?: SegmentContext;
    subject?: { name: string; type: string } | null;
    askSubject?: boolean;
  } = {},
): Promise<ExtractResult> {
  const withClaims = opts.claims ?? true;
  const ontology = opts.ontology ?? builtinOntology();
  const body = content.slice(0, opts.maxChars ?? LLM_EXTRACT_INPUT_CHARS);
  const date = `Document date: ${opts.docDate ? opts.docDate.slice(0, 10) : 'unknown'}`;
  const seg = opts.segment;
  const head = seg
    ? [
        `Document: ${page.title} (${page.path}) · part ${seg.index + 1} of ${seg.total}${seg.heading ? ` · section: ${seg.heading}` : ''}`,
        date,
        ...(opts.subject ? [`Main subject of this document: ${opts.subject.name} (${opts.subject.type})`] : []),
      ].join('\n')
    : `${date}\nDocument: ${page.title} (${page.path})`;
  const askSubject = Boolean(opts.askSubject);
  const result = await llm.completeJson<{ entities?: ExtractedEntity[]; relations?: ExtractedRelation[]; claims?: ExtractedClaim[]; subject?: unknown }>([
    { role: 'system', content: extractSystemPrompt(ontology, withClaims, askSubject) },
    { role: 'user', content: `${knownEntitiesBlock(opts.knownEntities ?? [])}${head}\n\n${body}` },
  // generous ceiling: reasoning models spend completion tokens on thinking
  // before the JSON, and dense documents produce long entity/claim lists —
  // a truncated response fails JSON parsing and wastes the whole call
  ], { maxTokens: withClaims ? 12_000 : 9_000, model: opts.model });

  const out: ExtractResult = {
    entities: (result.entities ?? [])
      .filter((e) => e && typeof e.name === 'string' && e.name.trim())
      .map((e) => ({ ...e, sameAs: typeof e.sameAs === 'string' && e.sameAs.trim() ? e.sameAs.trim() : null })),
    relations: (result.relations ?? []).filter((r) => r && r.source && r.target),
    claims: withClaims
      ? (result.claims ?? [])
          .filter((c) => c && typeof c.subject === 'string' && c.subject.trim() && typeof c.statement === 'string' && c.statement.trim())
          .slice(0, EXTRACT_CAPS.claims)
      : [],
  };
  if (askSubject) {
    const sub = result.subject as { name?: unknown; type?: unknown } | null | undefined;
    out.subject = sub && typeof sub.name === 'string' && sub.name.trim()
      ? { name: sub.name.trim(), type: typeof sub.type === 'string' && sub.type.trim() ? sub.type.trim() : 'other' }
      : null;
  }
  return out;
}

/** Chunk mentions an entity gets in each segment it was extracted from. */
const MENTIONS_PER_SEGMENT = 4;

type ChunkRef = { id: string; content: string };

/**
 * The chunks that start inside each segment of a long document, found by
 * locating every chunk in the document text (chunks overlap, so the search
 * moves forward from the previous chunk's start).
 */
export function chunksBySegment(text: string, chunks: ChunkRef[], ranges: { start: number; end: number }[]): Map<number, ChunkRef[]> {
  const out = new Map<number, ChunkRef[]>();
  let cursor = 0;
  for (const c of chunks) {
    const probe = c.content.slice(0, 120);
    if (!probe) continue;
    let at = text.indexOf(probe, cursor);
    if (at === -1) at = text.indexOf(probe);
    if (at === -1) continue;
    cursor = at + 1;
    const seg = ranges.findIndex((r) => at >= r.start && at < r.end);
    if (seg >= 0) (out.get(seg) ?? out.set(seg, []).get(seg)!).push(c);
  }
  return out;
}

/**
 * Apply extracted entities/relations/claims as evidence of the writer's
 * scope. Mentions are attached to the chunks where each entity name (or
 * alias) appears. Used for fresh LLM extractions, sidecar replays and
 * frontmatter-declared (tier 0.5) facts alike — `extractor` tells them apart.
 *
 * For a document extracted in segments, `segments` gives the text and the
 * segment ranges: an entity's mentions then come from the segments it was
 * extracted from (a few each), and a claim is grounded inside its own segment.
 */
export async function applyExtraction(
  w: ScopeWriter,
  page: PageContext,
  entities: ExtractedEntity[],
  relations: ExtractedRelation[],
  claims: ExtractedClaim[] = [],
  extractor = 'tier1.llm',
  opts: { docDate?: string | null; segments?: { text: string; ranges: { start: number; end: number }[] } } = {},
): Promise<{ entities: number; relations: number; claims: number; entityIds: string[]; claimIds: string[] }> {
  const ref = opts.docDate ?? null;
  const idByName = new Map<string, string>();
  // every entity this extraction wrote evidence for, relation endpoints
  // included — what the duplicate audit after a tier-1 pass looks at
  const touched = new Set<string>();
  const bySegment = opts.segments && opts.segments.ranges.length > 1
    ? chunksBySegment(opts.segments.text, page.chunkIds, opts.segments.ranges)
    : null;

  for (const e of entities) {
    const needles = [e.name, ...(e.aliases ?? [])].map((s) => s.toLowerCase());
    const has = (c: ChunkRef) => {
      const lc = c.content.toLowerCase();
      return needles.some((n) => n && lc.includes(n));
    };
    let hits: ChunkRef[];
    let fallback: ChunkRef | undefined = page.chunkIds[0];
    if (bySegment && e.segments?.length) {
      hits = e.segments.flatMap((i) => (bySegment.get(i) ?? []).filter(has).slice(0, MENTIONS_PER_SEGMENT));
      fallback = bySegment.get(e.segments[0])?.[0] ?? fallback;
    } else {
      hits = page.chunkIds.filter(has).slice(0, 8);
    }
    const id = await w.entity(e, { extractor, segmentId: hits[0]?.id ?? fallback?.id ?? null });
    touched.add(id);
    idByName.set(e.name.toLowerCase(), id);
    for (const a of e.aliases ?? []) idByName.set(a.toLowerCase(), id);
    for (const h of hits) await w.mention(id, h.id, page.documentId);
    if (hits.length === 0 && fallback) await w.mention(id, fallback.id, page.documentId);
  }

  let relCount = 0;
  for (const r of relations) {
    const sourceId = idByName.get(r.source.toLowerCase()) ?? (await w.entity({ name: r.source, type: 'concept' }, { extractor }));
    const targetId = idByName.get(r.target.toLowerCase()) ?? (await w.entity({ name: r.target, type: 'concept' }, { extractor }));
    touched.add(sourceId);
    touched.add(targetId);
    // the writer normalizes the predicate against the ontology (synonyms, inverse readings, unknown → related_to)
    if (await w.relation(sourceId, targetId, { type: r.type, description: r.description, validFrom: dateStart(r.validFrom, ref), validTo: dateEnd(r.validTo, ref), extractor })) relCount++;
  }

  // weak co-occurrence between extracted entities of the same document
  await w.coOccurrence([...idByName.values()], { weight: 0.2, window: 8, extractor });

  // claims — citable assertions grounded to the best-overlapping chunk;
  // subjects that don't resolve to an extracted entity are dropped
  let claimCount = 0;
  const claimIds: string[] = [];
  for (const c of claims) {
    const subjectId = idByName.get(c.subject.toLowerCase().trim());
    if (!subjectId) continue;
    const objectId = c.object && c.object.toUpperCase() !== 'NONE'
      ? idByName.get(c.object.toLowerCase().trim()) ?? null
      : null;
    const status = (CLAIM_STATUS as readonly string[]).includes(c.status) ? c.status : 'fact';
    const own = bySegment && c.segment !== undefined ? bySegment.get(c.segment) : undefined;
    const chunkId = bestChunkFor(c.statement, own?.length ? own : page.chunkIds);
    const id = await w.claim(subjectId, {
      objectId,
      type: (c.type || 'fact').trim(),
      statement: c.statement,
      status,
      // dates the way the source wrote them → windows at the stated precision, relative forms anchored on the document date
      validFrom: dateStart(c.startDate, ref),
      validTo: dateEnd(c.endDate, ref),
      eventAt: dateStart(c.eventDate, ref),
      observedAt: ref,
      extractor,
      segmentId: chunkId,
    });
    if (id) {
      claimCount++;
      claimIds.push(id);
    }
  }
  return { entities: entities.length, relations: relCount, claims: claimCount, entityIds: [...touched], claimIds };
}

/** Ground a claim statement to the chunk with the highest token overlap. */
function bestChunkFor(statement: string, chunks: { id: string; content: string }[]): string | null {
  const tokens = [...new Set(statement.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2))];
  if (tokens.length === 0 || chunks.length === 0) return chunks[0]?.id ?? null;
  let best: { id: string; score: number } | null = null;
  for (const c of chunks) {
    const lc = c.content.toLowerCase();
    const score = tokens.reduce((s, t) => s + (lc.includes(t) ? 1 : 0), 0);
    if (!best || score > best.score) best = { id: c.id, score };
  }
  return best && best.score > 0 ? best.id : chunks[0]?.id ?? null;
}
