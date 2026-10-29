import { Store } from '../store/db.js';
import { buildLinkIndex, CONCEPT_EXTRACTOR, findLinks, linkCandidatesFor, tier0Known } from './concepts.js';
import { canonicalMap } from './resolve.js';

/**
 * The entities a Markdown view marks in the text it shows: where the text
 * names a known entity, so a reader can open what the graph holds about it.
 *
 * Two lists feed it. The tier-0 link index (concepts.ts) holds the hottest
 * typed entities with every spelling that may link on its own (weakLinkKey),
 * and is matched the way sync links mentions: Latin names as whole words,
 * CJK names inside a run, the longest name winning where two overlap. And
 * the entities the document itself was indexed with (its wikilinks, declared
 * names and extraction) join whatever their type, since the graph already
 * says the document is about them.
 *
 * Linking for the graph and marking for a reader want different things.
 * Sync links a corpus's frequent names on purpose (that is how a hub gets
 * its edges), but a reader gains nothing from 市场 or 板块 underlined on
 * every line, and an extractor's stray entity named "2020" or "ti" should
 * not light up every year and syllable. So a mark needs a name that is not
 * one of the corpus's frequent terms, not a number or a scrap of Latin, and
 * an entity of a kind a reader would look up. An entity with a wiki page,
 * or one the document declares itself (a wikilink, its frontmatter, a
 * person's own prose), is marked whatever its kind or however frequent its
 * name; a spelling weakLinkKey refuses links nothing, here as in sync.
 *
 * The answer names each entity once, with the spellings the text uses for
 * it: the view finds those in what it renders, which is not the source text
 * (the Markdown syntax is gone), so offsets would not survive the trip.
 */

export interface DocumentMention {
  id: string;
  name: string;
  type: string;
  wikiPath: string | null;
  /** The spellings the text uses, as written there, longest first. */
  surfaces: string[];
  /** How often the text names it. */
  count: number;
}

export interface DocumentMentions {
  mentions: DocumentMention[];
}

/** Text past this many characters is not read: a view highlights what a person reads, and the largest editable file is 4 MB. */
export const MENTION_TEXT_CHARS = 400_000;
/** Entities answered at most, in the order the text first names them. */
export const MENTION_LIMIT = 400;

/** The kinds of entity a reader opens a panel for. Datasets, datasources, events and "other" are where extraction leaves its generic words. */
export const MARKED_TYPES = new Set(['organization', 'person', 'product', 'location', 'technology', 'project', 'component']);

/** Extractors that mean the author named the entity: wikilinks, frontmatter, a mind map's node, a person's prose on a generated page. */
const DECLARING_EXTRACTORS = ['tier0.wikilink', 'tier0.frontmatter', 'tier0.mindmap', 'human'];

/** The YAML block at the top of a Markdown file: the views fold it away, so its names are not marked. */
const FRONTMATTER_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** A spelling that is a number, a date or a scrap of Latin (`2020`, `11`, `ti`): never a name worth marking on its own. */
function unmarkable(surface: string): boolean {
  if (/^[\d\s.,:%+\-/]+$/.test(surface)) return true;
  return /^[\x00-\x7f]+$/.test(surface) && surface.replace(/[^A-Za-z]/g, '').length < 3;
}

export async function documentMentions(store: Store, text: string, opts: { path?: string } = {}): Promise<DocumentMentions> {
  const body = text.replace(FRONTMATTER_RE, '').slice(0, MENTION_TEXT_CHARS);
  if (!body.trim()) return { mentions: [] };
  const known = await tier0Known(store);
  const path = opts.path?.replace(/\\/g, '/').replace(/^\/+/, '') || null;
  const own = path ? await indexedWith(store, path) : { indexed: [], declared: new Set<string>() };
  const extra = own.indexed.length ? buildLinkIndex(await linkCandidatesFor(store, store.dataDir, own.indexed), known.linkStop, known.stop) : undefined;
  // a page bound to an entity is that entity's own page: marking its subject on every line says nothing
  const subjects = new Set(path
    ? (await store.query<{ id: string }>(`SELECT id FROM entities WHERE wiki_path = $1 AND tx_to IS NULL`, [path])).map((r) => r.id)
    : []);

  const spans = findLinks(body, known.index, extra).filter((span) => span.candidate.id && !subjects.has(span.candidate.id));
  const ids = [...new Set(spans.map((span) => span.candidate.id!))];
  const wiki = new Map(ids.length
    ? (await store.query<{ id: string; wiki_path: string | null }>(`SELECT id, wiki_path FROM entities WHERE id = ANY($1::text[])`, [ids])).map((r) => [r.id, r.wiki_path])
    : []);

  const found = new Map<string, { name: string; type: string; first: number; count: number; surfaces: Map<string, number> }>();
  for (const span of spans) {
    const { id, name, type } = span.candidate as { id: string; name: string; type: string };
    const surface = body.slice(span.start, span.end);
    const vouched = Boolean(wiki.get(id)) || own.declared.has(id);
    if (!vouched && (!MARKED_TYPES.has(type) || known.stop.has(span.key) || unmarkable(surface))) continue;
    const hit = found.get(id) ?? found.set(id, { name, type, first: span.start, count: 0, surfaces: new Map() }).get(id)!;
    hit.count++;
    hit.surfaces.set(surface, (hit.surfaces.get(surface) ?? 0) + 1);
  }
  const mentions = [...found.entries()]
    .sort((a, b) => a[1].first - b[1].first)
    .slice(0, MENTION_LIMIT)
    .map(([id, m]) => ({
      id,
      name: m.name,
      type: m.type,
      wikiPath: wiki.get(id) ?? null,
      surfaces: [...m.surfaces.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b)),
      count: m.count,
    }));
  return { mentions };
}

/**
 * The live entities a document was indexed with, merged ones answering as
 * their survivor, and which of them it declares itself. A concept only the
 * miner found here is left out: mining keeps a document's frequent terms,
 * which are often ordinary words.
 */
async function indexedWith(store: Store, path: string): Promise<{ indexed: string[]; declared: Set<string> }> {
  const rows = await store.query<{ entity_id: string; extractor: string }>(
    `SELECT DISTINCT ev.target_id AS entity_id, ev.extractor
     FROM evidence ev JOIN scopes s ON s.id = ev.scope_id
     WHERE s.key = $1 AND ev.kind = 'entity' AND ev.tx_to IS NULL AND ev.extractor <> $2`,
    [path, CONCEPT_EXTRACTOR],
  );
  const canon = await canonicalMap(store, rows.map((r) => r.entity_id));
  const c = (id: string) => canon.get(id) ?? id;
  return {
    indexed: [...new Set(rows.map((r) => c(r.entity_id)))],
    declared: new Set(rows.filter((r) => DECLARING_EXTRACTORS.includes(r.extractor)).map((r) => c(r.entity_id))),
  };
}
