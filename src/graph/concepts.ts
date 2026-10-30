import { foldTouched } from '../lineage/fold.js';
import { foldOptions } from '../lineage/scope.js';
import { lockLedger } from '../lineage/ledger.js';
import { emptyTouched, ScopeRow } from '../lineage/types.js';
import { ScopeWriter } from '../lineage/writer.js';
import { loadSourceText } from '../ingest/source.js';
import { ParsedMarkdown, parseFrontmatter, titleFromMarkdown } from '../markdown.js';
import { Store } from '../store/db.js';
import { Queryable } from '../store/migrations.js';
import {
  CJK_FUNCTION_CHARS,
  EN_STOP,
  FREQUENT_MIN_CORPUS,
  FREQUENT_RELEARN_MS,
  FrequentTerms,
  frequentStamp,
  frequentThreshold,
  indexedDocumentCount,
  readConceptStoplist,
  readFrequentTerms,
  stopKeySet,
  stoplistStamp,
  writeFrequentTerms,
} from './concept-stoplist.js';
import type { TrustTier } from '../lineage/trust.js';
import { wikilinkName } from './frontmatter.js';
import { keyOf, mentionKeys } from './normalize.js';
import { loadOntology } from './ontology.js';
import { resolutionMode } from './resolve.js';
import { PageContext } from './store.js';

/**
 * Tier-0 graph evidence: zero-LLM, synchronous with ingest, for every source
 * document. The boundary with tier-1 (src/graph/tier1.ts) is:
 *
 *   tier-0 links what the graph already knows; tier-1 discovers and types
 *   new things.
 *
 * Two steps, in order:
 *
 *   1. **Linking.** The document body is matched against the live typed
 *      entities (anything but `concept`) by every spelling the graph knows
 *      for them — names, aliases and the names of entities merged into them,
 *      via entity_alias_keys — plus the author its frontmatter declares in
 *      `source:`. Latin spellings match whole words, CJK spellings match as
 *      substrings. One mention is enough. A spelling that would link on its
 *      own in any text is no surface (weakLinkKey): a number of fewer than
 *      five digits, a one- or two-letter Latin spelling, a stop word, or — as
 *      an alias — a corpus-frequent word. A link writes `tier0.link` evidence
 *      and chunk mentions on the existing entity, never a new node, and the
 *      matched text is masked before mining so no fragment of a known name
 *      can become a concept. `relinkTier0` recomputes every document's links
 *      after the surfaces changed.
 *   2. **Mining.** What is left is mined for a few topical terms: Latin
 *      proper-noun phrases, acronyms and code identifiers, and CJK words as
 *      `Intl.Segmenter` cuts them (a run of characters the segmenter does not
 *      know is kept together as one term). Exporter template text is stripped
 *      first, every occurrence is counted once, the per-document cap follows
 *      the text length, and terms the stop list names — built-in, edited by a
 *      person, or learned from the corpus's own text (learnFrequentTerms,
 *      src/graph/concept-stoplist.ts) — are dropped. The survivors become
 *      `concept` placeholders with `tier0.concept` evidence; their co-occurrence
 *      with the document's other entities is derived from the mentions on read
 *      (cooccur.ts), never stored as edges.
 *
 * Placeholders are provisional: once tier-1 has read the document, the ones
 * that did not resolve to a typed entity are retired (retireTier0Placeholders)
 * while the sidecar keeps the mined list for history rebuilds.
 */

export const CONCEPT_EXTRACTOR = 'tier0.concept';
export const LINK_EXTRACTOR = 'tier0.link';

/* ───────────────────────────── template text ───────────────────────────── */

export interface TemplateHints {
  /** Frontmatter `source:` (an exporter's author field): headings repeating it carry no content. */
  source?: string | null;
  /** The document title: a heading that repeats it carries no content either. */
  title?: string | null;
}

/**
 * The text worth mining: code, HTML, images, URLs and exporter boilerplate
 * removed — attachment lines such as `- image: 附件 (https://…)`, figure
 * placeholders, and headings that only repeat the frontmatter's author or the
 * document title (a digest's `## 13:11 · author` entry headings).
 */
export function stripTemplate(body: string, hints: TemplateHints = {}): string {
  let text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^<>\n]{1,300}>/g, ' ')
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^[ \t]*[-*+][ \t]*image:[^\n]*$/gim, ' ')
    .replace(/\[图\s*\d*\]/g, ' ');
  const names = [hints.source, hints.title]
    .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    .map((n) => n.trim());
  if (names.length > 0) {
    text = text.replace(/^[ \t]*#{1,6}[ \t]+[^\n]*$/gm, (line) => (names.some((n) => line.includes(n)) ? ' ' : line));
  }
  return text;
}

/* ────────────────────────────── mining ─────────────────────────────── */

export type ConceptKind = 'latin' | 'acronym' | 'code' | 'cjk' | 'cjk-run';

export interface ConceptCandidate {
  term: string;
  /** Occurrences in the text; every span is counted by exactly one rule. */
  count: number;
  kind: ConceptKind;
}

/** Backtick identifiers, then runs of Capitalized words (an all-caps word is an acronym). One pass, so a span is counted once. */
const LATIN_RE = /`([A-Za-z][\w./-]{2,40})`|\b([A-Z][a-zA-Z0-9]+(?:[ -][A-Z][a-zA-Z0-9]+){0,3})\b/g;
const ACRONYM_RE = /^[A-Z0-9]{2,8}$/;

/** Words a Capitalized phrase may start or end with that are not part of the name ("The Fed", "Tesla Today"). */
const PHRASE_EDGE_STOP = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'and', 'or', 'but', 'for', 'with', 'from', 'into', 'over', 'about',
  'after', 'before', 'between', 'when', 'what', 'which', 'while', 'then', 'than', 'also', 'here', 'there', 'however',
  'although', 'because', 'since', 'today', 'yesterday', 'tomorrow', 'meanwhile', 'finally', 'overall', 'instead', 'perhaps',
  'maybe', 'according', 'in', 'on', 'at', 'to', 'of', 'by', 'as', 'is', 'it', 'if', 'so', 'no', 'not', 'yes', 'he', 'she',
  'we', 'you', 'they', 'my', 'our', 'your', 'his', 'her', 'its', 'their',
]);

const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });
const HAN_RE = /\p{Script=Han}/u;
const ALL_HAN_RE = /^\p{Script=Han}+$/u;
/** Longest run of segmenter-unknown characters kept as one term; longer runs are garbage, not names. */
const MAX_RUN = 6;

/** Tickers and codes: more digits than letters. Identifiers of entities, not concepts. */
function digitsHeavy(term: string): boolean {
  const digits = (term.match(/\d/g) ?? []).length;
  return digits * 2 >= term.replace(/[^A-Za-z0-9]/g, '').length;
}

function trimPhrase(phrase: string): string {
  let term = phrase;
  for (;;) {
    const lead = /^([A-Za-z0-9]+)[ -]/.exec(term);
    if (!lead || !PHRASE_EDGE_STOP.has(lead[1].toLowerCase())) break;
    term = term.slice(lead[0].length);
  }
  for (;;) {
    const tail = /[ -]([A-Za-z0-9]+)$/.exec(term);
    if (!tail || !PHRASE_EDGE_STOP.has(tail[1].toLowerCase())) break;
    term = term.slice(0, -tail[0].length);
  }
  return term;
}

/**
 * Every candidate term in the text with its occurrence count. Deterministic,
 * no LLM. Terms are merged by normalized key, so "Tesla" and "TESLA" are one
 * candidate shown under its most frequent spelling.
 */
export function conceptCandidates(text: string): ConceptCandidate[] {
  const byKey = new Map<string, { count: number; kind: ConceptKind; spellings: Map<string, number> }>();
  const bump = (term: string, kind: ConceptKind) => {
    const k = keyOf(term);
    if (k.length < 2) return;
    let e = byKey.get(k);
    if (!e) byKey.set(k, (e = { count: 0, kind, spellings: new Map() }));
    e.count++;
    e.spellings.set(term, (e.spellings.get(term) ?? 0) + 1);
    // a segmenter word outranks a run of unknown characters with the same spelling
    if (kind === 'cjk' && e.kind === 'cjk-run') e.kind = 'cjk';
  };

  // 1. Latin: one pass, each span counted by one rule
  for (const m of text.matchAll(LATIN_RE)) {
    if (m[1]) {
      bump(m[1], 'code');
      continue;
    }
    const term = trimPhrase(m[2]);
    if (term.length < 2 || digitsHeavy(term)) continue;
    const single = !/[ -]/.test(term);
    if (single && EN_STOP.has(term.toLowerCase())) continue;
    bump(term, single && ACRONYM_RE.test(term) ? 'acronym' : 'latin');
  }

  // 2. CJK: words as the segmenter cuts them; consecutive characters it does
  //    not know (a name, a transliteration, an abbreviation) stay one term
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 2 && run.length <= MAX_RUN) bump(run.join(''), 'cjk-run');
    run = [];
  };
  for (const seg of SEGMENTER.segment(text)) {
    const s = seg.segment;
    if (!seg.isWordLike || !ALL_HAN_RE.test(s)) {
      flush();
      continue;
    }
    if (s.length === 1) {
      if (CJK_FUNCTION_CHARS.has(s)) flush();
      else run.push(s);
      continue;
    }
    flush();
    bump(s, 'cjk');
  }
  flush();

  return [...byKey.values()].map((e) => ({
    term: [...e.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
    count: e.count,
    kind: e.kind,
  }));
}

/** One concept per this many characters of text … */
export const CAP_CHARS_PER_CONCEPT = 400;
/** … but never fewer than this many … */
export const CAP_MIN = 3;
/** … nor more than this many per document. */
export const CAP_MAX = 24;

/** How many concepts a document of `chars` characters may contribute. */
export function conceptCap(chars: number): number {
  return Math.min(CAP_MAX, Math.max(CAP_MIN, Math.round(chars / CAP_CHARS_PER_CONCEPT)));
}

/** A term seen once is kept only when its shape alone makes it specific. */
function qualifies(c: ConceptCandidate): boolean {
  if (c.count >= 2) return true;
  switch (c.kind) {
    case 'acronym':
    case 'code':
      return c.term.length >= 3;
    case 'latin':
      return /[ -]/.test(c.term) && c.term.length >= 6;
    case 'cjk':
      return c.term.length >= 3;
    default:
      return false;
  }
}

/** Among equally frequent terms: explicit identifiers first, segmenter words and phrases next, runs of unknown characters last. */
const KIND_RANK: Record<ConceptKind, number> = { acronym: 0, code: 0, latin: 1, cjk: 1, 'cjk-run': 2 };

let builtinStop: Set<string> | null = null;
function builtinStopKeys(): Set<string> {
  builtinStop ??= stopKeySet({ terms: [], allow: [] }, null);
  return builtinStop;
}

export interface SelectOptions {
  /** Normalized stop keys (src/graph/concept-stoplist.ts); the built-in lists alone when absent. */
  stop?: Set<string>;
  /** Text length the cap is computed from. */
  chars: number;
}

/** The terms a document contributes: stop words dropped, specific-enough singles kept, ranked by count, capped by length. */
export function selectConcepts(candidates: ConceptCandidate[], opts: SelectOptions): string[] {
  const stop = opts.stop ?? builtinStopKeys();
  return candidates
    .filter((c) => !stop.has(keyOf(c.term)) && qualifies(c))
    .sort((a, b) => b.count - a.count || KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.term.length - a.term.length || a.term.localeCompare(b.term))
    .slice(0, conceptCap(opts.chars))
    .map((c) => c.term);
}

/** Extract concept terms from (template-stripped, link-masked) text. Deterministic, no LLM. */
export function extractConcepts(text: string, opts: { stop?: Set<string>; chars?: number } = {}): string[] {
  return selectConcepts(conceptCandidates(text), { stop: opts.stop, chars: opts.chars ?? text.length });
}

/* ─────────────────────────── known entities ─────────────────────────── */

export interface LinkCandidate {
  /** Entity id; null for a name that is only kept out of the miner's way (a declared name the graph has no typed entity for). */
  id: string | null;
  name: string;
  type: string;
  /** Normalized lookup keys (entity_alias_keys / normalize.ts). */
  keys: string[];
  /** The entity's aliases as written, for the extraction prompt (knownEntitiesIn). */
  aliases?: string[];
  /** Folded mention count: the order the prompt lists known entities in. */
  mentions?: number;
}

export interface LinkIndex {
  byKey: Map<string, LinkCandidate>;
  /** Every proper prefix of every key, so matching stops as soon as no key can follow. */
  prefixes: Set<string>;
  maxChars: number;
}

const MAX_KEY_CHARS = 32;
/** Latin words of one name may be separated by this much (a space, a hyphen, "C. A. T. L"). CJK keys match without gaps. */
const LATIN_GAP = 2;
const GAP_RE = /^[\s\-.·'’&]*$/;

/** A number of fewer than this many digits is a date, a count or a price before it is a ticker. */
const MIN_NUMERIC_KEY = 5;
/** A Latin spelling shorter than this is an abbreviation that turns up in any text. */
const MIN_LATIN_KEY = 3;
const DIGITS_RE = /^\d+$/;
const ASCII_KEY_RE = /^[a-z0-9]+$/;

/**
 * A spelling that must not link a document on its own, whatever entity it
 * belongs to: a number of fewer than five digits ("11" sits in every
 * `11-24 11:18` heading and linked a phone to seven thousand documents), a
 * one- or two-letter Latin spelling (an abbreviation found inside any text),
 * a term the stop list names, and — for an alias, never for the entity's own
 * name — a term the corpus-frequent list names: an ordinary word the
 * extractor reported as "another spelling" (市场, 指数, 大盘 for A股) would
 * pull every document onto one entity, while a frequent *name* is that
 * corpus's hub and linking it is the point.
 */
export function weakLinkKey(key: string, opts: { isName: boolean; stop?: ReadonlySet<string>; aliasStop?: ReadonlySet<string> }): boolean {
  if (DIGITS_RE.test(key)) return key.length < MIN_NUMERIC_KEY;
  if (ASCII_KEY_RE.test(key) && key.length < MIN_LATIN_KEY) return true;
  if (opts.stop?.has(key)) return true;
  return !opts.isName && Boolean(opts.aliasStop?.has(key));
}

export function buildLinkIndex(candidates: LinkCandidate[], stop?: ReadonlySet<string>, aliasStop?: ReadonlySet<string>): LinkIndex {
  const byKey = new Map<string, LinkCandidate>();
  const prefixes = new Set<string>();
  let maxChars = 0;
  for (const c of candidates) {
    const nameKey = keyOf(c.name);
    for (const k of c.keys) {
      if (k.length < 2 || k.length > MAX_KEY_CHARS || byKey.has(k)) continue;
      if (weakLinkKey(k, { isName: k === nameKey, stop, aliasStop })) continue;
      byKey.set(k, c);
      if (k.length > maxChars) maxChars = k.length;
      for (let i = 1; i < k.length; i++) prefixes.add(k.slice(0, i));
    }
  }
  return { byKey, prefixes, maxChars };
}

export interface LinkSpan {
  start: number;
  end: number;
  key: string;
  candidate: LinkCandidate;
}

interface Unit {
  key: string;
  start: number;
  end: number;
  han: boolean;
}

/** A Han character, or a run of other letters and digits: the atoms a key is matched from (NFKC-folded per atom, offsets kept). */
const UNIT_RE = /\p{Script=Han}|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu;

function unitsOf(text: string): Unit[] {
  const out: Unit[] = [];
  for (const m of text.matchAll(UNIT_RE)) {
    const raw = m[0];
    const key = keyOf(raw);
    if (!key) continue;
    out.push({ key, start: m.index!, end: m.index! + raw.length, han: HAN_RE.test(raw) });
  }
  return out;
}

/**
 * Every place a known spelling occurs in the text. Latin spellings match whole
 * words (a name of several words may be split by a space or a hyphen), CJK
 * spellings match as substrings of a run. Where spans overlap the longest wins.
 */
export function findLinks(text: string, index: LinkIndex, extra?: LinkIndex): LinkSpan[] {
  const indexes = extra ? [index, extra] : [index];
  const maxChars = Math.max(...indexes.map((ix) => ix.maxChars));
  if (maxChars === 0) return [];
  const units = unitsOf(text);
  const found: LinkSpan[] = [];
  for (let i = 0; i < units.length; i++) {
    let acc = '';
    for (let j = i; j < units.length; j++) {
      const u = units[j];
      if (j > i) {
        const prev = units[j - 1];
        const gap = u.start - prev.end;
        if (gap > 0 && (u.han || prev.han || gap > LATIN_GAP || !GAP_RE.test(text.slice(prev.end, u.start)))) break;
      }
      acc += u.key;
      if (acc.length > maxChars) break;
      let alive = false;
      for (const ix of indexes) {
        const hit = ix.byKey.get(acc);
        if (hit) found.push({ start: units[i].start, end: u.end, key: acc, candidate: hit });
        if (ix.prefixes.has(acc)) alive = true;
      }
      if (!alive) break;
    }
  }
  found.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const taken: LinkSpan[] = [];
  for (const s of found) if (!taken.some((t) => s.start < t.end && t.start < s.end)) taken.push(s);
  return taken.sort((a, b) => a.start - b.start);
}

/** The text with the given spans blanked (same length, so offsets stay valid). */
export function maskSpans(text: string, spans: { start: number; end: number }[]): string {
  if (spans.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.start < cursor) continue;
    out += text.slice(cursor, s.start) + ' '.repeat(s.end - s.start);
    cursor = s.end;
  }
  return out + text.slice(cursor);
}

/** Hottest typed entities offered as link targets; the long tail of once-seen entities is left to tier-1. */
export const LINK_CANDIDATE_LIMIT = 10_000;

interface CandidateRow {
  id: string;
  name: string;
  type: string;
  aliases: unknown;
  mention_count: number;
  alias_key: string;
  kind: string;
}

/** A two-character spelling the segmenter knows as a word (老大, 老板): too generic to pull every document onto one person. */
function isDictionaryWord(s: string): boolean {
  const segs = [...SEGMENTER.segment(s)].filter((x) => x.isWordLike);
  return segs.length === 1 && segs[0].segment === s;
}

function groupCandidates(rows: CandidateRow[], mode: 'exact' | 'suffix'): LinkCandidate[] {
  const out = new Map<string, LinkCandidate>();
  for (const r of rows) {
    if (mode === 'exact' && r.kind !== 'exact') continue;
    let c = out.get(r.id);
    if (!c) {
      const aliases = Array.isArray(r.aliases) ? r.aliases.map(String) : [];
      out.set(r.id, (c = { id: r.id, name: r.name, type: r.type, keys: [], aliases, mentions: Number(r.mention_count) || 0 }));
    }
    // a person's nickname that is also an ordinary word (老大) links nothing; the person's own name always does
    if (r.type === 'person' && r.alias_key.length <= 2 && r.alias_key !== keyOf(r.name) && HAN_RE.test(r.alias_key) && isDictionaryWord(r.alias_key)) continue;
    c.keys.push(r.alias_key);
  }
  return [...out.values()];
}

/** Live typed entities with every spelling they answer to, hottest first. */
export async function loadLinkCandidates(q: Queryable, dataDir: string, limit = LINK_CANDIDATE_LIMIT): Promise<LinkCandidate[]> {
  const rows = await q.query<CandidateRow>(
    `SELECT e.id, e.name, e.type, e.aliases, e.mention_count, k.alias_key, k.kind
     FROM (SELECT id, name, type, aliases, mention_count FROM entities
           WHERE tx_to IS NULL AND type <> 'concept' AND canonical_id IS NULL
           ORDER BY mention_count DESC, id LIMIT $1) e
     JOIN entity_alias_keys k ON k.entity_id = e.id
     ORDER BY e.mention_count DESC, e.id, k.alias_key`,
    [limit],
  );
  return groupCandidates(rows, resolutionMode(dataDir));
}

/** Live typed entities answering to any of the given spellings (a document's declared names), hottest first. */
export async function typedEntitiesNamed(q: Queryable, dataDir: string, names: string[]): Promise<LinkCandidate[]> {
  const mode = resolutionMode(dataDir);
  const keys = new Set<string>();
  for (const n of names) for (const k of mentionKeys(n, [], mode)) keys.add(k);
  if (keys.size === 0) return [];
  const list = [...keys];
  const ph = list.map((_, i) => `$${i + 1}`).join(',');
  const rows = await q.query<CandidateRow>(
    `SELECT e.id, e.name, e.type, e.aliases, e.mention_count, k.alias_key, k.kind
     FROM entity_alias_keys k JOIN entities e ON e.id = k.entity_id
     WHERE k.alias_key IN (${ph}) AND e.tx_to IS NULL AND e.type <> 'concept' AND e.canonical_id IS NULL
     ORDER BY e.mention_count DESC, e.id, k.alias_key`,
    list,
  );
  return groupCandidates(rows, mode);
}

/** Live entities of any type with these ids, with every spelling they answer to (what a document was indexed with), hottest first. */
export async function linkCandidatesFor(q: Queryable, dataDir: string, ids: string[]): Promise<LinkCandidate[]> {
  if (ids.length === 0) return [];
  const rows = await q.query<CandidateRow>(
    `SELECT e.id, e.name, e.type, k.alias_key, k.kind
     FROM entity_alias_keys k JOIN entities e ON e.id = k.entity_id
     WHERE e.id = ANY($1::text[]) AND e.tx_to IS NULL AND e.canonical_id IS NULL
     ORDER BY e.mention_count DESC, e.id, k.alias_key`,
    [ids],
  );
  return groupCandidates(rows, resolutionMode(dataDir));
}

/* ───────────────────── per-workspace cache of the known ───────────────────── */

export interface Tier0Known {
  index: LinkIndex;
  stop: Set<string>;
  /**
   * The generic words alone, which no spelling in `index` may be (`stop` adds
   * the corpus-frequent ones, which no alias may be): for another link index
   * built beside it by the same rule.
   */
  linkStop: Set<string>;
}

/** How long a loaded index is trusted before the store is asked whether anything changed. */
const PROBE_MS = 60_000;

interface KnownCache {
  probedAt: number;
  stamp: string;
  rows: LinkCandidate[];
  stopStamp: string;
  stop: Set<string>;
  linkStop: Set<string>;
  index: LinkIndex;
  inflight: Promise<void> | null;
}

const knownCaches = new Map<string, KnownCache>();

function emptyKnownCache(): KnownCache {
  return {
    probedAt: 0,
    stamp: '',
    rows: [],
    stopStamp: '',
    stop: builtinStopKeys(),
    linkStop: builtinStopKeys(),
    index: buildLinkIndex([]),
    inflight: null,
  };
}

/** Make the next use re-check the store (a sync pass starting, a test that just wrote entities). */
export function invalidateTier0Known(dataDir: string): void {
  const c = knownCaches.get(dataDir);
  if (c) c.probedAt = 0;
}

/**
 * What tier-0 may link to and must not mine, for one workspace: the index of
 * typed entities and the merged stop set. Loaded once and re-checked every
 * PROBE_MS with one cheap query (the typed-entity count and latest change);
 * reloaded only when that changed. The two list files under
 * playbooks/concepts/ are re-read whenever they change on disk.
 */
export async function tier0Known(store: Store, opts: { force?: boolean } = {}): Promise<Tier0Known> {
  let c = knownCaches.get(store.dataDir);
  if (!c) knownCaches.set(store.dataDir, (c = emptyKnownCache()));
  if (opts.force || Date.now() - c.probedAt > PROBE_MS) {
    const cache = c;
    cache.inflight ??= refreshKnown(store, cache, Boolean(opts.force)).finally(() => {
      cache.inflight = null;
    });
    await cache.inflight;
  }
  return { index: c.index, stop: c.stop, linkStop: c.linkStop };
}

async function refreshKnown(store: Store, c: KnownCache, force: boolean): Promise<void> {
  const [probe] = await store.query<{ typed: number; latest: string | Date | null }>(
    `SELECT (SELECT count(*)::int FROM entities WHERE tx_to IS NULL AND type <> 'concept' AND canonical_id IS NULL) AS typed,
            (SELECT max(updated_at) FROM entities WHERE tx_to IS NULL AND type <> 'concept') AS latest`,
  );
  const stamp = `${probe?.typed ?? 0}:${probe?.latest ? new Date(probe.latest).getTime() : 0}`;
  let rowsChanged = false;
  if (force || stamp !== c.stamp) {
    c.rows = await loadLinkCandidates(store, store.dataDir);
    c.stamp = stamp;
    rowsChanged = true;
  }
  const stopStamp = `${stoplistStamp(store.dataDir)}|${frequentStamp(store.dataDir)}`;
  if (rowsChanged || stopStamp !== c.stopStamp) {
    const editable = readConceptStoplist(store.dataDir);
    c.stop = stopKeySet(editable, readFrequentTerms(store.dataDir));
    // a name skips the generic words only: a name frequent in this corpus is
    // often its hub entity, and linking that is the point; an alias that is a
    // frequent word links nothing (weakLinkKey)
    c.linkStop = stopKeySet(editable, null);
    c.index = buildLinkIndex(c.rows, c.linkStop, c.stop);
    c.stopStamp = stopStamp;
  }
  c.probedAt = Date.now();
}

/* ───────────────────────── learning the frequent terms ───────────────────────── */

/**
 * Learn the corpus-frequent terms from the indexed documents' own text and
 * persist them to playbooks/concepts/frequent.yaml: every candidate the miner
 * would consider (template stripped, before any stop list) is counted once per
 * document, and the terms in at least the threshold share of the documents are
 * the list. Measured on candidates rather than on what was mined, it has no
 * feedback with the filter it feeds; measured on text rather than on concept
 * entities, it is the same list whether or not the graph currently holds
 * them — a re-import that disposes every old placeholder as it runs changes
 * nothing here. `knode-os concepts learn`; also maybeLearnFrequentTerms.
 */
/**
 * Ceiling on the learned list, not a target: at the 2% threshold a 13.5k-document
 * corpus has a few thousand frequent terms, and a cap of 1,000 silently left
 * out every term seen in 271–840 documents.
 */
export const FREQUENT_TERM_LIMIT = 20_000;

export async function learnFrequentTerms(
  store: Store,
  opts: { ratio?: number; minCorpus?: number; minDocs?: number; limit?: number; onProgress?: (msg: string) => void } = {},
): Promise<FrequentTerms> {
  const rows = await store.query<{ path: string }>(`SELECT path FROM documents WHERE status = 'indexed' AND root = 'docs' ORDER BY path`);
  const df = new Map<string, { term: string; docs: number }>();
  let scanned = 0;
  for (const r of rows) {
    const src = loadSourceText(store.dataDir, r.path, 'docs');
    if (!src) continue;
    scanned++;
    const parsed = parseFrontmatter(src.text);
    const text = stripTemplate(parsed.body, { source: frontmatterNames(parsed.frontmatter).source, title: titleFromMarkdown(r.path, parsed) });
    for (const cand of conceptCandidates(text)) {
      const k = keyOf(cand.term);
      const e = df.get(k);
      if (e) e.docs++;
      else df.set(k, { term: cand.term, docs: 1 });
    }
    if (scanned % 1000 === 0) opts.onProgress?.(`concepts: scanned ${scanned}/${rows.length} documents`);
  }
  const threshold = frequentThreshold(scanned, opts.ratio, opts.minCorpus, opts.minDocs);
  const terms = threshold === null
    ? []
    : [...df.values()].filter((e) => e.docs >= threshold).sort((a, b) => b.docs - a.docs || a.term.localeCompare(b.term)).slice(0, opts.limit ?? FREQUENT_TERM_LIMIT);
  const result: FrequentTerms = { docs: scanned, threshold: threshold ?? 0, at: new Date().toISOString(), terms };
  // a corpus too small to measure leaves no file behind, unless one is there to be reset
  if (threshold !== null || readFrequentTerms(store.dataDir)) writeFrequentTerms(store.dataDir, result);
  invalidateTier0Known(store.dataDir);
  return result;
}

/** After a full sync pass: learn when the workspace has no list yet, the corpus doubled since, or the list is FREQUENT_RELEARN_MS old. */
export async function maybeLearnFrequentTerms(store: Store, opts: { onProgress?: (msg: string) => void } = {}): Promise<FrequentTerms | null> {
  const docs = await indexedDocumentCount(store);
  if (docs < FREQUENT_MIN_CORPUS) return null;
  const current = readFrequentTerms(store.dataDir);
  const stale = !current || docs >= 2 * Math.max(current.docs, 1) || Date.now() - new Date(current.at).getTime() > FREQUENT_RELEARN_MS;
  return stale ? learnFrequentTerms(store, opts) : null;
}

/* ────────────────────────────── planning ────────────────────────────── */

/** A document's names from its frontmatter: the exporter's author field and the declared `entities:`. */
export function frontmatterNames(fm: Record<string, unknown>): { source: string | null; declared: string[] } {
  const field = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const source = field(fm.source) ?? field(fm.author);
  const declared: string[] = [];
  for (const raw of Array.isArray(fm.entities) ? fm.entities : []) {
    if (typeof raw === 'string') declared.push(wikilinkName(raw));
    else if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      if (typeof o.name === 'string') declared.push(wikilinkName(o.name));
      if (Array.isArray(o.aliases)) declared.push(...o.aliases.map(String));
    }
  }
  return { source, declared: declared.map((d) => d.trim()).filter(Boolean) };
}

export interface LinkPlan {
  id: string;
  name: string;
  type: string;
  /** The spellings that matched, as written in the document (for grounding mentions). */
  surfaces: string[];
  count: number;
}

export interface Tier0Plan {
  links: LinkPlan[];
  concepts: string[];
}

/** Links per document are bounded so a stock list does not write hundreds of mentions. */
export const MAX_LINKS_PER_DOC = 64;

function maskOnly(name: string): LinkCandidate {
  return { id: null, name, type: 'concept', keys: [...mentionKeys(name, [], 'exact')] };
}

/**
 * Plan a document's tier-0 contribution — pure computation after two reads
 * (the workspace index, the frontmatter's own names), so the scope body only
 * writes. Called before the scope opens (src/ingest/apply.ts).
 */
export async function planTier0(store: Store, parsed: ParsedMarkdown, title: string | null): Promise<Tier0Plan> {
  const { index, stop } = await tier0Known(store);
  const { source, declared } = frontmatterNames(parsed.frontmatter);
  const text = stripTemplate(parsed.body, { source, title });

  // the frontmatter's own names: the author links when the graph knows them as
  // a typed entity (never typed here — that is tier-1's call); declared
  // `entities:` were written by the declared step already, so they are only
  // kept out of the miner's way
  const extras: LinkCandidate[] = [];
  if (source) {
    const typed = await typedEntitiesNamed(store, store.dataDir, [source]);
    if (typed.length > 0) extras.push(...typed);
    else extras.push(maskOnly(source));
  }
  for (const name of declared) extras.push(maskOnly(name));

  const spans = findLinks(text, index, extras.length ? buildLinkIndex(extras) : undefined);
  const byId = new Map<string, LinkPlan>();
  const add = (c: LinkCandidate, surface: string) => {
    if (!c.id) return;
    let plan = byId.get(c.id);
    if (!plan) byId.set(c.id, (plan = { id: c.id, name: c.name, type: c.type, surfaces: [], count: 0 }));
    plan.count++;
    if (!plan.surfaces.includes(surface)) plan.surfaces.push(surface);
  };
  // the declaration is itself a mention: a document is by its author whether or not the body repeats the name
  if (source) for (const c of extras) if (c.id) add(c, source);
  for (const s of spans) add(s.candidate, text.slice(s.start, s.end));
  const links = [...byId.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, MAX_LINKS_PER_DOC);
  const concepts = extractConcepts(maskSpans(text, spans), { stop, chars: text.length });
  return { links, concepts };
}

/* ─────────────────────────────── writing ─────────────────────────────── */

/** Chunk mentions a linked or mined entity gets at most. */
const MENTIONS_PER_ENTITY = 4;

/**
 * Persist the links: `tier0.link` evidence and chunk mentions on the existing
 * typed entity. A link repeats what the graph knows, so its evidence carries
 * the fallback type and half weight — it must never out-vote the name or type
 * tier-1 gives the entity later. A candidate retired since the index was
 * loaded takes no link.
 */
export async function wireLinks(w: ScopeWriter, page: PageContext, links: LinkPlan[]): Promise<{ entities: number; ids: string[] }> {
  if (links.length === 0) return { entities: 0, ids: [] };
  const ph = links.map((_, i) => `$${i + 1}`).join(',');
  const live = new Set(
    (await w.q.query<{ id: string }>(`SELECT id FROM entities WHERE id IN (${ph}) AND tx_to IS NULL AND type <> 'concept'`, links.map((l) => l.id))).map((r) => r.id),
  );
  const ids: string[] = [];
  for (const l of links) {
    if (!live.has(l.id)) continue;
    const needles = l.surfaces.map((s) => s.toLowerCase());
    const hits = page.chunkIds.filter((c) => {
      const lc = c.content.toLowerCase();
      return needles.some((n) => lc.includes(n));
    });
    const id = await w.entity({ name: l.name, type: 'concept' }, { id: l.id, extractor: LINK_EXTRACTOR, weight: 0.5, segmentId: hits[0]?.id ?? page.chunkIds[0]?.id ?? null });
    ids.push(id);
    for (const h of hits.slice(0, MENTIONS_PER_ENTITY)) await w.mention(id, h.id, page.documentId);
    if (hits.length === 0 && page.chunkIds[0]) await w.mention(id, page.chunkIds[0].id, page.documentId);
  }
  return { entities: ids.length, ids };
}

/**
 * Persist the mined terms as placeholders: concept entities and chunk
 * mentions. Their co-occurrence with the document's other entities is derived
 * from the mentions on read (cooccur.ts), not written as edges.
 */
export async function wireConcepts(w: ScopeWriter, page: PageContext, concepts: string[]): Promise<{ entities: number }> {
  const ids: string[] = [];
  for (const term of concepts) {
    const needle = term.toLowerCase();
    const hits = page.chunkIds.filter((c) => c.content.toLowerCase().includes(needle));
    const id = await w.entity({ name: term, type: 'concept' }, { extractor: CONCEPT_EXTRACTOR, segmentId: hits[0]?.id ?? page.chunkIds[0]?.id ?? null });
    ids.push(id);
    for (const h of hits.slice(0, MENTIONS_PER_ENTITY)) await w.mention(id, h.id, page.documentId);
    if (hits.length === 0 && page.chunkIds[0]) await w.mention(id, page.chunkIds[0].id, page.documentId);
  }
  return { entities: new Set(ids).size };
}

/* ───────────────────────────── retirement ───────────────────────────── */

/**
 * Once tier-1 has read a document, its tier-0 placeholders have done their
 * job: the `tier0.concept` evidence this document scope wrote for terms that
 * are still untyped — not resolved onto a typed entity, not merged into one —
 * is closed along with their mentions (which is what their co-occurrence was
 * derived from), and the touched rows are folded (a placeholder with no other
 * support tombstones). Evidence for terms tier-1 typed stays: it is this
 * document's support for a real entity. The sidecar's tier0.json is not
 * touched, so a history rebuild still replays the mined list.
 *
 * Idempotent; run after every tier-1 scope apply (src/graph/tier1.ts).
 */
export async function retireTier0Placeholders(store: Store, docScopeId: string, opts: { at?: string } = {}): Promise<{ entities: number }> {
  const txTime = opts.at ?? new Date().toISOString();
  const fold = foldOptions(store.dataDir);
  let result = { entities: 0 };
  await store.tx(async (q) => {
    // folds entity rows: queue on the ledger lock like every scope transaction
    await lockLedger(q);
    const rows = await q.query<{ target_id: string }>(
      `SELECT DISTINCT ev.target_id FROM evidence ev JOIN entities e ON e.id = ev.target_id
       WHERE ev.scope_id = $1 AND ev.kind = 'entity' AND ev.extractor = $2 AND ev.tx_to IS NULL
         AND e.type = 'concept' AND e.canonical_id IS NULL`,
      [docScopeId, CONCEPT_EXTRACTOR],
    );
    if (rows.length === 0) return;
    const ids = rows.map((r) => r.target_id);
    const touched = emptyTouched();
    const ph = (from: number) => ids.map((_, i) => `$${i + from}`).join(',');
    await q.query(
      `UPDATE evidence SET tx_to = $2::timestamptz
       WHERE scope_id = $1 AND kind = 'entity' AND extractor = $3 AND tx_to IS NULL AND target_id IN (${ph(4)})`,
      [docScopeId, txTime, CONCEPT_EXTRACTOR, ...ids],
    );
    for (const id of ids) touched.entities.add(id);
    await q.query(`DELETE FROM entity_mentions WHERE scope_id = $1 AND entity_id IN (${ph(2)})`, [docScopeId, ...ids]);
    await foldTouched(q, touched, txTime, fold);
    result = { entities: ids.length };
  });
  return result;
}

/* ───────────────────────────── relinking ───────────────────────────── */

export interface RelinkStats {
  /** Source documents whose links were recomputed. */
  documents: number;
  /** `tier0.link` evidence rows closed, and written again. */
  linksBefore: number;
  linksAfter: number;
  /** Entities folded afterwards: every one that lost or gained a link. */
  entities: number;
}

/** Entities folded per transaction once every document is relinked. */
const RELINK_FOLD_BATCH = 500;

/**
 * Recompute every live source document's tier-0 links against the current
 * link surfaces — after the surface rules changed (weakLinkKey) or the stop
 * lists did — without re-applying the documents. Per document, in its own
 * transaction: the scope's `tier0.link` evidence is closed, the mentions of the
 * entities it had only linked go with it, and the links are planned and
 * written again from the text and the chunks. The entities touched are folded
 * once at the end, in batches, not per document — a hub entity has tens of
 * thousands of evidence rows and would otherwise be refolded for every
 * document that names it. Mined placeholders, tier-1 and the sidecars are not
 * touched; a history rebuild recomputes tier-0 from the text the same way.
 * `knode-os entities relink`.
 */
export async function relinkTier0(store: Store, opts: { onProgress?: (msg: string) => void; limit?: number } = {}): Promise<RelinkStats> {
  const progress = opts.onProgress ?? (() => {});
  await tier0Known(store, { force: true });
  const ontology = loadOntology(store.dataDir);
  const fold = foldOptions(store.dataDir, ontology);
  const docs = await store.query<{ id: string; path: string; scope_id: string }>(
    `SELECT d.id, d.path, d.scope_id FROM documents d JOIN scopes s ON s.id = d.scope_id
     WHERE d.root = 'docs' AND d.status = 'indexed' AND d.kind = 'source' AND s.status = 'active'
     ORDER BY d.path`,
  );
  const work = opts.limit !== undefined ? docs.slice(0, Math.max(0, opts.limit)) : docs;
  const touched = new Set<string>();
  const stats: RelinkStats = { documents: 0, linksBefore: 0, linksAfter: 0, entities: 0 };
  for (const doc of work) {
    const source = loadSourceText(store.dataDir, doc.path, 'docs');
    if (!source) continue;
    const parsed = parseFrontmatter(source.text);
    const title = titleFromMarkdown(doc.path, parsed);
    // planned outside the transaction, as an apply plans it (src/ingest/apply.ts)
    const plan = await planTier0(store, parsed, title);
    const txTime = new Date().toISOString();
    await store.tx(async (q) => {
      // folds nothing, but closes and writes evidence: queue on the ledger lock like every scope transaction
      await lockLedger(q);
      const [scope] = await q.query<ScopeRow & { trust: string | null }>(`SELECT * FROM scopes WHERE id = $1 AND status = 'active'`, [doc.scope_id]);
      if (!scope) return;
      // a mention row is shared by every scope that found the entity in the chunk (one primary key),
      // so the mentions of an entity the document's tier-1 extraction or its own other evidence
      // supports stay: only what the links alone brought is deleted
      const old = await q.query<{ target_id: string; others: boolean }>(
        `SELECT ev.target_id,
                EXISTS (SELECT 1 FROM evidence o JOIN scopes s ON s.id = o.scope_id
                        WHERE (o.scope_id = ev.scope_id OR s.parent_id = ev.scope_id) AND s.status <> 'disposed'
                          AND o.kind = 'entity' AND o.target_id = ev.target_id AND o.extractor <> $2 AND o.tx_to IS NULL) AS others
         FROM evidence ev WHERE ev.scope_id = $1 AND ev.kind = 'entity' AND ev.extractor = $2 AND ev.tx_to IS NULL`,
        [scope.id, LINK_EXTRACTOR],
      );
      if (old.length > 0) {
        await q.query(
          `UPDATE evidence SET tx_to = $2::timestamptz WHERE scope_id = $1 AND kind = 'entity' AND extractor = $3 AND tx_to IS NULL`,
          [scope.id, txTime, LINK_EXTRACTOR],
        );
        const linkOnly = old.filter((r) => !r.others).map((r) => r.target_id);
        if (linkOnly.length > 0) {
          await q.query(`DELETE FROM entity_mentions WHERE scope_id = $1 AND entity_id IN (${linkOnly.map((_, i) => `$${i + 2}`).join(',')})`, [scope.id, ...linkOnly]);
        }
        for (const r of old) touched.add(r.target_id);
        stats.linksBefore += old.length;
      }
      const chunks = await q.query<{ id: string; content: string }>(`SELECT id, content FROM chunks WHERE document_id = $1 ORDER BY seq`, [doc.id]);
      const page: PageContext = { documentId: doc.id, path: doc.path, title: title ?? doc.path, chunkIds: chunks };
      const trust: TrustTier = scope.trust === 'quarantined' ? 'quarantined' : 'trusted';
      const linked = await wireLinks(new ScopeWriter(q, scope, txTime, store.dataDir, trust, ontology), page, plan.links);
      for (const id of linked.ids) touched.add(id);
      stats.linksAfter += linked.ids.length;
      stats.documents++;
    });
    if (stats.documents % 500 === 0) progress(`relink: ${stats.documents}/${work.length} documents`);
  }
  const ids = [...touched];
  for (let i = 0; i < ids.length; i += RELINK_FOLD_BATCH) {
    const batch = ids.slice(i, i + RELINK_FOLD_BATCH);
    const txTime = new Date().toISOString();
    await store.tx(async (q) => {
      await lockLedger(q);
      const t = emptyTouched();
      for (const id of batch) t.entities.add(id);
      await foldTouched(q, t, txTime, fold);
    });
    progress(`relink: folded ${Math.min(i + RELINK_FOLD_BATCH, ids.length)}/${ids.length} entities`);
  }
  stats.entities = ids.length;
  invalidateTier0Known(store.dataDir);
  return stats;
}
