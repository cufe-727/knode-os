import { LLM_EXTRACT_INPUT_CHARS } from '../constants.js';
import { dateEnd, dateStart } from '../store/dates.js';
import { Store } from '../store/db.js';
import { ScopeWriter } from '../lineage/writer.js';
import { ChatMessage, LlmClient } from '../llm/client.js';
import { claimMeasure, isCorrectionStatement } from './claim-state.js';
import { findLinks, LinkCandidate, tier0Known } from './concepts.js';
import { namesakeChoice, namesakeRules } from './entity-context.js';
import { builtinOntology, Ontology } from './ontology.js';
import {
  CLAIM_STATUS,
  CLAIM_TYPES,
  ExtractedClaim,
  ExtractedEntity,
  ExtractedRelation,
  PageContext,
  normalizeClaimKind,
  normalizeClaimType,
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

/** The closed claim vocabulary as the prompt lists it (system types left out). */
function claimTypeLines(): string {
  return CLAIM_TYPES.filter((t) => !t.system).map((t) => `  - ${t.id}: ${shortDescription(t.description)}`).join('\n');
}

/** A type's description with at most three of its examples ("what: a, b, c, d" → "what: a, b, c"). */
function shortDescription(description: string): string {
  const at = description.indexOf(': ');
  if (at < 0) return description;
  const examples = description.slice(at + 2).split(/,\s*/);
  return `${description.slice(0, at)}: ${examples.slice(0, 3).join(', ')}`;
}

/**
 * The ontology as the extraction prompt lists it: one short line per type.
 * promptFragment's long form (examples, domain → range on every relation) cost
 * 2,900 of a 7,600-character instruction block on a 1,200-character report,
 * and the block goes out with every call; domains and ranges are checked on
 * write anyway (src/lineage/writer.ts).
 */
function compactVocabulary(ont: Ontology): { entityTypes: string; relationTypes: string } {
  const entityTypes = ont.entityTypes.map((t) => {
    const examples = t.examples?.length ? ` (e.g. ${t.examples.slice(0, 3).join(', ')})` : '';
    return `- ${t.id}${t.label ? ` (${t.label})` : ''}${t.description ? `: ${t.description}` : ''}${examples}`;
  }).join('\n');
  const lines: string[] = [];
  for (const r of ont.relationTypes) {
    if (r.system || r.documentLink) continue;
    const marks = [r.symmetric ? 'symmetric' : null, r.temporal ? 'time-bound' : null].filter(Boolean);
    lines.push(`- ${r.id}${r.description ? `: ${r.description}` : ''}${marks.length ? `; ${marks.join('; ')}` : ''}`);
  }
  lines.push('- related_to: only when nothing above fits');
  return { entityTypes, relationTypes: lines.join('\n') };
}

/** The JSON a single-document reply has; `subject` only when asked. */
function replyShape(withClaims: boolean, askSubject: boolean): string {
  const subjectField = askSubject ? `"subject":{"name","type"}|null,` : '';
  const claims = withClaims ? `,"claims":[{"subject","object","type","kind","statement","status","eventDate","startDate","endDate","attribute","value","unit","corrects"}]` : '';
  return `{${subjectField}"entities":[{"name","type","description","aliases":[],"sameAs"}],"relations":[{"source","target","type","description","validFrom","validTo"}]${claims}}`;
}

function extractRules(ont: Ontology, withClaims: boolean, askSubject: boolean): string {
  const vocab = compactVocabulary(ont);
  const base = `You are a knowledge-graph extraction engine. Extract the most important named entities, the relations between them${withClaims ? ' and the claims the text makes' : ''}.

Entity types (the most specific that fits; concept only when nothing else does):
${vocab.entityTypes}
Relation types ("source <type> target"; an inverse reading such as "parent_of" is accepted; validFrom/validTo for a time-bound one when the text says since / until when):
${vocab.relationTypes}

Rules:
- Only entities that matter to the text; at most ${EXTRACT_CAPS.entities} entities and ${EXTRACT_CAPS.relations} relations.
- Names short and canonical ("PostgreSQL", not "the PostgreSQL database"); other spellings, former names, abbreviations and tickers in aliases.
- Never extract a generic reference (公司, 本公司, 我们, 作者, "the company", "the author") as an entity: put what it says under the entity it refers to when the text makes that clear.
- description: one sentence on what the entity is in general, not what this document says about it ("宁德时代是全球最大的动力电池制造商", not "宁德时代本周涨停"); in the document's language; empty when the text does not tell.
- sameAs: when an entity is one of the "Known entities" under another spelling, keep your spelling as name and put the known name in sameAs; else null.`;
  const subjectRule = askSubject
    ? `
- subject: the one entity this whole document is mainly about, judged from the title and this opening part, also listed in entities; null when the document covers many unrelated subjects (an archive, a digest, a feed).`
    : '';
  if (!withClaims) return base + subjectRule;
  return base + subjectRule + `

Claims — specific, informative assertions (facts, views, forecasts), at most ${EXTRACT_CAPS.claims}:
- subject: one of the extracted entity names; object: the affected entity name, or null.
- type: exactly one of
${claimTypeLines()}
- kind: "fact" (happened or holds), "opinion" (a judgement: 认为, 看好), "prediction" (a forecast, plan or target: 预计, 计划), "rumor" (hearsay: 传闻, 据说).
- statement: one self-contained sentence in the document's language, without attribution (作者认为 / 他说: write "宁德时代估值偏高", not "作者认为宁德时代估值偏高").
- status: "fact" (stated as settled), "suspected" (hedged) or "disputed" (questioned).
- attribute/value/unit: for the value of a measure or state of the subject (完成度 46%, 在岗人数 7人, 负责人 孙欣, a price, a count): the attribute's short name without subject or date, the value (number or short text), the unit ("%", "人"); else null. One measure per claim: "完成度46%，负责人孙欣" is two claims.
- corrects: true when the statement corrects or retracts an earlier report (更正, 此前数字有误); state the corrected value.
- eventDate: when the happening took place; startDate/endDate: the period it holds for (a role, a contract, a reporting week). Only dates the text states or implies, never guessed; null when it simply holds as of the document date. ISO-8601 at the stated precision (YYYY, YYYY-MM, YYYY-MM-DD, YYYY-Qn, YYYY-Www); relative ones ("上周", "去年") against the passage's own timestamp or heading, else the document date, else null.
- Skip trivia. In chats, diaries and personal notes, plans, appointments, health, moods, money, preferences and relationships are information.`;
}

function extractSystemPrompt(ont: Ontology, withClaims: boolean, askSubject: boolean): string {
  return `${extractRules(ont, withClaims, askSubject)}\nRespond with JSON only: ${replyShape(withClaims, askSubject)}`;
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

/** Aliases listed per known entity: the spellings this text uses first, then the stored ones. */
const KNOWN_ALIASES_SHOWN = 6;

/**
 * Entities the graph already holds that appear in `text`, most often first —
 * the candidate list the tier-1 prompt shows so the LLM links to them instead
 * of minting near-duplicates. Found the way tier-0 links a document
 * (src/graph/concepts.ts): the workspace's link index, Latin spellings as
 * whole words, CJK as substrings, and never on a weak surface — a bare
 * substring scan listed iPhone 11 for every "11" in a date and 债券 for the
 * "cd" in "cdn". The aliases shown are capped: an entity with two hundred
 * spellings is named by the ones in this text and a few more.
 */
export async function knownEntitiesIn(store: Store, text: string, limit = 30): Promise<KnownEntity[]> {
  const { index } = await tier0Known(store);
  const hits = new Map<string, { candidate: LinkCandidate; count: number; surfaces: string[] }>();
  for (const span of findLinks(text, index)) {
    const c = span.candidate;
    if (!c.id) continue;
    let hit = hits.get(c.id);
    if (!hit) hits.set(c.id, (hit = { candidate: c, count: 0, surfaces: [] }));
    hit.count++;
    const surface = text.slice(span.start, span.end);
    if (!hit.surfaces.some((s) => s.toLowerCase() === surface.toLowerCase())) hit.surfaces.push(surface);
  }
  return [...hits.values()]
    .sort((a, b) => b.count - a.count || (b.candidate.mentions ?? 0) - (a.candidate.mentions ?? 0) || a.candidate.name.localeCompare(b.candidate.name))
    .slice(0, limit)
    .map(({ candidate, surfaces }) => {
      const seen = new Set([candidate.name.toLowerCase()]);
      const aliases: string[] = [];
      for (const a of [...surfaces, ...(candidate.aliases ?? [])]) {
        if (aliases.length >= KNOWN_ALIASES_SHOWN) break;
        const k = a.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        aliases.push(a);
      }
      return { name: candidate.name, type: candidate.type, aliases };
    });
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

export interface ExtractOptions {
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
}

/** One extraction call, ready to send: the messages, and what parsing the reply has to know. */
export interface ExtractRequest {
  messages: ChatMessage[];
  maxTokens: number;
  withClaims: boolean;
  askSubject: boolean;
}

/** The model's reply before it is checked: whatever JSON came back. */
export interface RawExtractReply {
  entities?: ExtractedEntity[];
  relations?: ExtractedRelation[];
  claims?: ExtractedClaim[];
  subject?: unknown;
}

/**
 * The prompt for one extraction call. Split from the call itself so a call can
 * run elsewhere — a labeling worker on another machine gets these messages and
 * hands back the raw reply, which `parseExtractReply` checks here.
 */
export function buildExtractRequest(page: { path: string; title: string }, content: string, opts: ExtractOptions = {}): ExtractRequest {
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
  return {
    messages: [
      { role: 'system', content: extractSystemPrompt(ontology, withClaims, askSubject) },
      { role: 'user', content: `${knownEntitiesBlock(opts.knownEntities ?? [])}${head}\n\n${body}` },
    ],
    // generous ceiling: reasoning models spend completion tokens on thinking
    // before the JSON, and dense documents produce long entity/claim lists —
    // a truncated response fails JSON parsing and wastes the whole call
    maxTokens: withClaims ? 12_000 : 9_000,
    withClaims,
    askSubject,
  };
}

/** One short document of a batched extraction call. */
export interface BatchExtractItem {
  page: { path: string; title: string };
  content: string;
  docDate?: string | null;
  knownEntities?: KnownEntity[];
}

/** Documents one batched call reads at most. */
export const EXTRACT_BATCH_DOCS = 8;
/** A document longer than this is read by a call of its own. */
export const EXTRACT_BATCH_DOC_CHARS = 4000;
/** Known entities a batched call lists at most (the union of its documents'). */
const BATCH_KNOWN_ENTITIES = 40;

/**
 * One extraction call over several short documents (a weekly report, a chat,
 * an e-mail), each under its own header, answered as
 * {"documents":[{"doc":1, …the single-document fields…}, …]}. The rules are
 * the single-document ones and go out once: on the 2026-11 benchmark a
 * 1,200-character report cost a call of its own, about 20k weighted tokens
 * with a CLI model's preamble, and the life pack's 168 chats 168 calls.
 * Reimplemented from the unmerged branch claude/knowledge-base-optimization-a84c37.
 */
export function buildBatchExtractRequest(items: BatchExtractItem[], opts: Pick<ExtractOptions, 'claims' | 'ontology' | 'maxChars'> = {}): ExtractRequest {
  const withClaims = opts.claims ?? true;
  const ontology = opts.ontology ?? builtinOntology();
  const known: KnownEntity[] = [];
  const seen = new Set<string>();
  for (const k of items.flatMap((i) => i.knownEntities ?? [])) {
    const key = k.name.toLowerCase();
    if (seen.has(key) || known.length >= BATCH_KNOWN_ENTITIES) continue;
    seen.add(key);
    known.push(k);
  }
  const per = Math.max(500, Math.floor((opts.maxChars ?? LLM_EXTRACT_INPUT_CHARS) / Math.max(1, items.length)));
  const docs = items.map((item, i) => [
    `=== Document ${i + 1}: ${item.page.title} (${item.page.path}) ===`,
    `Document date: ${item.docDate ? item.docDate.slice(0, 10) : 'unknown'}`,
    '',
    item.content.slice(0, Math.max(per, EXTRACT_BATCH_DOC_CHARS)),
  ].join('\n'));
  const system = `${extractRules(ontology, withClaims, false)}

This request holds ${items.length} separate documents, each under a line "=== Document n: title (path) ===" with its own date. Extract from each on its own: an entity, relation or claim belongs to the document whose text states it, its dates resolve against that document's date, and the caps apply per document.
Respond with JSON only: {"documents":[{"doc":1, ...${replyShape(withClaims, false).slice(1, -1)}}, {"doc":2, ...}]}: one entry per document, in order, with empty lists for a document that yields nothing.`;
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `${knownEntitiesBlock(known)}${docs.join('\n\n')}` },
    ],
    maxTokens: Math.min(32_000, (withClaims ? 4_000 : 3_000) * items.length + 4_000),
    withClaims,
    askSubject: false,
  };
}

/** A batched reply's entry for each document (by its `doc` number, else its position); missing ones are absent. */
export function batchExtractReplies(reply: unknown, count: number): Map<number, RawExtractReply> {
  const out = new Map<number, RawExtractReply>();
  const list = reply && typeof reply === 'object' && Array.isArray((reply as { documents?: unknown }).documents)
    ? (reply as { documents: unknown[] }).documents
    : count === 1 && reply && typeof reply === 'object' ? [reply] : [];
  list.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const n = Number((entry as { doc?: unknown }).doc);
    const at = Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : i;
    if (at < count && !out.has(at)) out.set(at, entry as RawExtractReply);
  });
  return out;
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
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const request = buildExtractRequest(page, content, opts);
  const reply = await llm.completeJson<RawExtractReply>(request.messages, { maxTokens: request.maxTokens, model: opts.model });
  return parseExtractReply(reply, request);
}

/** Check a reply against what was asked: drop malformed items, cap claims, read the subject. */
export function parseExtractReply(result: RawExtractReply, request: Pick<ExtractRequest, 'withClaims' | 'askSubject'>): ExtractResult {
  const { withClaims, askSubject } = request;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('extraction reply is not a JSON object');
  // a field that is not a list is treated as empty: the reply may come from another machine
  const list = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);
  const out: ExtractResult = {
    entities: list(result.entities)
      .filter((e) => e && typeof e.name === 'string' && e.name.trim())
      .map((e) => ({ ...e, aliases: list(e.aliases).filter((a) => typeof a === 'string'), sameAs: typeof e.sameAs === 'string' && e.sameAs.trim() ? e.sameAs.trim() : null })),
    relations: list(result.relations).filter((r) => r && typeof r.source === 'string' && r.source && typeof r.target === 'string' && r.target),
    // the type and kind come back on the closed lists whatever the model wrote (unknown type → other, unknown kind → fact)
    claims: withClaims
      ? list(result.claims)
          .filter((c) => c && typeof c.subject === 'string' && c.subject.trim() && typeof c.statement === 'string' && c.statement.trim())
          .slice(0, EXTRACT_CAPS.claims)
          .map((c) => ({
            ...c,
            type: normalizeClaimType(c.type),
            kind: normalizeClaimKind(c.kind),
            attribute: typeof c.attribute === 'string' && c.attribute.trim() ? c.attribute.trim() : null,
            value: typeof c.value === 'number' && Number.isFinite(c.value) ? c.value : typeof c.value === 'string' && c.value.trim() ? c.value.trim() : null,
            unit: typeof c.unit === 'string' && c.unit.trim() ? c.unit.trim() : null,
            corrects: c.corrects === true,
          }))
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

  // a person name split by context (src/graph/entity-context.ts) resolves to the person this document's entities point at
  const namesakes = await namesakeRules(w.q, entities.filter((e) => e.type === 'person').map((e) => e.name));

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
    const rules = e.type === 'person' ? namesakes.get(e.name.trim().toLowerCase()) : undefined;
    const variant = rules ? namesakeChoice(rules, entities) : null;
    const id = variant
      ? await w.entity({ ...e, name: `${variant.name}（${variant.label}）`, aliases: [...(e.aliases ?? []), e.name] }, { extractor, segmentId: hits[0]?.id ?? fallback?.id ?? null, id: variant.id })
      : await w.entity(e, { extractor, segmentId: hits[0]?.id ?? fallback?.id ?? null });
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
    // the value it gives of an attribute of its subject (docs/design/29): what the model said, else the statement read
    const measure = claimMeasure(c, c.subject);
    const validFrom = dateStart(c.startDate, ref);
    const eventAt = dateStart(c.eventDate, ref);
    const id = await w.claim(subjectId, {
      objectId,
      // sidecars written before the closed vocabulary carry free-text types: mapped here on replay too
      type: normalizeClaimType(c.type),
      kind: normalizeClaimKind(c.kind),
      statement: c.statement,
      status,
      // dates the way the source wrote them → windows at the stated precision, relative forms anchored on the document date
      validFrom,
      validTo: dateEnd(c.endDate, ref),
      eventAt,
      observedAt: ref,
      // a claim with no date of its own is dated by its document, and says so
      dateSource: eventAt || validFrom ? 'stated' : ref ? 'document' : null,
      attribute: measure?.attribute ?? null,
      valueNum: measure?.valueNum ?? null,
      valueText: measure?.valueText ?? null,
      unit: measure?.unit ?? null,
      correction: c.corrects === true || isCorrectionStatement(c.statement),
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

/** CJK runs, the character classes `match_grams` and `queryTerms` take. */
const CJK_RUN = /[一-鿿㐀-䶿]+/g;

/** Add the bigrams of every CJK run in `lower` to `into`; returns the text with those runs blanked out. */
function cjkBigrams(lower: string, into: Set<string>): string {
  return lower.replace(CJK_RUN, (run) => {
    for (let i = 0; i + 2 <= run.length; i++) into.add(run.slice(i, i + 2));
    return ' ';
  });
}

/** A chunk's lowercased text and CJK bigrams, worked out once however many claims it is scored for. */
const groundingIndex = new WeakMap<ChunkRef, { text: string; bigrams: Set<string> }>();

function groundingIndexOf(c: ChunkRef): { text: string; bigrams: Set<string> } {
  let ix = groundingIndex.get(c);
  if (!ix) {
    const text = c.content.toLowerCase();
    const bigrams = new Set<string>();
    cjkBigrams(text, bigrams);
    groundingIndex.set(c, (ix = { text, bigrams }));
  }
  return ix;
}

/**
 * Ground a claim statement to the chunk sharing most of its words: Latin and
 * number tokens, and the bigrams of its CJK runs. A CJK run carries no spaces,
 * so taken whole it is a clause no chunk repeats verbatim — a statement written
 * in Chinese then matched nothing and fell back to the first chunk.
 */
function bestChunkFor(statement: string, chunks: ChunkRef[]): string | null {
  const bigrams = new Set<string>();
  const words = [...new Set(cjkBigrams(statement.toLowerCase(), bigrams).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2))];
  if ((words.length === 0 && bigrams.size === 0) || chunks.length === 0) return chunks[0]?.id ?? null;
  let best: { id: string; score: number } | null = null;
  for (const c of chunks) {
    const ix = groundingIndexOf(c);
    let score = 0;
    for (const w of words) if (ix.text.includes(w)) score++;
    for (const b of bigrams) if (ix.bigrams.has(b)) score++;
    if (!best || score > best.score) best = { id: c.id, score };
  }
  return best && best.score > 0 ? best.id : chunks[0]?.id ?? null;
}
