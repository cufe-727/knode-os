import fs from 'node:fs';
import path from 'node:path';
import { safePath } from '../fs/files.js';
import { ScopeWriter } from '../lineage/writer.js';
import { ParsedMarkdown, parseFrontmatter, titleFromMarkdown } from '../markdown.js';
import { extractMarkdownLinks, resolveOkfLink } from '../okf/index.js';
import { dedupeCitations, frontmatterStrings, pageCitations, PlannedCitation, rawDocTarget } from './citations.js';
import { PageContext } from './store.js';

/**
 * Tier-0 deterministic graph wiring from frontmatter, knode-os wikilinks and
 * OKF ordinary markdown links. Planning (file reads, link resolution) is
 * separated from applying (evidence writes through a ScopeWriter) so the
 * database transaction never waits on the filesystem.
 *
 * Every non-reserved *source* wiki/OKF page is a concept node; generated
 * views are not (see src/ingest/apply.ts) — that is what stops a stub page
 * from resurrecting an entity whose sources are gone.
 */

export interface ObsidianLink {
  target: string;
  label: string;
  embed: boolean;
}

/** Extract Obsidian links, including aliases, headings, blocks and embeds. */
export function extractObsidianLinks(content: string): ObsidianLink[] {
  const out: ObsidianLink[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(/(!)?\[\[([^\]]+)\]\]/g)) {
    const inner = match[2];
    const pipeAt = inner.indexOf('|');
    // `[[note\|label]]` is how a table cell escapes the pipe: the backslash is not part of the name
    const destination = (pipeAt >= 0 ? inner.slice(0, pipeAt) : inner).replace(/\\$/, '').trim();
    const customLabel = pipeAt >= 0 ? inner.slice(pipeAt + 1).trim() : '';
    const target = destination.split('#', 1)[0].trim();
    if (!target) continue; // same-note heading/block reference
    const label = customLabel || path.posix.basename(target.replace(/\.md$/i, ''));
    const key = `${match[1] ? 'embed' : 'link'}\0${target}\0${label}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ target, label, embed: Boolean(match[1]) });
    }
  }
  return out;
}

/** Extract unique targets for legacy callers. */
export function extractWikilinks(content: string): string[] {
  return [...new Set(extractObsidianLinks(content).map((link) => link.target))];
}

/** Basename → relative note paths for one bundle root, built once per sync pass. */
export interface WikiIndex {
  rootRel: string;
  byBasename: Map<string, string[]>;
}

export function buildWikiIndex(dataDir: string, rootRel: string): WikiIndex {
  const byBasename = new Map<string, string[]>();
  const root = safePath(dataDir, rootRel);
  const visit = (abs: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(abs, entry.name), rel);
      else if (entry.isFile()) {
        const k = entry.name.toLowerCase();
        (byBasename.get(k) ?? byBasename.set(k, []).get(k)!).push(rel);
      }
    }
  };
  if (fs.existsSync(root)) visit(root, '');
  return { rootRel, byBasename };
}

export interface WireLink {
  name: string;
  type: string;
  description?: string;
  holderChunkId: string | null;
  relation: 'links_to' | 'mentions';
  relDescription: string;
}

export interface WirePlan {
  self: { name: string; type: string; description: string; aliases: string[] } | null;
  links: WireLink[];
  /** The raw/docs files a wiki page cites (src/graph/citations.ts). */
  citations: PlannedCitation[];
}

export interface WirePlanOptions {
  /** Create a concept node for the page itself. Default: every non-reserved wiki / imported OKF page. */
  selfEntity?: boolean;
  /** Body to scan (defaults to parsed.body — views pass their human-only text). */
  body?: string;
  wikiIndex?: WikiIndex;
  /**
   * Which citations of raw/docs files to plan: the body and frontmatter of a
   * wiki page (`all`, the default under wiki/), the body alone (`body`: the
   * human prose of a generated page, whose frontmatter the generator wrote),
   * or none (`none`, the default elsewhere).
   */
  citations?: 'all' | 'body' | 'none';
}

/** Pure planning step: no database writes. */
export function planWireFromMarkdown(dataDir: string, page: PageContext, parsed: ParsedMarkdown, opts: WirePlanOptions = {}): WirePlan {
  const fm = parsed.frontmatter;
  const body = opts.body ?? parsed.body;
  const okfPage = bundleContext(page.path);
  const reserved = /(^|\/)(index|log)\.md$/.test(page.path);
  const wantSelf = opts.selfEntity ?? Boolean(okfPage && !reserved);

  let self: WirePlan['self'] = null;
  if (okfPage && !reserved && wantSelf) {
    const selfType = typeof fm.type === 'string' && fm.type.trim() ? fm.type.trim() : 'concept';
    const name = typeof fm.title === 'string' ? fm.title : page.title;
    const aliases = Array.isArray(fm.aliases) ? fm.aliases.map(String) : [];
    self = { name, type: selfType, description: firstParagraph(body), aliases };
  }

  const links: WireLink[] = [];
  const propertyText = frontmatterStrings(fm).join('\n');
  for (const link of extractObsidianLinks(`${body}\n${propertyText}`)) {
    // a raw document is no entity: a wiki page's link to one is a citation (below), anyone else's is nothing —
    // tested before the bundle lookup, so an Obsidian stub at wiki/raw/docs/… cannot capture it
    if (rawDocTarget(page.path, link.target)) continue;
    const resolved = okfPage ? resolveObsidianTarget(dataDir, okfPage, link.target, opts.wikiIndex) : null;
    const targetName = resolved?.title || link.label || link.target;
    const holder = page.chunkIds.find((c) => c.content.includes(`[[${link.target}`)) ?? page.chunkIds[0];
    links.push({
      name: targetName,
      type: resolved?.type || 'concept',
      description: resolved?.description,
      holderChunkId: holder?.id ?? null,
      relation: resolved ? 'links_to' : 'mentions',
      relDescription: link.embed ? 'Obsidian embed' : 'Obsidian internal link',
    });
  }

  // OKF cross-links are ordinary markdown links. They are untyped directed
  // edges by specification; `links_to` intentionally makes no stronger claim
  // than the surrounding prose does.
  if (okfPage) {
    for (const link of extractMarkdownLinks(body)) {
      const target = resolveLocalTarget(dataDir, okfPage, link.href);
      if (!target) continue; // external, broken, or outside this bundle
      const holder = page.chunkIds.find((c) => c.content.includes(link.href)) ?? page.chunkIds[0];
      links.push({
        name: target.title || link.label,
        type: target.type || 'concept',
        description: target.description,
        holderChunkId: holder?.id ?? null,
        relation: 'links_to',
        relDescription: 'OKF markdown link',
      });
    }
  }

  const mode = opts.citations ?? (page.path.startsWith('wiki/') ? 'all' : 'none');
  const citations = mode === 'none'
    ? []
    : dedupeCitations(pageCitations(page.path, fm, body, { frontmatter: mode === 'all' })).map((c) => ({
      ...c,
      chunkId: c.needle ? page.chunkIds.find((chunk) => chunk.content.includes(c.needle!))?.id ?? null : null,
    }));
  return { self, links, citations };
}

/** Apply a wire plan as evidence of one scope. */
export async function applyWirePlan(
  w: ScopeWriter,
  page: PageContext,
  plan: WirePlan,
  opts: { extractor: string },
): Promise<{ entities: number; relations: number }> {
  const stats = { entities: 0, relations: 0 };
  let selfId: string | null = null;
  if (plan.self) {
    selfId = await w.entity(plan.self, { extractor: opts.extractor });
    if (page.path.startsWith('wiki/')) await w.setWikiPath(selfId, page.path);
    stats.entities++;
  }
  for (const link of plan.links) {
    const targetId = await w.entity(
      { name: link.name, type: link.type, description: link.description },
      { extractor: opts.extractor, segmentId: link.holderChunkId },
    );
    stats.entities++;
    // the mention is what links the linked pages to each other: co-occurrence is derived from it on read (cooccur.ts)
    if (link.holderChunkId) await w.mention(targetId, link.holderChunkId, page.documentId);
    if (selfId && selfId !== targetId) {
      if (await w.relation(selfId, targetId, { type: link.relation, description: link.relDescription, extractor: opts.extractor })) stats.relations++;
    }
  }
  await w.citations(page.documentId, page.path, plan.citations);
  return stats;
}

interface BundleContext {
  rootRel: string;
  sourceRel: string;
}

/** Identify the native wiki bundle or a bundle imported via `okf import`. */
export function bundleContext(pagePath: string): BundleContext | null {
  if (pagePath.startsWith('wiki/')) return { rootRel: 'wiki', sourceRel: pagePath.slice('wiki/'.length) };
  const match = /^raw\/docs\/okf\/([^/]+)\/(.+)$/.exec(pagePath);
  if (!match) return null;
  return { rootRel: `raw/docs/okf/${match[1]}`, sourceRel: match[2] };
}

function resolveLocalTarget(
  dataDir: string,
  bundle: BundleContext,
  href: string,
): { title: string; type: string; description: string } | null {
  const targetRel = resolveOkfLink(bundle.sourceRel, href);
  if (!targetRel || targetRel.startsWith('../')) return null;
  const candidates = [targetRel];
  if (!path.posix.extname(targetRel)) candidates.push(`${targetRel}.md`, path.posix.join(targetRel, 'index.md'));
  return readLocalTarget(dataDir, bundle, candidates);
}

/** Resolve Obsidian's vault-root folder paths and shortest-path note links. */
function resolveObsidianTarget(
  dataDir: string,
  bundle: BundleContext,
  target: string,
  wikiIndex?: WikiIndex,
): { title: string; type: string; description: string } | null {
  const clean = target.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.md$/i, '');
  if (!clean || clean === '..' || clean.startsWith('../')) return null;
  const ext = path.posix.extname(clean);
  if (ext) return null; // attachment embed, not a markdown Concept

  const candidates: string[] = [];
  if (clean.includes('/')) {
    candidates.push(`${path.posix.normalize(clean)}.md`);
  } else {
    candidates.push(path.posix.join(path.posix.dirname(bundle.sourceRel), `${clean}.md`), `${clean}.md`);
    const matches = wikiIndex && wikiIndex.rootRel === bundle.rootRel
      ? wikiIndex.byBasename.get(`${clean}.md`.toLowerCase()) ?? []
      : findNotesByBasename(safePath(dataDir, bundle.rootRel), `${clean}.md`);
    if (matches.length === 1) candidates.push(matches[0]);
  }
  return readLocalTarget(dataDir, bundle, [...new Set(candidates)]);
}

function readLocalTarget(
  dataDir: string,
  bundle: BundleContext,
  candidates: string[],
): { title: string; type: string; description: string } | null {
  for (const candidate of candidates) {
    const fullRel = path.posix.join(bundle.rootRel, candidate);
    const abs = safePath(dataDir, fullRel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    try {
      const parsed = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
      const title = titleFromMarkdown(candidate, parsed) ?? path.posix.basename(candidate, '.md');
      const type = typeof parsed.frontmatter.type === 'string' ? parsed.frontmatter.type.trim() : '';
      const description = typeof parsed.frontmatter.description === 'string'
        ? parsed.frontmatter.description.trim()
        : firstParagraph(parsed.body);
      return { title, type, description };
    } catch {
      return null;
    }
  }
  return null;
}

function findNotesByBasename(root: string, basename: string): string[] {
  const matches: string[] = [];
  const visit = (abs: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) visit(child, rel);
      else if (entry.isFile() && entry.name.toLowerCase() === basename.toLowerCase()) matches.push(rel);
    }
  };
  visit(root, '');
  return matches;
}

export function firstParagraph(md: string): string {
  for (const block of md.split(/\n\s*\n/)) {
    const t = block.replace(/^#+\s.*$/gm, '').replace(/\s+/g, ' ').trim();
    if (t.length > 20) return t.slice(0, 300);
  }
  return '';
}
