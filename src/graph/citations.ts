import path from 'node:path';
import { extractMarkdownLinks, withoutMarkdownCode } from '../okf/index.js';
import { normalizePredicate, Ontology, relationSpec } from './ontology.js';

/**
 * Citations: a wiki page naming a file under raw/docs.
 *
 *   [[raw/docs/…]], ![[raw/docs/…]]    cites          in the body or a frontmatter string
 *   [text](../../raw/docs/…)           cites          page-relative, or raw/… from the workspace root
 *   sources: [raw/docs/…]              derived_from   OKF: what the concept was derived from
 *   relations: { tested_by: [raw/…] }  that predicate src/graph/frontmatter.ts diverts it here
 *
 * A raw document has no node in the graph and relations join entities, so a
 * link to one used to mint a concept named after the file. It is a row of its
 * own instead (`citations`, schema v16), owned by the citing page's scope.
 *
 * Everything here is lexical — no file system — so the same page text always
 * yields the same citations, whichever files exist when it is applied: a file
 * uploaded after the page that cites it is cited all the same. A target keeps
 * the spelling the page wrote, normalized; `citationKeys` lists the spellings
 * that name a given file, the way the app's link resolver
 * (src/obsidian/links.ts) opens them.
 */

const RAW_DOCS = 'raw/docs/';

/** Bump when these rules change: a wiki page applied under an older version is read again once (src/ingest/apply.ts). */
export const CITATIONS_VERSION = 1;

export type CitationVia = 'wikilink' | 'embed' | 'markdown' | 'sources' | 'relations';

export interface RawDocTarget {
  /** The file as the page wrote it, normalized (`raw/docs/…`). It need not exist. */
  path: string;
  fragment: string | null;
}

export interface CitationCandidate extends RawDocTarget {
  /** Canonical predicate: `cites`, `derived_from`, `tested_by` or any other the ontology knows. */
  type: string;
  /** The canonical reading runs from the file to the page (the page used an inverse spelling, or named the file as `source`). */
  inverse: boolean;
  via: CitationVia;
  /** The text that finds the chunk holding the link; null for a frontmatter citation. */
  needle: string | null;
}

/** What a wiki page's scope writes: a candidate, placed in the chunk that holds it. */
export interface PlannedCitation extends CitationCandidate {
  chunkId: string | null;
}

/**
 * The raw/docs file a link target names, or null.
 *
 *   - an Obsidian `|label` (escaped `\|` in a table cell too) and `#fragment` are split off; a Markdown href also
 *     loses its `?query` and has its `%xx` escapes decoded;
 *   - `\` reads as `/`;
 *   - `raw/…` and `wiki/…`, with or without a leading `/`, are workspace-root, as the app's link resolver reads them;
 *     anything else is relative to the citing page — never for a wikilink, which Obsidian does not read that way;
 *   - a path leaving the workspace, landing outside raw/docs or naming a folder is no citation.
 */
export function rawDocTarget(fromPath: string, target: string, opts: { markdown?: boolean; relative?: boolean } = {}): RawDocTarget | null {
  let t = target.trim();
  if (!opts.markdown) {
    const pipe = t.search(/\\?\|/);
    if (pipe >= 0) t = t.slice(0, pipe);
  }
  let fragment: string | null = null;
  const hash = t.indexOf('#');
  if (hash >= 0) {
    fragment = t.slice(hash + 1).trim() || null;
    t = t.slice(0, hash);
  }
  if (opts.markdown) {
    t = t.split('?', 1)[0];
    t = decode(t);
    if (fragment) fragment = decode(fragment);
  }
  t = t.trim().replace(/\\+$/, '').replace(/\\/g, '/');
  if (!t || t.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(t)) return null;
  const rooted = t.replace(/^\/+/, '');
  let joined: string;
  if (/^(raw|wiki)(\/|$)/.test(rooted)) joined = rooted;
  else if (opts.markdown || opts.relative) joined = path.posix.join(path.posix.dirname(fromPath), t);
  else return null;
  const normalized = path.posix.normalize(joined).replace(/^\.\//, '');
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.endsWith('/')) return null;
  if (!normalized.startsWith(RAW_DOCS) || normalized.length === RAW_DOCS.length) return null;
  return { path: normalized, fragment };
}

/** A frontmatter value naming a raw/docs file: a path, or a path inside `[[…]]`. */
export function rawDocValue(fromPath: string, value: unknown): RawDocTarget | null {
  if (typeof value !== 'string') return null;
  const link = /^\s*!?\[\[([^\]]+)\]\]\s*$/.exec(value);
  return link ? rawDocTarget(fromPath, link[1]) : rawDocTarget(fromPath, value, { relative: true });
}

/** `[[raw/docs/…]]` and `![[raw/docs/…]]` outside code. */
export function linkCitations(fromPath: string, text: string): CitationCandidate[] {
  const out: CitationCandidate[] = [];
  for (const m of withoutMarkdownCode(text).matchAll(/(!)?\[\[([^\]]+)\]\]/g)) {
    const hit = rawDocTarget(fromPath, m[2]);
    if (hit) out.push({ ...hit, type: 'cites', inverse: false, via: m[1] ? 'embed' : 'wikilink', needle: m[0] });
  }
  return out;
}

/** Markdown links that resolve under raw/docs (extractMarkdownLinks leaves code, images and wikilinks out). */
export function markdownCitations(fromPath: string, body: string): CitationCandidate[] {
  const out: CitationCandidate[] = [];
  for (const link of extractMarkdownLinks(body)) {
    const hit = rawDocTarget(fromPath, link.href, { markdown: true });
    if (hit) out.push({ ...hit, type: 'cites', inverse: false, via: 'markdown', needle: link.href });
  }
  return out;
}

/** OKF `sources:` entries naming raw/docs files: a string, `[[…]]`, or an object's `resource` / `path`. */
export function sourcesCitations(fromPath: string, frontmatter: Record<string, unknown>): CitationCandidate[] {
  const raw = frontmatter.sources;
  const entries = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const out: CitationCandidate[] = [];
  for (const entry of entries) {
    const value = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).resource ?? (entry as Record<string, unknown>).path : entry;
    const hit = rawDocValue(fromPath, value);
    if (hit) out.push({ ...hit, type: 'derived_from', inverse: false, via: 'sources', needle: null });
  }
  return out;
}

/** Every string a frontmatter holds, nested values included (Obsidian Properties carry links too). */
export function frontmatterStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(frontmatterStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(frontmatterStrings);
  return [];
}

/**
 * The citations a page's text makes. `frontmatter: false` reads the body
 * alone — the human prose of a generated page, whose frontmatter the
 * generator wrote. Typed `relations:` come from frontmatterExtraction.
 */
export function pageCitations(
  fromPath: string,
  frontmatter: Record<string, unknown>,
  body: string,
  opts: { frontmatter: boolean },
): CitationCandidate[] {
  const out = [...linkCitations(fromPath, body), ...markdownCitations(fromPath, body)];
  if (opts.frontmatter) {
    out.push(...linkCitations(fromPath, frontmatterStrings(frontmatter).join('\n')).map((c) => ({ ...c, needle: null })));
    out.push(...sourcesCitations(fromPath, frontmatter));
  }
  return out;
}

/** A `relations:` entry diverted by frontmatterExtraction, typed against the ontology. */
export function relationCitation(ont: Ontology, d: { path: string; fragment: string | null; type: string; fileIsSource: boolean }): CitationCandidate {
  const norm = normalizePredicate(ont, d.type);
  const symmetric = relationSpec(ont, norm.type)?.symmetric === true;
  return { path: d.path, fragment: d.fragment, type: norm.type, inverse: !symmetric && d.fileIsSource !== norm.flip, via: 'relations', needle: null };
}

/**
 * One citation per (file, predicate, direction), the first one written; a
 * plain `cites` yields to a more specific predicate for the same file — the
 * `[[…]]` inside a typed `relations:` entry is the same statement, not another.
 */
export function dedupeCitations<T extends CitationCandidate>(rows: T[]): T[] {
  const kept = new Map<string, T>();
  for (const r of rows) {
    const key = `${fileKey(r.path)}\0${r.type}\0${r.inverse}`;
    if (!kept.has(key)) kept.set(key, r);
  }
  const typed = new Set([...kept.values()].filter((r) => r.type !== 'cites').map((r) => fileKey(r.path)));
  return [...kept.values()].filter((r) => r.type !== 'cites' || !typed.has(fileKey(r.path)));
}

/** One key per file however a page spells it: `raw/docs/x`, `raw/docs/X.md`. */
function fileKey(target: string): string {
  const p = target.toLowerCase();
  return p.endsWith('/index.md') ? p.slice(0, -'/index.md'.length) : p.replace(/\.(md|markdown)$/, '');
}

/** The lower-cased target spellings that name `filePath`: as is, without `.md` / `.markdown`, a folder's `index.md`. */
export function citationKeys(filePath: string): string[] {
  const p = filePath.toLowerCase();
  const keys = new Set([p]);
  const ext = /\.(md|markdown)$/.exec(p);
  if (ext) keys.add(p.slice(0, -ext[0].length));
  if (p.endsWith('/index.md')) keys.add(p.slice(0, -'/index.md'.length));
  return [...keys];
}

/** The predicate as the page states it toward the file: an inverse row reads as its inverse name (`tests`). */
export function citationLabel(ont: Ontology, type: string, inverse: boolean): string {
  if (!inverse) return type;
  return relationSpec(ont, type)?.inverse ?? `${type} (inverse)`;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
