import { ParsedMarkdown } from '../markdown.js';
import { parseDuration } from '../store/resolver.js';
import { CapabilityNote } from '../lineage/writer.js';

/**
 * The semantic layer over capabilities: metric definitions, join paths and the
 * pitfalls that only show up once someone has been burned by the data. It
 * lives in `capabilities/*.md`, which is itself a Source — so it is chunked,
 * searchable and revertible like any other document, and its *structured*
 * part additionally lands in `capability_notes`.
 *
 * ```yaml
 * ---
 * capability: market-mysql.daily_quotes     # or a list
 * cost: 2
 * freshness: 30s
 * sampleQueries:
 *   - "SELECT trade_date, close FROM daily_quotes WHERE symbol = {symbol} ORDER BY trade_date DESC LIMIT 5"
 * pitfalls:
 *   - "close 是未复权价；复权价在 adj_close"
 * joins:
 *   - "daily_quotes.symbol = companies.symbol"
 * ---
 * ```
 *
 * A note naming a capability that does not exist is kept, not dropped: the
 * source may be configured later, and silently discarding the semantics an
 * author wrote is worse than carrying a note nothing reads yet.
 */

export type CapabilityNoteDecl = Omit<CapabilityNote, 'source_path'>;

function stringList(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' ? x.trim() : JSON.stringify(x))).filter(Boolean);
}

/** Capability ids this document declares semantics for. */
export function declaredCapabilities(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter.capability ?? frontmatter.capabilities;
  return [...new Set(stringList(raw))];
}

export function isCapabilityDoc(frontmatter: Record<string, unknown>): boolean {
  return declaredCapabilities(frontmatter).length > 0;
}

/** Structured notes a capability document contributes, one per declared capability. */
export function parseCapabilityNotes(parsed: ParsedMarkdown): CapabilityNoteDecl[] {
  const fm = parsed.frontmatter;
  const ids = declaredCapabilities(fm);
  if (ids.length === 0) return [];

  let freshness: number | null = null;
  if (fm.freshness !== undefined && fm.freshness !== null && fm.freshness !== '') {
    try {
      freshness = parseDuration(fm.freshness as string | number);
    } catch {
      freshness = null; // an unparsable duration is a typo in prose, not a reason to drop the note
    }
  }
  const cost = Number(fm.cost);

  const note: CapabilityNoteDecl = {
    capability_id: '',
    // the body is the semantics: whatever the author wrote about this capability
    semantics: parsed.body.trim(),
    sample_queries: stringList(fm.sampleQueries ?? fm.sample_queries),
    pitfalls: stringList(fm.pitfalls),
    joins: stringList(fm.joins),
    cost: Number.isFinite(cost) && cost > 0 ? cost : null,
    freshness_seconds: freshness,
  };
  return ids.map((id) => ({ ...note, capability_id: id }));
}
