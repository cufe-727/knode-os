import crypto from 'node:crypto';
import matter from 'gray-matter';
import { Store } from '../store/db.js';
import { LlmClient } from '../llm/client.js';

/**
 * Knowledge-graph extraction. Two complementary passes (borrowed from gbrain
 * and llm_wiki):
 *
 * 1. Deterministic wiring — every `[[wikilink]]` in a page becomes an entity
 *    reference and a typed edge. Cheap, idempotent, re-runnable, no LLM.
 * 2. Optional LLM pass — extracts named entities + typed relations from raw
 *    document text when an LLM is configured. Entities co-occurring in the
 *    same document also get weak `co_occurs` edges.
 */

export interface ExtractedEntity {
  name: string;
  type: string;
  description?: string;
  aliases?: string[];
}

export interface ExtractedRelation {
  source: string;
  target: string;
  type: string;
  description?: string;
}

export const ENTITY_TYPES = ['person', 'organization', 'product', 'project', 'component', 'technology', 'concept', 'event', 'location', 'other'];
export const RELATION_TYPES = ['related_to', 'part_of', 'uses', 'depends_on', 'works_at', 'authored', 'mentions', 'co_occurs'];

export function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[\s/\\]+/g, '-')
    .replace(/[^\p{L}\p{N}\-_.]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return s || 'entity-' + crypto.createHash('md5').update(name).digest('hex').slice(0, 8);
}

export function relationId(sourceId: string, type: string, targetId: string): string {
  return crypto.createHash('sha256').update(`${sourceId}|${type}|${targetId}`).digest('hex').slice(0, 24);
}

/** Extract `[[Name]]` / `[[Name|label]]` wikilinks from markdown. */
export function extractWikilinks(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    const name = m[1].trim();
    if (name) out.add(name);
  }
  return [...out];
}

export async function upsertEntity(store: Store, e: ExtractedEntity): Promise<string> {
  const id = slugify(e.name);
  const type = ENTITY_TYPES.includes(e.type) ? e.type : 'concept';
  await store.query(
    `INSERT INTO entities (id, name, type, description, aliases)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       type = CASE WHEN entities.type = 'concept' THEN EXCLUDED.type ELSE entities.type END,
       description = CASE WHEN length(EXCLUDED.description) > length(entities.description) THEN EXCLUDED.description ELSE entities.description END,
       aliases = (
         SELECT COALESCE(jsonb_agg(DISTINCT a), '[]'::jsonb)
         FROM jsonb_array_elements_text(entities.aliases || EXCLUDED.aliases) AS a
       ),
       updated_at = now()`,
    [id, e.name.trim(), type, e.description ?? '', JSON.stringify(e.aliases ?? [])],
  );
  return id;
}

export async function upsertRelation(store: Store, sourceId: string, targetId: string, r: { type: string; description?: string; weight?: number; documentId?: string }): Promise<void> {
  if (sourceId === targetId) return;
  const id = relationId(sourceId, r.type, targetId);
  await store.query(
    `INSERT INTO relations (id, source_id, target_id, type, description, weight, document_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       weight = relations.weight + $6,
       description = CASE WHEN length(EXCLUDED.description) > length(relations.description) THEN EXCLUDED.description ELSE relations.description END`,
    [id, sourceId, targetId, r.type, r.description ?? '', r.weight ?? 1.0, r.documentId ?? null],
  );
}

export async function recordMention(store: Store, entityId: string, chunkId: string, documentId: string): Promise<void> {
  const inserted = await store.query<{ entity_id: string }>(
    `INSERT INTO entity_mentions (entity_id, chunk_id, document_id) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING RETURNING entity_id`,
    [entityId, chunkId, documentId],
  );
  if (inserted.length > 0) {
    await store.query(`UPDATE entities SET mention_count = mention_count + 1 WHERE id = $1`, [entityId]);
  }
}

/** Remove graph facts derived from a document (used on re-ingest). */
export async function clearDocumentGraph(store: Store, documentId: string): Promise<void> {
  const rows = await store.query<{ entity_id: string; n: number }>(
    `SELECT entity_id, count(*)::int AS n FROM entity_mentions WHERE document_id = $1 GROUP BY entity_id`,
    [documentId],
  );
  await store.query(`DELETE FROM entity_mentions WHERE document_id = $1`, [documentId]);
  for (const r of rows) {
    await store.query(`UPDATE entities SET mention_count = greatest(0, mention_count - $2) WHERE id = $1`, [r.entity_id, r.n]);
  }
  await store.query(`DELETE FROM relations WHERE document_id = $1`, [documentId]);
}

interface PageContext {
  documentId: string;
  path: string;
  title: string;
  chunkIds: { id: string; content: string }[];
}

/**
 * Pass 1 — deterministic wiring from wikilinks and frontmatter. A wiki page
 * under wiki/entities/ or wiki/concepts/ IS an entity (path encodes its type,
 * as in gbrain schema packs); links between pages become `mentions` edges.
 */
export async function wireFromMarkdown(store: Store, page: PageContext, rawContent: string): Promise<{ entities: number; relations: number }> {
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(rawContent);
  } catch {
    parsed = matter(''); // malformed frontmatter — treat body as plain content
    parsed.content = rawContent;
  }
  const fm = parsed.data as Record<string, unknown>;
  let stats = { entities: 0, relations: 0 };

  // The page itself as an entity when it lives in a typed wiki directory.
  let selfId: string | null = null;
  const typed = page.path.match(/^wiki\/(entities|concepts)\//);
  if (typed) {
    const selfType = typed[1] === 'entities' ? (typeof fm.type === 'string' ? fm.type : 'concept') : 'concept';
    const name = typeof fm.title === 'string' ? fm.title : page.title;
    const aliases = Array.isArray(fm.aliases) ? fm.aliases.map(String) : [];
    selfId = await upsertEntity(store, { name, type: selfType, description: firstParagraph(parsed.content), aliases });
    await store.query(`UPDATE entities SET wiki_path = $2 WHERE id = $1`, [selfId, page.path]);
    stats.entities++;
  }

  const links = extractWikilinks(parsed.content);
  for (const linkName of links) {
    const targetId = await upsertEntity(store, { name: linkName, type: 'concept' });
    stats.entities++;
    const holder = page.chunkIds.find((c) => c.content.includes(`[[${linkName}`)) ?? page.chunkIds[0];
    if (holder) await recordMention(store, targetId, holder.id, page.documentId);
    if (selfId) {
      await upsertRelation(store, selfId, targetId, { type: 'mentions', documentId: page.documentId });
      stats.relations++;
    }
  }

  // Pages sharing a source: weak co-occurrence edges between all linked entities.
  const linkIds = await Promise.all(links.map((l) => slugify(l)));
  for (let i = 0; i < linkIds.length; i++) {
    for (let j = i + 1; j < linkIds.length && j < i + 12; j++) {
      await upsertRelation(store, linkIds[i], linkIds[j], { type: 'co_occurs', weight: 0.3, documentId: page.documentId });
      stats.relations++;
    }
  }
  return stats;
}

const EXTRACT_SYSTEM = `You are a knowledge-graph extraction engine. Extract the most important named entities and the relations between them from the document.

Rules:
- Entity types: ${ENTITY_TYPES.join(', ')}.
- Relation types: ${RELATION_TYPES.filter((t) => t !== 'co_occurs').join(', ')}.
- Only entities that matter to the document's topic; max 15 entities, max 20 relations.
- Keep names short and canonical (e.g. "PostgreSQL", not "the PostgreSQL database").
- description: one sentence, factual, in the document's language.
Respond with JSON only: {"entities":[{"name","type","description","aliases":[]}],"relations":[{"source","target","type","description"}]}`;

/**
 * Pass 2 — LLM extraction over a document's text. Mentions are attached to the
 * chunks where each entity name (or alias) appears.
 */
export async function extractWithLlm(
  store: Store,
  llm: LlmClient,
  page: PageContext,
  content: string,
): Promise<{ entities: number; relations: number }> {
  const body = content.slice(0, 12_000);
  const result = await llm.completeJson<{ entities?: ExtractedEntity[]; relations?: ExtractedRelation[] }>([
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content: `Document: ${page.title} (${page.path})\n\n${body}` },
  ], { maxTokens: 2000 });

  const entities = (result.entities ?? []).filter((e) => e && typeof e.name === 'string' && e.name.trim());
  const relations = (result.relations ?? []).filter((r) => r && r.source && r.target);
  const idByName = new Map<string, string>();

  for (const e of entities) {
    const id = await upsertEntity(store, e);
    idByName.set(e.name.toLowerCase(), id);
    for (const a of e.aliases ?? []) idByName.set(a.toLowerCase(), id);
    const needles = [e.name, ...(e.aliases ?? [])].map((s) => s.toLowerCase());
    const hits = page.chunkIds.filter((c) => {
      const lc = c.content.toLowerCase();
      return needles.some((n) => n && lc.includes(n));
    });
    for (const h of hits.slice(0, 8)) await recordMention(store, id, h.id, page.documentId);
    if (hits.length === 0 && page.chunkIds[0]) await recordMention(store, id, page.chunkIds[0].id, page.documentId);
  }

  let relCount = 0;
  for (const r of relations) {
    const sourceId = idByName.get(r.source.toLowerCase()) ?? (await upsertEntity(store, { name: r.source, type: 'concept' }));
    const targetId = idByName.get(r.target.toLowerCase()) ?? (await upsertEntity(store, { name: r.target, type: 'concept' }));
    const type = RELATION_TYPES.includes(r.type) ? r.type : 'related_to';
    await upsertRelation(store, sourceId, targetId, { type, description: r.description, documentId: page.documentId });
    relCount++;
  }

  // weak co-occurrence between extracted entities of the same document
  const ids = [...new Set(idByName.values())];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length && j < i + 8; j++) {
      await upsertRelation(store, ids[i], ids[j], { type: 'co_occurs', weight: 0.2, documentId: page.documentId });
    }
  }
  return { entities: entities.length, relations: relCount };
}

function firstParagraph(md: string): string {
  for (const block of md.split(/\n\s*\n/)) {
    const t = block.replace(/^#+\s.*$/gm, '').replace(/\s+/g, ' ').trim();
    if (t.length > 20) return t.slice(0, 300);
  }
  return '';
}
