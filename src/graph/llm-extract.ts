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

function extractSystemPrompt(ont: Ontology, withClaims: boolean): string {
  const vocab = promptFragment(ont);
  const base = `You are a knowledge-graph extraction engine. Extract the most important named entities and the relations between them from the document.

Rules:
- Entity types: ${vocab.entityTypes}.
- Relation types (direction reads "source <type> target"; an inverse spelling such as "parent_of" is accepted and flipped):
${vocab.relationTypes}
- Only entities that matter to the document's topic; max 15 entities, max 20 relations.
- Keep names short and canonical (e.g. "PostgreSQL", not "the PostgreSQL database"); put other spellings, abbreviations and tickers in aliases.
- description: one sentence, factual, in the document's language.
- relation validFrom/validTo: ISO-8601 dates when the document says since when / until when the relation holds (ownership, supply contracts, employment), else null.
- sameAs: when an entity is one of the "Known entities" given with the document under another spelling, keep your spelling as name and put the known name in sameAs; otherwise null.`;
  if (!withClaims) {
    return base + `\nRespond with JSON only: {"entities":[{"name","type","description","aliases":[],"sameAs"}],"relations":[{"source","target","type","description","validFrom","validTo"}]}`;
  }
  return base + `

Also extract claims — specific, informative factual assertions stated in the document:
- subject: must be one of the extracted entity names. object: the affected entity name, or null.
- type: a short category label you choose (e.g. "capability", "decision", "benchmark").
- statement: one self-contained sentence in the document's language.
- status: "fact" (the document states it as confirmed), "suspected" (unverified/hedged), or "disputed" (the document contradicts or questions it).
- eventDate: when the statement is about something that happened at a time (a result, a deal, an appointment), that date; else null.
- startDate/endDate: the period during which the statement holds (a role, a contract, a guidance window), else null.
- Dates are ISO-8601 at the stated precision (YYYY, YYYY-MM, YYYY-MM-DD or YYYY-Qn). Resolve relative expressions ("last year", "去年", "本季度") against the document date given with the input; if no document date is given, leave relative dates null.
- Only claims that carry real information; skip trivia; max 10 claims.
Respond with JSON only: {"entities":[{"name","type","description","aliases":[],"sameAs"}],"relations":[{"source","target","type","description","validFrom","validTo"}],"claims":[{"subject","object","type","statement","status","eventDate","startDate","endDate"}]}`;
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

/**
 * Call the LLM and return the raw entity/relation/claim lists. Pure
 * extraction, no DB writes; the result is persisted to the document's sidecar
 * so a DB rebuild can replay it without paying the LLM again.
 */
export async function llmExtract(
  llm: LlmClient,
  page: { path: string; title: string },
  content: string,
  opts: { model?: string; claims?: boolean; ontology?: Ontology; knownEntities?: KnownEntity[]; docDate?: string | null } = {},
): Promise<{ entities: ExtractedEntity[]; relations: ExtractedRelation[]; claims: ExtractedClaim[] }> {
  const withClaims = opts.claims ?? true;
  const ontology = opts.ontology ?? builtinOntology();
  const body = content.slice(0, LLM_EXTRACT_INPUT_CHARS);
  const result = await llm.completeJson<{ entities?: ExtractedEntity[]; relations?: ExtractedRelation[]; claims?: ExtractedClaim[] }>([
    { role: 'system', content: extractSystemPrompt(ontology, withClaims) },
    { role: 'user', content: `${knownEntitiesBlock(opts.knownEntities ?? [])}Document date: ${opts.docDate ? opts.docDate.slice(0, 10) : 'unknown'}\nDocument: ${page.title} (${page.path})\n\n${body}` },
  // generous ceiling: reasoning models spend completion tokens on thinking
  // before the JSON, and dense documents produce long entity/claim lists —
  // a truncated response fails JSON parsing and wastes the whole call
  ], { maxTokens: withClaims ? 8000 : 6000, model: opts.model });

  return {
    entities: (result.entities ?? [])
      .filter((e) => e && typeof e.name === 'string' && e.name.trim())
      .map((e) => ({ ...e, sameAs: typeof e.sameAs === 'string' && e.sameAs.trim() ? e.sameAs.trim() : null })),
    relations: (result.relations ?? []).filter((r) => r && r.source && r.target),
    claims: withClaims
      ? (result.claims ?? [])
          .filter((c) => c && typeof c.subject === 'string' && c.subject.trim() && typeof c.statement === 'string' && c.statement.trim())
          .slice(0, 10)
      : [],
  };
}

/**
 * Apply extracted entities/relations/claims as evidence of the writer's
 * scope. Mentions are attached to the chunks where each entity name (or
 * alias) appears. Used for fresh LLM extractions, sidecar replays and
 * frontmatter-declared (tier 0.5) facts alike — `extractor` tells them apart.
 */
export async function applyExtraction(
  w: ScopeWriter,
  page: PageContext,
  entities: ExtractedEntity[],
  relations: ExtractedRelation[],
  claims: ExtractedClaim[] = [],
  extractor = 'tier1.llm',
  opts: { docDate?: string | null } = {},
): Promise<{ entities: number; relations: number; claims: number; entityIds: string[] }> {
  const ref = opts.docDate ?? null;
  const idByName = new Map<string, string>();
  // every entity this extraction wrote evidence for, relation endpoints
  // included — what the duplicate audit after a tier-1 pass looks at
  const touched = new Set<string>();

  for (const e of entities) {
    const needles = [e.name, ...(e.aliases ?? [])].map((s) => s.toLowerCase());
    const hits = page.chunkIds.filter((c) => {
      const lc = c.content.toLowerCase();
      return needles.some((n) => n && lc.includes(n));
    });
    const id = await w.entity(e, { extractor, segmentId: hits[0]?.id ?? page.chunkIds[0]?.id ?? null });
    touched.add(id);
    idByName.set(e.name.toLowerCase(), id);
    for (const a of e.aliases ?? []) idByName.set(a.toLowerCase(), id);
    for (const h of hits.slice(0, 8)) await w.mention(id, h.id, page.documentId);
    if (hits.length === 0 && page.chunkIds[0]) await w.mention(id, page.chunkIds[0].id, page.documentId);
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
  for (const c of claims) {
    const subjectId = idByName.get(c.subject.toLowerCase().trim());
    if (!subjectId) continue;
    const objectId = c.object && c.object.toUpperCase() !== 'NONE'
      ? idByName.get(c.object.toLowerCase().trim()) ?? null
      : null;
    const status = (CLAIM_STATUS as readonly string[]).includes(c.status) ? c.status : 'fact';
    const chunkId = bestChunkFor(c.statement, page.chunkIds);
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
    if (id) claimCount++;
  }
  return { entities: entities.length, relations: relCount, claims: claimCount, entityIds: [...touched] };
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
