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

/** Parse YAML frontmatter; malformed frontmatter degrades to a plain body. */
export function parseFrontmatter(raw: string): ParsedMarkdown {
  try {
    const p = matter(raw);
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
