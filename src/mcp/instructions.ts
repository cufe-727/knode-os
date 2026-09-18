import fs from 'node:fs';
import path from 'node:path';
import { GUIDE_FILE } from '../fs/datadir.js';

/**
 * The MCP server's `instructions`: how to use knode-os in three lines, plus
 * the knowledge base's own guide (`AGENTS.md` at the data root, written by
 * an initialization job) so an agent that connects from anywhere learns the
 * base the same way a research or chat session does. The HTTP endpoint builds
 * a server per request, so the text is cached by the guide file's mtime.
 */

const MAX_GUIDE_CHARS = 6_000;

const PREAMBLE = [
  'knode-os is a local knowledge base: documents → entities / relations / claims → wiki pages. For a question start with knode_resolve; knode_search (mode=sag) finds passages, knode_claims dated facts, knode_graph_search relations; as_of / valid_at travel in time.',
  `Read the base's own guide first — knode_read "${GUIDE_FILE}" (what it holds, how things are named, which tool answers which question) — and knode_survey for the current numbers.`,
  'Writes go through knode_write (wiki/, raw/docs/, playbooks/packs/) and land quarantined until a person promotes them; a contradiction opens a dispute instead of overwriting.',
].join('\n');

const cache = new Map<string, { key: string; text: string }>();

export function mcpInstructions(dataDir: string): string {
  const file = path.join(dataDir, GUIDE_FILE);
  let key = 'none';
  try {
    const st = fs.statSync(file);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    key = 'none';
  }
  const hit = cache.get(dataDir);
  if (hit && hit.key === key) return hit.text;
  let text = PREAMBLE;
  if (key !== 'none') {
    try {
      const guide = fs.readFileSync(file, 'utf8').trim();
      if (guide) {
        const body = guide.length > MAX_GUIDE_CHARS ? `${guide.slice(0, MAX_GUIDE_CHARS)}\n…（截断；完整指南用 knode_read ${GUIDE_FILE} 读取）` : guide;
        text = `${PREAMBLE}\n\n--- ${GUIDE_FILE} (this knowledge base's guide) ---\n${body}`;
      }
    } catch {
      /* unreadable guide: preamble only */
    }
  }
  cache.set(dataDir, { key, text });
  return text;
}
