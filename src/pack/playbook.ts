import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { PACKS_DIR } from '../fs/layout.js';

/**
 * Playbooks are the "script" form of a context pack: agent-readable,
 * agent-editable markdown files under <data>/playbooks/packs/. The frontmatter declares
 * which entities the playbook applies to, how to retrieve documents, and
 * which live probe queries to run; the body is guidance handed to the agent
 * verbatim. The learning loop (src/pack/learn.ts) revises these files based
 * on pack_events, so every query makes the next one cheaper.
 *
 * ```yaml
 * type: playbook
 * appliesTo: organization          # entity type, "entity:<slug>", or "default"
 * retrieval: { k: 6, mode: hybrid }
 * probes:
 *   - id: latest-quote
 *     source: market-mysql
 *     table: daily_quotes
 *     description: 最近 5 个交易日行情
 *     sql: "SELECT ... WHERE symbol = {symbol} ORDER BY trade_date DESC LIMIT 5"
 * suggestions:
 *   - "行情数据以 market-mysql 为准，历史回溯用 hist-parquet"
 * ```
 *
 * SQL templates support {name}, {symbol} and {alias} placeholders, filled from
 * the matched entity and inlined as escaped string literals.
 */

export interface PlaybookProbe {
  id: string;
  source: string;
  sql: string;
  table?: string;
  description?: string;
}

export interface Playbook {
  /** Path relative to the data dir, e.g. playbooks/packs/organization.md. */
  path: string;
  appliesTo: string;
  retrieval: { k: number; mode: 'hybrid' | 'vector' | 'keyword' | 'sag' };
  probes: PlaybookProbe[];
  suggestions: string[];
  /** Markdown body — guidance forwarded to the agent. */
  guidance: string;
}

export function loadPlaybooks(dataDir: string): Playbook[] {
  const dir = path.join(dataDir, PACKS_DIR);
  if (!fs.existsSync(dir)) return [];
  const out: Playbook[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const parsed = parsePlaybook(fs.readFileSync(path.join(dir, file), 'utf8'), `${PACKS_DIR}/${file}`);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parsePlaybook(raw: string, relPath: string): Playbook | null {
  let fm: Record<string, unknown>;
  let body: string;
  try {
    const p = matter(raw);
    fm = p.data as Record<string, unknown>;
    body = p.content;
  } catch {
    return null;
  }
  if (fm.type !== 'playbook') return null;
  const retrieval = (fm.retrieval ?? {}) as Record<string, unknown>;
  const mode = typeof retrieval.mode === 'string' && ['hybrid', 'vector', 'keyword', 'sag'].includes(retrieval.mode)
    ? (retrieval.mode as Playbook['retrieval']['mode'])
    : 'hybrid';
  const k = Number(retrieval.k);
  const probes: PlaybookProbe[] = [];
  for (const raw of Array.isArray(fm.probes) ? fm.probes : []) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.source !== 'string' || typeof o.sql !== 'string') continue;
    probes.push({
      id: o.id,
      source: o.source,
      sql: o.sql,
      table: typeof o.table === 'string' ? o.table : undefined,
      description: typeof o.description === 'string' ? o.description : undefined,
    });
  }
  return {
    path: relPath,
    appliesTo: typeof fm.appliesTo === 'string' && fm.appliesTo.trim() ? fm.appliesTo.trim() : 'default',
    retrieval: { k: Number.isFinite(k) && k >= 1 ? Math.floor(k) : 6, mode },
    probes,
    suggestions: Array.isArray(fm.suggestions) ? fm.suggestions.map(String) : [],
    guidance: body.trim(),
  };
}

export interface PlaybookEntity {
  id: string;
  type: string;
  name: string;
  aliases: string[];
}

/** Most specific playbook wins: entity:<slug> > entity type > default. */
export function resolvePlaybook(playbooks: Playbook[], entity: Pick<PlaybookEntity, 'id' | 'type'>): Playbook | null {
  return (
    playbooks.find((p) => p.appliesTo === `entity:${entity.id}`) ??
    playbooks.find((p) => p.appliesTo === entity.type) ??
    playbooks.find((p) => p.appliesTo === 'default') ??
    null
  );
}

/** Ticker-like alias preferred for {symbol}: numeric codes (300750, 600519.SH) beat letter tickers (CATL). */
export function entitySymbol(entity: Pick<PlaybookEntity, 'name' | 'aliases'>): string {
  const aliases = Array.isArray(entity.aliases) ? entity.aliases : [];
  return (
    aliases.find((a) => /^[0-9]{4,6}(\.[A-Z]{2})?$/.test(a)) ??
    aliases.find((a) => /^[A-Z]{1,6}[0-9]*$/.test(a)) ??
    aliases[0] ??
    entity.name
  );
}

export function renderProbeSql(template: string, entity: Pick<PlaybookEntity, 'name' | 'aliases'>, escape: (v: string) => string): string {
  const aliases = Array.isArray(entity.aliases) ? entity.aliases : [];
  return template
    .replace(/\{name\}/g, escape(entity.name))
    .replace(/\{symbol\}/g, escape(entitySymbol(entity)))
    .replace(/\{alias\}/g, escape(aliases[0] ?? entity.name));
}

/** The fallback playbook seeded as `playbooks/packs/default.md`; Settings resets an edited copy to it. */
export const DEFAULT_PLAYBOOK = `---
type: playbook
appliesTo: default
retrieval:
  k: 6
  mode: hybrid
probes: []
suggestions: []
---

# Default context playbook

Applies to any matched entity without a more specific playbook.

- Retrieved documents and claims come from the local knowledge base; check claim \`status\` and \`endDate\` before trusting them.
- If the entity is linked to live datasets, query them natively with \`knode_query\` for current values instead of relying on indexed snapshots.
- If evidence is thin, try \`knode_search\` with different phrasings, or \`knode_grep\` for exact strings.
`;

/** Write the generic fallback playbook once (never overwrites user edits). */
export function ensureDefaultPlaybooks(dataDir: string): string[] {
  const created: string[] = [];
  const file = path.join(dataDir, PACKS_DIR, 'default.md');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, DEFAULT_PLAYBOOK);
    created.push(`${PACKS_DIR}/default.md`);
  }
  return created;
}
