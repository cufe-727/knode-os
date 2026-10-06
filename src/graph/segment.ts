import crypto from 'node:crypto';
import { keyOf, typesCompatible } from './normalize.js';
import { ExtractedClaim, ExtractedEntity, ExtractedRelation } from './store.js';

/**
 * Long documents are extracted in segments (docs/design/10 §3).
 *
 * A document no longer than the limit is one segment. A longer one is split
 * into line-level blocks — a heading, a thematic break, or a paragraph after
 * a blank line opens one — and the blocks are packed into segments of at most
 * the limit. Where a segment ends is decided by the content at the cut, not
 * by the running length: once a segment is past MIN_FILL of the limit it ends
 * before the next heading (or rule) whose first line hashes to a hit, and it
 * is cut at the limit only when no hit came along in time — the way
 * content-defined chunking keeps chunk boundaries stable under edits. So an edit moves
 * only the cuts next to it, an append changes only the last segment, and
 * every other segment keeps its text — and with it its cached extraction.
 */

/**
 * A segment may end on a hit only once it holds this share of the limit.
 * Kept well below 1 on purpose: when segments end shortly after MIN_FILL, the
 * running length decides the cuts again and an edit shifts every later one.
 */
const MIN_FILL = 0.4;
/**
 * One heading in HIT_RATE (by hash of its line) ends a segment past MIN_FILL.
 * Sparse enough that two cut sequences starting a little apart soon land on
 * the same heading. Measured on the finance archives (2026-10-03, 5.1 M chars):
 * 571 segments of 9.0 k on average at a 12 k limit, and an insertion in the
 * middle of a document changes 1.6 segments on average, 6 at most — against 444
 * segments and 5.2 changed (up to 21) when segments are simply filled up.
 */
const HIT_RATE = 12;

/** Tuning for tests and measurements; production uses the defaults above. */
export interface SegmentTuning {
  minFill?: number;
  hitRate?: number;
  /** Paragraph starts count as cut points too (with hitRate × paragraphFactor). */
  paragraphFactor?: number;
}

export interface Segment {
  index: number;
  /** Character offsets into the document text. */
  start: number;
  end: number;
  text: string;
  /** Hash of the text — the segment's cache key. */
  sha: string;
  /** The nearest heading above a segment that starts mid-section; null when it opens with a heading of its own. */
  heading: string | null;
}

interface Block {
  start: number;
  end: number;
  firstLine: string;
  /** Opens with a heading or a thematic break: a place a segment may end on content. */
  strong: boolean;
}

const HEADING = /^#{1,6}\s/;
const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;

function isStrong(line: string): boolean {
  return HEADING.test(line) || RULE.test(line.replace(/\r$/, ''));
}

function lineSpans(text: string): { start: number; end: number; line: string }[] {
  const out: { start: number; end: number; line: string }[] = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl + 1;
    out.push({ start: pos, end, line: text.slice(pos, nl === -1 ? text.length : nl) });
    pos = end;
  }
  return out;
}

function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let prevBlank = false;
  for (const { start, end, line } of lineSpans(text)) {
    const blank = line.trim() === '';
    const strong = !blank && isStrong(line);
    if (!cur || (!blank && (strong || prevBlank))) {
      if (cur) {
        cur.end = start;
        blocks.push(cur);
      }
      cur = { start, end, firstLine: line, strong };
    } else {
      cur.end = end;
    }
    prevBlank = blank;
  }
  if (cur) {
    cur.end = text.length;
    blocks.push(cur);
  }
  return blocks;
}

/** The last line break in [from, to), else the last sentence end; the hard limit when there is neither. */
function bestCut(text: string, from: number, to: number): number {
  const nl = text.lastIndexOf('\n', to - 1);
  if (nl >= from) return nl + 1;
  for (let i = to - 1; i >= from; i--) if ('。！？!?；;.'.includes(text[i])) return i + 1;
  // never between the halves of a surrogate pair
  const code = text.charCodeAt(to - 1);
  return code >= 0xd800 && code <= 0xdbff ? to - 1 : to;
}

function firstLineAt(text: string, at: number): string {
  const nl = text.indexOf('\n', at);
  return text.slice(at, nl === -1 ? text.length : nl);
}

/** A block longer than the limit, cut at line breaks or sentence ends. */
function splitOversized(text: string, b: Block, limit: number): Block[] {
  if (b.end - b.start <= limit) return [b];
  const out: Block[] = [];
  let s = b.start;
  while (b.end - s > limit) {
    const cut = bestCut(text, s + Math.floor(limit / 2), s + limit);
    out.push({ start: s, end: cut, firstLine: firstLineAt(text, s), strong: s === b.start && b.strong });
    s = cut;
  }
  out.push({ start: s, end: b.end, firstLine: firstLineAt(text, s), strong: s === b.start && b.strong });
  return out;
}

function hashOf(line: string): number {
  return crypto.createHash('sha1').update(line.trim()).digest().readUInt32BE(0);
}

export function segmentSha(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 24);
}

function headingText(line: string): string {
  return line.replace(/^#{1,6}\s+/, '').trim().slice(0, 120);
}

/** Cut `text` into extraction segments of at most `maxChars` characters. Empty text has none. */
export function segmentText(text: string, maxChars: number, tuning: SegmentTuning = {}): Segment[] {
  if (!text) return [];
  const limit = Math.max(1000, Math.floor(maxChars));
  if (text.length <= limit) return [{ index: 0, start: 0, end: text.length, text, sha: segmentSha(text), heading: null }];

  const blocks = blocksOf(text).flatMap((b) => splitOversized(text, b, limit));
  const min = Math.floor(limit * (tuning.minFill ?? MIN_FILL));
  const rate = tuning.hitRate ?? HIT_RATE;
  const paragraphs = tuning.paragraphFactor;
  const isHit = (b: Block) =>
    b.strong ? hashOf(b.firstLine) % rate === 0 : paragraphs !== undefined && b.firstLine.trim() !== '' && hashOf(b.firstLine) % Math.round(rate * paragraphs) === 0;
  const cuts = [0];
  let segStart = 0;
  for (const b of blocks) {
    const filled = b.start - segStart;
    if (filled > 0 && ((filled >= min && isHit(b)) || b.end - segStart > limit)) {
      cuts.push(b.start);
      segStart = b.start;
    }
  }
  cuts.push(text.length);

  const headings = lineSpans(text).filter((l) => HEADING.test(l.line));
  const out: Segment[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const start = cuts[i];
    const end = cuts[i + 1];
    const body = text.slice(start, end);
    // a segment that opens with its own heading (after any rule) needs no label
    const lead = body.split('\n').find((l) => l.trim() !== '' && !RULE.test(l.replace(/\r$/, '')));
    let heading: string | null = null;
    if (!lead || !HEADING.test(lead)) {
      let above: string | null = null;
      for (const h of headings) {
        if (h.start >= start) break;
        above = h.line;
      }
      heading = above ? headingText(above) : null;
    }
    out.push({ index: i, start, end, text: body, sha: segmentSha(body), heading });
  }
  return out;
}

/* ---------------------------- merging segments ---------------------------- */

export interface SegmentExtraction {
  index: number;
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  claims: ExtractedClaim[];
}

export interface MergedExtraction {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  claims: ExtractedClaim[];
  /** Lower-cased name or alias → the merged entity's name. */
  names: Map<string, string>;
}

function normStatement(s: string): string {
  return s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * One document-level result from its segments' results, before anything is
 * written. Entities that share an exact name or alias key (or name the same
 * `sameAs`) with a compatible type become one: the most frequent spelling is
 * the name (earliest on a tie), aliases are unioned, the first description and
 * the majority type win, and `segments` lists where it was extracted.
 * Relations collapse on (source, predicate, target), the first occurrence
 * winning with gaps filled from later ones; claims collapse on (subject,
 * statement) and keep their segment for grounding.
 */
export function mergeSegmentResults(parts: SegmentExtraction[]): MergedExtraction {
  const ordered = [...parts].sort((a, b) => a.index - b.index);
  const members: { e: ExtractedEntity; seg: number }[] = [];
  for (const p of ordered) for (const e of p.entities) if (e?.name?.trim()) members.push({ e, seg: p.index });

  const parent = members.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byKey = new Map<string, number>();
  members.forEach((m, i) => {
    const spellings = [m.e.name, ...(m.e.aliases ?? []), ...(m.e.sameAs ? [m.e.sameAs] : [])];
    for (const s of spellings) {
      if (typeof s !== 'string') continue;
      const k = keyOf(s);
      if (k.length < 2) continue;
      const j = byKey.get(k);
      if (j === undefined) {
        byKey.set(k, i);
        continue;
      }
      const a = find(j);
      const b = find(i);
      if (a !== b && typesCompatible(members[a].e.type, m.e.type)) parent[Math.max(a, b)] = Math.min(a, b);
    }
  });

  const groups = new Map<number, { e: ExtractedEntity; seg: number }[]>();
  members.forEach((m, i) => {
    const r = find(i);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(m);
  });

  const names = new Map<string, string>();
  const entities: ExtractedEntity[] = [];
  for (const group of [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g)) {
    const counts = new Map<string, number>();
    for (const m of group) counts.set(m.e.name.trim(), (counts.get(m.e.name.trim()) ?? 0) + 1);
    let name = group[0].e.name.trim();
    for (const [n, c] of counts) if (c > (counts.get(name) ?? 0)) name = n;
    const aliases: string[] = [];
    const seen = new Set([name.toLowerCase()]);
    for (const m of group) {
      for (const a of [m.e.name, ...(m.e.aliases ?? [])]) {
        if (typeof a !== 'string' || !a.trim() || seen.has(a.trim().toLowerCase())) continue;
        seen.add(a.trim().toLowerCase());
        aliases.push(a.trim());
      }
    }
    const typeVotes = new Map<string, number>();
    for (const m of group) if (m.e.type && m.e.type !== 'concept' && m.e.type !== 'other') typeVotes.set(m.e.type, (typeVotes.get(m.e.type) ?? 0) + 1);
    let type = group[0].e.type;
    let best = 0;
    for (const [t, v] of typeVotes) if (v > best) [type, best] = [t, v];
    const merged: ExtractedEntity = {
      name,
      type,
      description: group.map((m) => m.e.description?.trim()).find(Boolean) ?? '',
      aliases,
      sameAs: group.map((m) => m.e.sameAs).find((s) => typeof s === 'string' && s.trim()) ?? null,
      segments: [...new Set(group.map((m) => m.seg))].sort((a, b) => a - b),
    };
    entities.push(merged);
    for (const m of group) {
      names.set(m.e.name.trim().toLowerCase(), name);
      for (const a of m.e.aliases ?? []) if (typeof a === 'string' && a.trim()) names.set(a.trim().toLowerCase(), name);
    }
  }
  const nameOf = (raw: string) => names.get(raw.trim().toLowerCase()) ?? raw.trim();

  const relations: ExtractedRelation[] = [];
  const relIndex = new Map<string, number>();
  for (const p of ordered) {
    for (const r of p.relations) {
      if (!r?.source || !r?.target) continue;
      const source = nameOf(r.source);
      const target = nameOf(r.target);
      const key = `${source.toLowerCase()}|${String(r.type ?? '').trim().toLowerCase()}|${target.toLowerCase()}`;
      const at = relIndex.get(key);
      if (at === undefined) {
        relIndex.set(key, relations.length);
        relations.push({ ...r, source, target });
        continue;
      }
      const prev = relations[at];
      relations[at] = {
        ...prev,
        description: prev.description || r.description,
        validFrom: prev.validFrom ?? r.validFrom ?? null,
        validTo: prev.validTo ?? r.validTo ?? null,
      };
    }
  }

  const claims: ExtractedClaim[] = [];
  const claimKeys = new Set<string>();
  for (const p of ordered) {
    for (const c of p.claims) {
      if (!c?.subject?.trim() || !c?.statement?.trim()) continue;
      const subject = nameOf(c.subject);
      const key = `${subject.toLowerCase()}|${normStatement(c.statement)}`;
      if (claimKeys.has(key)) continue;
      claimKeys.add(key);
      const object = c.object && c.object.toUpperCase() !== 'NONE' ? nameOf(c.object) : c.object ?? null;
      claims.push({ ...c, subject, object, segment: p.index });
    }
  }
  return { entities, relations, claims, names };
}
