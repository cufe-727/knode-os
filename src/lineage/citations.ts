import { citationKeys, citationLabel } from '../graph/citations.js';
import { loadOntology } from '../graph/ontology.js';
import { Store } from '../store/db.js';
import { ResolvedScopeFilter, scopeAccessSql } from '../store/resolver.js';
import { live, Params, TimeInput } from '../store/temporal.js';
import { TrustTier } from './trust.js';

/**
 * Citations read back (written at ingest, src/graph/citations.ts): the pages
 * citing a raw/docs file — the "Cited by" list a file view shows — and the
 * files a page cites. A row lives as long as the scope of the page that wrote
 * it, so `asOf` answers what was cited then.
 */

export interface CitationLinkView {
  type: string;
  inverse: boolean;
  /** The predicate as the page states it toward the file: an inverse row reads as its inverse name (`tests`). */
  label: string;
  via: string;
  fragment: string | null;
}

export interface CitingPage {
  path: string;
  title: string | null;
  /** The citing source's tier: an agent's page stays quarantined until someone promotes it. */
  trust: TrustTier;
  links: CitationLinkView[];
}

export interface CitedFile extends CitationLinkView {
  target: string;
}

/**
 * The pages citing `filePath`, each with its links, by page path. A target is
 * matched as the app's link resolver would open it — `raw/docs/x` names
 * `raw/docs/x.md` — and without regard to case. The title is the one the
 * citing scope was applied with (a view's human prose takes its page's).
 */
export async function citedBy(store: Store, filePath: string, opts: { asOf?: TimeInput; filter?: ResolvedScopeFilter } = {}): Promise<CitingPage[]> {
  const p = new Params([citationKeys(filePath)]);
  const rows = await store.query<{
    source_path: string; title: string | null; trust: TrustTier; type: string; inverse: boolean; via: string; fragment: string | null;
  }>(
    `SELECT c.source_path, COALESCE(s.meta->>'title', ps.meta->>'title') AS title, s.trust,
            c.type, c.inverse, c.via, c.fragment
     FROM citations c
     JOIN scopes s ON s.id = c.scope_id
     LEFT JOIN scopes ps ON ps.id = s.parent_id
     WHERE lower(c.target_path) = ANY($1::text[]) AND ${live('c', p, opts.asOf)}
       AND ${opts.filter ? scopeAccessSql('s', p, opts.filter) : 'TRUE'}
     ORDER BY c.source_path, c.seq`,
    p.list,
  );
  const ontology = loadOntology(store.dataDir);
  const pages = new Map<string, CitingPage>();
  for (const r of rows) {
    let page = pages.get(r.source_path);
    if (!page) pages.set(r.source_path, (page = { path: r.source_path, title: r.title, trust: r.trust, links: [] }));
    page.links.push({ type: r.type, inverse: r.inverse, label: citationLabel(ontology, r.type, r.inverse), via: r.via, fragment: r.fragment });
  }
  return [...pages.values()];
}

/** The files a page cites, in the order it wrote them. */
export async function citesOf(store: Store, sourcePath: string, opts: { asOf?: TimeInput } = {}): Promise<CitedFile[]> {
  const p = new Params([sourcePath]);
  const rows = await store.query<{ target_path: string; type: string; inverse: boolean; via: string; fragment: string | null }>(
    `SELECT c.target_path, c.type, c.inverse, c.via, c.fragment
     FROM citations c
     WHERE c.source_path = $1 AND ${live('c', p, opts.asOf)}
     ORDER BY c.seq`,
    p.list,
  );
  const ontology = loadOntology(store.dataDir);
  return rows.map((r) => ({
    target: r.target_path,
    type: r.type,
    inverse: r.inverse,
    label: citationLabel(ontology, r.type, r.inverse),
    via: r.via,
    fragment: r.fragment,
  }));
}
