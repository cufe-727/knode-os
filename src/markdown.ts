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

/** U+0000, and a surrogate without its pair. */
const UNSTORABLE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * A text as PostgreSQL can store it. A text value cannot hold U+0000 (the
 * write fails with `invalid byte sequence for encoding "UTF8": 0x00`, or in
 * jsonb `unsupported Unicode escape sequence`), and PDF text extraction emits
 * it for glyphs it cannot map — `su\0cient` for an "ffi" ligature, `V\01`
 * for a minus sign — so it is dropped. A surrogate without its pair becomes
 * U+FFFD: the UTF-8 encoder sends that for it to a text column anyway, but
 * JSON.stringify keeps it as an escape jsonb rejects. A text with neither
 * comes back as it was, so its hash does not change.
 */
export function storableText(text: string): string {
  return text.replace(UNSTORABLE, (c) => (c === '\u0000' ? '' : '\ufffd'));
}

/** `storableText` on every key and string of a parsed YAML value, in place (gray-matter's result is fresh, see readMatter). */
function storableYaml(value: unknown, seen = new Set<object>()): unknown {
  if (typeof value === 'string') return storableText(value);
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = storableYaml(value[i], seen);
  } else if (Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const v = storableYaml(record[key], seen);
      const k = storableText(key);
      if (k !== key) delete record[key];
      record[k] = v;
    }
  }
  return value;
}

/**
 * Parse YAML frontmatter; malformed frontmatter degrades to a plain body.
 * Its values are storable (`storableText`): a YAML escape spells U+0000 as
 * `"\0"` or `"\u0000"` — the normalizer writes the latter itself when it
 * copies a heading holding one into `title:` — and a title or a declared
 * entity holding it would fail the document's whole scope.
 */
export function parseFrontmatter(raw: string): ParsedMarkdown {
  try {
    const p = readMatter(raw);
    return { frontmatter: storableYaml(p.data) as Record<string, unknown>, body: p.content };
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
