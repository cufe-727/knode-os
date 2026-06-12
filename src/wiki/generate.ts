import fs from 'node:fs';
import path from 'node:path';
import { appendLog } from '../fs/datadir.js';
import { safePath } from '../fs/files.js';
import { LlmClient } from '../llm/client.js';
import { Store } from '../store/db.js';
import { DocumentRow, EntityRow } from '../types.js';
import { slugify } from '../graph/extract.js';

/**
 * Wiki generation (llm_wiki's two-step ingest, generation half):
 * - one summary page per raw document under wiki/sources/
 * - one stub page per extracted entity under wiki/entities/
 * Pages carry frontmatter + [[wikilinks]], so the next ingest run wires them
 * back into the graph. Existing pages are only overwritten when marked
 * `generated: true` (hand-edited pages are left alone).
 */

const SOURCE_SYSTEM = `You maintain a personal wiki. Summarize the document into a wiki source page.

Output rules:
- Markdown only, no preamble.
- Start with: a one-paragraph abstract, then "## Key points" bullets, then "## Entities" linking the important entities as [[Entity Name]] wikilinks.
- Wrap every important person/org/product/concept name in [[double brackets]].
- Write in the document's language. Max ~400 words.`;

export async function generateSourcePage(
  store: Store,
  llm: LlmClient,
  doc: DocumentRow,
  content: string,
): Promise<string | null> {
  if (!llm.enabled) return null;
  const slug = slugify(doc.title ?? path.basename(doc.path));
  const rel = `wiki/sources/${slug}.md`;
  const abs = safePath(store.dataDir, rel);
  if (fs.existsSync(abs) && !/^generated:\s*true/m.test(fs.readFileSync(abs, 'utf8'))) return rel;

  const body = await llm.complete([
    { role: 'system', content: SOURCE_SYSTEM },
    { role: 'user', content: `Source file: ${doc.path}\n\n${content.slice(0, 14_000)}` },
  ], { maxTokens: 1200 });

  const page = [
    '---',
    `title: ${JSON.stringify(doc.title ?? slug)}`,
    'type: source',
    `source: ${JSON.stringify(doc.path)}`,
    'generated: true',
    '---',
    '',
    body.trim(),
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, page);
  appendLog(store.dataDir, 'wiki', `source page ${rel} for ${doc.path}`);
  return rel;
}

/** Create stub pages for high-mention entities that don't have a wiki page yet. */
export async function generateEntityStubs(store: Store, minMentions = 2, max = 30): Promise<string[]> {
  const entities = await store.query<EntityRow>(
    `SELECT * FROM entities WHERE wiki_path IS NULL AND mention_count >= $1
     ORDER BY mention_count DESC LIMIT $2`,
    [minMentions, max],
  );
  const created: string[] = [];
  for (const e of entities) {
    const rel = `wiki/entities/${e.id}.md`;
    const abs = safePath(store.dataDir, rel);
    if (fs.existsSync(abs)) {
      await store.query(`UPDATE entities SET wiki_path = $2 WHERE id = $1`, [e.id, rel]);
      continue;
    }
    const aliases = Array.isArray(e.aliases) ? e.aliases : [];
    const page = [
      '---',
      `title: ${JSON.stringify(e.name)}`,
      `type: ${e.type}`,
      `aliases: ${JSON.stringify(aliases)}`,
      'generated: true',
      '---',
      '',
      `# ${e.name}`,
      '',
      e.description || '_No description yet — fill me in._',
      '',
    ].join('\n');
    fs.writeFileSync(abs, page);
    await store.query(`UPDATE entities SET wiki_path = $2 WHERE id = $1`, [e.id, rel]);
    created.push(rel);
  }
  if (created.length > 0) appendLog(store.dataDir, 'wiki', `${created.length} entity stubs created`);
  return created;
}

/**
 * Generate wiki pages for indexed raw documents that don't have a source page
 * yet. Returns the list of generated page paths.
 */
export async function generateWiki(
  store: Store,
  llm: LlmClient,
  opts: { limit?: number; onProgress?: (msg: string) => void } = {},
): Promise<string[]> {
  const progress = opts.onProgress ?? (() => {});
  const created: string[] = [];
  if (llm.enabled) {
    const docs = await store.query<DocumentRow>(
      `SELECT * FROM documents WHERE root = 'docs' AND status = 'indexed' ORDER BY updated_at DESC LIMIT $1`,
      [opts.limit ?? 20],
    );
    for (const doc of docs) {
      const slug = slugify(doc.title ?? path.basename(doc.path));
      const abs = safePath(store.dataDir, `wiki/sources/${slug}.md`);
      if (fs.existsSync(abs)) continue;
      try {
        const content = fs.readFileSync(safePath(store.dataDir, doc.path), 'utf8');
        progress(`summarizing ${doc.path}`);
        const rel = await generateSourcePage(store, llm, doc, content);
        if (rel) created.push(rel);
      } catch (err) {
        progress(`summary failed for ${doc.path}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  created.push(...await generateEntityStubs(store));
  return created;
}
