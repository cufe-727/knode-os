import path from 'node:path';
import matter from 'gray-matter';

/**
 * Frontmatter handling shared by the ingest pipeline and graph wiring, so a
 * document is parsed once per ingest instead of once per consumer.
 */

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

/*
 * gray-matter, called without options, keeps every text it parses — and a
 * Buffer copy of it — in a module-level object keyed by the whole text, for
 * the life of the process; `matter.stringify` parses its body the same way.
 * `serve` reads and writes pages all day: on 2026-11-02 that cache held 17k
 * texts, 1.6 GB of a 2 GB heap two hours after a start, and the service had
 * died at the 4 GB heap limit twice. The cache also handed every caller of
 * one text the same `data` object, and answered a second parse of malformed
 * frontmatter with `{}` instead of the error. Options, even empty, skip it:
 * every gray-matter call goes through these two.
 */

/** gray-matter's parse, uncached: a fresh result each call, and malformed frontmatter throws every time. */
export function readMatter(text: string): matter.GrayMatterFile<string> {
  return matter(text, {});
}

/** `body` under a YAML frontmatter block of `data` (gray-matter's stringify, uncached). */
export function writeMatter(body: string, data: object): string {
  return matter.stringify(body, data, {});
}

/** Parse YAML frontmatter; malformed frontmatter degrades to a plain body. */
export function parseFrontmatter(raw: string): ParsedMarkdown {
  try {
    const p = readMatter(raw);
    return { frontmatter: p.data as Record<string, unknown>, body: p.content };
  } catch {
    return { frontmatter: {}, body: raw };
  }
}

/** Document title: frontmatter `title` → first heading → filename stem. */
export function titleFromMarkdown(file: string, parsed: ParsedMarkdown): string | null {
  const fmTitle = parsed.frontmatter.title;
  if (typeof fmTitle === 'string' && fmTitle.trim()) return fmTitle.trim();
  const h1 = parsed.body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return path.basename(file).replace(/\.[^.]+$/, '');
}

/** What a folder listing shows of a Markdown file without opening it (`GET /api/tree?meta=1`). */
export interface MarkdownMeta {
  title?: string;
  description?: string;
  date?: string;
  type?: string;
  tags?: string[];
  stage?: string;
  verdict?: string;
}

const FRONTMATTER_BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A frontmatter value as one line of text: a YAML date as its day, a list or map left out. */
function metaText(value: unknown, max: number): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString().slice(0, 10);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
}

/**
 * The frontmatter fields a reader lists a document by — title, description,
 * date, type, tags, stage, verdict — read from the head of the file (the
 * first heading stands in for a missing title), or null when it has none of
 * them. Frontmatter that does not close within `head`, or does not parse, is
 * no frontmatter.
 */
export function markdownMeta(head: string): MarkdownMeta | null {
  const block = FRONTMATTER_BLOCK.exec(head);
  let fields: Record<string, unknown> = {};
  if (block) {
    try {
      fields = (readMatter(block[0]).data ?? {}) as Record<string, unknown>;
    } catch {
      fields = {};
    }
  }
  const meta: MarkdownMeta = {};
  const title = metaText(fields.title, 300) ?? metaText(/^#\s+(.+)$/m.exec(block ? head.slice(block[0].length) : head)?.[1], 300);
  if (title) meta.title = title;
  const description = metaText(fields.description, 600);
  if (description) meta.description = description;
  for (const key of ['date', 'type', 'stage', 'verdict'] as const) {
    const value = metaText(fields[key], 120);
    if (value) meta[key] = value;
  }
  const tags = (Array.isArray(fields.tags) ? fields.tags : [fields.tags]).map((t) => metaText(t, 60)).filter((t): t is string => Boolean(t));
  if (tags.length) meta.tags = tags.slice(0, 20);
  return Object.keys(meta).length ? meta : null;
}
