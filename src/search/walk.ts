import { Store } from '../store/db.js';
import { toDateString } from '../store/temporal.js';
import { ClaimItem, SearchResult } from '../types.js';
import { keywordTerms, termCount } from './search.js';

/**
 * The multi-hop route of `ask` (docs/design/30 §3): resolve → relations →
 * read, for a bounded number of hops, without a model call per hop.
 *
 * From the entities the question names, each hop reads their live relations,
 * keeps the few whose type, description or far end share the question's terms
 * (the heaviest first among equals), and moves the frontier to the far ends.
 * For every relation kept, the passage where its two ends are mentioned
 * together is read: that is the sentence that states the hop. The walk ends
 * at `maxHops`, or when no relation matches the question at all past the
 * first hop (a walk that has stopped being about the question).
 *
 * What `ask` gets: the relations walked, as facts with their source; the
 * bridge passages, as context beside the SAG search's; and the entities
 * reached, whose claims join the facts. One completion still writes the
 * answer.
 */

export interface WalkStep {
  hop: number;
  relationId: string;
  source: string;
  sourceId: string;
  target: string;
  targetId: string;
  type: string;
  description: string;
  path: string | null;
  validFrom: string | null;
  validTo: string | null;
}

export interface Walk {
  steps: WalkStep[];
  /** Entities reached past the named ones. */
  reached: string[];
  /** Passages where a walked relation's two ends are mentioned together. */
  bridges: SearchResult[];
}

/** Relations kept per hop. */
const FRONTIER = 5;
/** Relations read per hop before scoring. */
const READ_CAP = 300;

interface RelRow {
  id: string; source_id: string; target_id: string; source: string; target: string; type: string; description: string;
  weight: number; path: string | null; valid_from: string | Date | null; valid_to: string | Date | null;
}

export async function walkRelations(store: Store, question: string, named: string[], opts: { maxHops?: number } = {}): Promise<Walk> {
  const maxHops = Math.min(Math.max(opts.maxHops ?? 3, 1), 4);
  const out: Walk = { steps: [], reached: [], bridges: [] };
  if (named.length === 0) return out;
  const terms = keywordTerms(question).map((t) => t.toLowerCase());
  const visited = new Set(named);
  const used = new Set<string>();
  let frontier = [...named];

  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    const rows = await store.query<RelRow>(
      `SELECT r.id, r.source_id, r.target_id, se.name AS source, te.name AS target, r.type, r.description, r.weight,
              r.valid_from, r.valid_to,
              COALESCE((SELECT d.path FROM documents d WHERE d.id = r.document_id),
                       (SELECT s.key FROM evidence ev JOIN scopes s ON s.id = ev.scope_id
                        WHERE ev.kind = 'relation' AND ev.target_id = r.id AND ev.tx_to IS NULL ORDER BY ev.tx_from, s.key LIMIT 1)) AS path
       FROM relations r JOIN entities se ON se.id = r.source_id JOIN entities te ON te.id = r.target_id
       WHERE (r.source_id = ANY($1::text[]) OR r.target_id = ANY($1::text[])) AND r.tx_to IS NULL AND r.type <> 'co_occurs'
       ORDER BY r.weight DESC, r.id LIMIT $2`,
      [frontier, READ_CAP],
    );
    const inFrontier = new Set(frontier);
    const scored = rows
      .filter((r) => !used.has(r.id))
      .map((r) => {
        const far = inFrontier.has(r.source_id) ? r.target : r.source;
        const text = `${r.type.replace(/_/g, ' ')} ${r.description} ${far}`.toLowerCase();
        const score = terms.reduce((n, t) => n + (termCount(text, t) > 0 ? 1 : 0), 0);
        return { r, score, farId: inFrontier.has(r.source_id) ? r.target_id : r.source_id };
      })
      .filter((x) => !visited.has(x.farId) || x.score > 0)
      .sort((a, b) => b.score - a.score || b.r.weight - a.r.weight || (a.r.id < b.r.id ? -1 : 1));
    // past the first hop, only relations that match the question lead on
    const kept = (hop === 1 ? scored : scored.filter((x) => x.score > 0)).slice(0, FRONTIER);
    if (kept.length === 0) break;
    const next: string[] = [];
    for (const { r, farId } of kept) {
      used.add(r.id);
      out.steps.push({
        hop, relationId: r.id, source: r.source, sourceId: r.source_id, target: r.target, targetId: r.target_id,
        type: r.type, description: r.description, path: r.path, validFrom: toDateString(r.valid_from), validTo: toDateString(r.valid_to),
      });
      if (!visited.has(farId)) {
        visited.add(farId);
        next.push(farId);
        out.reached.push(farId);
      }
    }
    frontier = next;
  }

  out.bridges = await bridgePassages(store, out.steps);
  return out;
}

/** For each step, one chunk mentioning both of its ends (the most recent document first). */
async function bridgePassages(store: Store, steps: WalkStep[]): Promise<SearchResult[]> {
  if (steps.length === 0) return [];
  const rows = await store.query<{ i: number; chunk_id: string; document_id: string; path: string; title: string | null; content: string; doc_date: string | Date | null }>(
    `SELECT pair.i, c.id AS chunk_id, c.document_id, d.path, d.title, c.content, d.doc_date
     FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS pair(a, b, i)
     CROSS JOIN LATERAL (
       SELECT m1.chunk_id FROM entity_mentions m1
       JOIN entity_mentions m2 ON m2.chunk_id = m1.chunk_id AND m2.entity_id = pair.b
       WHERE m1.entity_id = pair.a
       LIMIT 1
     ) x
     JOIN chunks c ON c.id = x.chunk_id
     JOIN documents d ON d.id = c.document_id`,
    [steps.map((s) => s.sourceId), steps.map((s) => s.targetId)],
  );
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of rows.sort((a, b) => Number(a.i) - Number(b.i))) {
    if (seen.has(r.chunk_id)) continue;
    seen.add(r.chunk_id);
    const step = steps[Number(r.i) - 1];
    out.push({
      chunkId: r.chunk_id, documentId: r.document_id, path: r.path, title: r.title, content: r.content,
      docDate: toDateString(r.doc_date), score: 0, signals: { structural: step.hop },
      trace: { route: 'sag', hop: step.hop, bridgeEntities: [step.source, step.target] },
    });
  }
  return out;
}

/** The walked relations as facts `ask` lists: "A acquired B: description", with their source. */
export function stepsAsFacts(steps: WalkStep[]): (ClaimItem & { chunkId: string | null })[] {
  return steps.map((s) => ({
    id: `relation:${s.relationId}`,
    subject: s.source,
    object: s.target,
    type: s.type,
    statement: `${s.source} ${s.type.replace(/_/g, ' ')} ${s.target}${s.description ? `: ${s.description}` : ''}`,
    status: 'fact',
    kind: 'fact',
    startDate: s.validFrom,
    endDate: s.validTo,
    eventDate: null,
    path: s.path,
    chunkId: null,
  }));
}
