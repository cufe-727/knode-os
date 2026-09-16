import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { KnodeConfig } from '../config.js';
import { MAX_FILE_BYTES } from '../constants.js';
import { readSidecarPart, replayableTier1, updateSidecarPart } from '../fs/sidecar.js';
import { extractConcepts, wireConcepts } from '../graph/concepts.js';
import { frontmatterExtraction } from '../graph/frontmatter.js';
import { parseCapabilityNotes } from '../capability/notes.js';
import { TRUST_TIERS, TrustTier, detectDisputes, tierForActor } from '../lineage/trust.js';
import { applyExtraction } from '../graph/llm-extract.js';
import { PageContext } from '../graph/store.js';
import { applyWirePlan, extractWikilinks, planWireFromMarkdown, WikiIndex } from '../graph/wire.js';
import { isReservedWikiFile } from '../lineage/declared.js';
import { applyScope, findLiveScope } from '../lineage/scope.js';
import { ParsedMarkdown, parseFrontmatter, titleFromMarkdown } from '../markdown.js';
import { isGeneratedConcept } from '../okf/index.js';
import { restoreUsageFromSidecar } from '../stats/heat.js';
import { Store } from '../store/db.js';
import { DocRoot } from '../types.js';
import { hasProse, hasRegions, stripRegions } from '../wiki/regions.js';
import { chunkText } from './chunker.js';
import { docDateOf } from './docdate.js';
import { EmbeddingProvider } from './embeddings.js';
import { loadSourceText, sha256 } from './source.js';

/**
 * Apply one file as a document scope: chunk → embed (reusing unchanged
 * content-addressed chunks) → search projection → tier-0 graph evidence, all
 * inside one scope transaction. Tier-1 sidecar replays and the human-written
 * parts of generated pages become child scopes of the document's scope.
 *
 * The text comes from src/ingest/source.ts: raw text normalized in memory, or
 * the sidecar's content.md for converted originals and trace episodes.
 *
 * Sources vs views:
 *   - sources (raw docs, skills, human wiki pages, anchors) contribute
 *     entities / relations / claims;
 *   - views (generated pages, recognised by a live `pages` row or
 *     `generated: true` without an explicit `actor`) are indexed for search only.
 *     A page that names its author (`actor: agent/…`, a research page) is a
 *     Source whatever its `generated` key says — trust follows that actor. Only prose a human wrote
 *     outside the managed regions counts as evidence (`extractor: human`) —
 *     that is what stops a stub page from resurrecting the entity it describes.
 *   - reserved files (index.md / log.md) never touch the graph.
 */

export interface ApplyDocContext {
  store: Store;
  config: KnodeConfig;
  embedder: EmbeddingProvider;
}

export interface ApplyDocOptions {
  /** Queue the document for tier-1 LLM extraction when no sidecar replay exists. */
  queueTier1?: boolean;
  actor?: string;
  at?: string;
  wikiIndex?: WikiIndex;
  onProgress?: (msg: string) => void;
}

export interface DocOutcome {
  outcome: 'applied' | 'unchanged' | 'skipped';
  chunks: number;
  entities: number;
  relations: number;
  scopeId: string | null;
}

export function documentIdFor(file: string): string {
  return crypto.createHash('sha256').update(file).digest('hex').slice(0, 24);
}

export function chunkIdFor(docId: string, seq: number, content: string): string {
  return crypto.createHash('sha256').update(`${docId}|${seq}|${content}`).digest('hex').slice(0, 32);
}

interface Classification {
  kind: 'source' | 'view';
  graph: boolean;
  /** undefined = planner default (every non-reserved wiki / imported OKF page) */
  selfEntity: boolean | undefined;
  humanBody: string;
}

async function classify(store: Store, file: string, root: DocRoot, parsed: ParsedMarkdown): Promise<Classification> {
  if (root !== 'wiki') return { kind: 'source', graph: true, selfEntity: undefined, humanBody: parsed.body };
  if (isReservedWikiFile(file)) return { kind: 'source', graph: false, selfEntity: false, humanBody: parsed.body };
  const [pageRow] = await store.query<{ status: string }>(`SELECT status FROM pages WHERE path = $1 AND tx_to IS NULL`, [file]);
  const authored = typeof parsed.frontmatter.actor === 'string' && parsed.frontmatter.actor.trim() !== '';
  const generated = pageRow !== undefined || (isGeneratedConcept(parsed.frontmatter) && !authored);
  if (generated) {
    // legacy generated pages without markers are fully managed
    const humanBody = hasRegions(parsed.body) ? stripRegions(parsed.body) : '';
    const graph = hasProse(humanBody);
    return { kind: 'view', graph, selfEntity: graph, humanBody };
  }
  return { kind: 'source', graph: true, selfEntity: undefined, humanBody: parsed.body };
}

export async function applyDocScope(ctx: ApplyDocContext, file: string, root: DocRoot, opts: ApplyDocOptions = {}): Promise<DocOutcome> {
  const { store, config, embedder } = ctx;
  const progress = opts.onProgress ?? (() => {});
  const actor = opts.actor ?? 'sync';
  const none = { chunks: 0, entities: 0, relations: 0, scopeId: null };
  const source = loadSourceText(store.dataDir, file, root);
  if (!source) return { outcome: 'skipped', ...none };
  const raw = source.text;
  const bytes = Buffer.byteLength(raw);
  if (bytes > MAX_FILE_BYTES) return { outcome: 'skipped', ...none };
  const sha = sha256(raw);
  const docId = documentIdFor(file);

  const live = await findLiveScope(store, 'doc', file);
  const sameModel = live?.meta.embedModel === embedder.model;
  if (live && live.sha === sha && sameModel) {
    // a sidecar may have gained a replayable tier-1 extraction since (copied
    // from another machine, or written by a bench run) — apply it as the
    // document's child scope without re-indexing the document itself
    if (root === 'docs') await ensureTier1Replay(store, file, sha, docId, live.id, opts);
    return { outcome: 'unchanged', ...none, scopeId: live.id };
  }

  progress(`indexing ${file}`);
  const parsed = parseFrontmatter(raw);
  const title = titleFromMarkdown(file, parsed);
  const cls = await classify(store, file, root, parsed);
  const docDate = docDateOf(file, parsed.frontmatter);

  /* ── pure preparation: chunking, embeddings (network), tier-0 plans ── */
  const pieces = await chunkText(file, parsed.body, config.ingest, { markdown: source.derived || undefined });
  const chunkRows = pieces.map((p, i) => ({ id: chunkIdFor(docId, i, p.content), seq: i, content: p.content, tokenCount: p.tokenCount }));
  const vectors = new Map<string, number[]>();
  if (chunkRows.length > 0) {
    const ph = chunkRows.map((_, i) => `$${i + 2}`).join(',');
    const have = new Set(
      (await store.query<{ chunk_id: string }>(`SELECT chunk_id FROM embeddings WHERE model = $1 AND chunk_id IN (${ph})`, [embedder.model, ...chunkRows.map((c) => c.id)]))
        .map((r) => r.chunk_id),
    );
    const missing = chunkRows.filter((c) => !have.has(c.id));
    if (missing.length > 0) {
      const vecs = await embedder.embed(missing.map((c) => c.content));
      missing.forEach((c, i) => vectors.set(c.id, vecs[i]));
    }
  }

  const page: PageContext = { documentId: docId, path: file, title: title ?? path.basename(file), chunkIds: chunkRows.map((c) => ({ id: c.id, content: c.content })) };
  const isSource = cls.kind === 'source';
  // a source wiki page may carry machine-maintained regions (a timeline the
  // page generator refreshes); only its prose is evidence, the regions are not
  const sourceBody = root === 'wiki' && hasRegions(parsed.body) ? stripRegions(parsed.body) : parsed.body;
  const wirePlan = isSource && cls.graph
    ? planWireFromMarkdown(store.dataDir, page, parsed, { selfEntity: cls.selfEntity, wikiIndex: opts.wikiIndex, body: sourceBody })
    : null;
  const humanPlan = !isSource && cls.graph
    ? planWireFromMarkdown(store.dataDir, page, { frontmatter: parsed.frontmatter, body: cls.humanBody }, { selfEntity: true, body: cls.humanBody, wikiIndex: opts.wikiIndex })
    : null;
  const concepts = root === 'docs' && isSource ? extractConcepts(parsed.body) : [];
  const declared = root === 'docs' && isSource ? frontmatterExtraction(parsed.frontmatter) : null;
  const capabilityNotes = root === 'capabilities' ? parseCapabilityNotes(parsed) : [];
  // Trust follows the *document's* origin, not whoever happened to run this
  // sync. A note an agent wrote stays agent-written; sync is a mechanical
  // reconciliation, not the author. Frontmatter may also say so outright.
  const declaredTrust = typeof parsed.frontmatter.trust === 'string' && TRUST_TIERS.includes(parsed.frontmatter.trust as TrustTier)
    ? (parsed.frontmatter.trust as TrustTier)
    : typeof parsed.frontmatter.actor === 'string'
      ? tierForActor(parsed.frontmatter.actor)
      : undefined;
  const declaredAcl = Array.isArray(parsed.frontmatter.acl) ? parsed.frontmatter.acl.map(String) : undefined;
  const tier1 = root === 'docs' && isSource ? replayableTier1(readSidecarPart(store.dataDir, file, 'tier1'), sha) : null;

  /* ── the document scope ── */
  let g = { entities: 0, relations: 0 };
  const res = await applyScope(
    store,
    { kind: 'doc', key: file },
    sha,
    {
      actor,
      at: opts.at,
      force: Boolean(live && !sameModel),
      keepProjectionOnReplace: true,
      trust: declaredTrust,
      acl: declaredAcl,
      meta: { documentId: docId, embedModel: embedder.model, root, kind: cls.kind, title },
    },
    async (w) => {
      await w.document(
        { id: docId, path: file, root, title, sha256: sha, mime: guessMime(file), bytes, kind: cls.kind, docDate },
        chunkRows,
        vectors,
        embedder.model,
      );
      if (wirePlan) {
        const s = await applyWirePlan(w, page, wirePlan, { extractor: 'tier0.wikilink' });
        g = { entities: g.entities + s.entities, relations: g.relations + s.relations };
        // a bundle page may declare entities, typed relations and claims in its
        // frontmatter (research pages do); its own entity is the default subject
        if (wirePlan.self && (parsed.frontmatter.relations || parsed.frontmatter.claims || parsed.frontmatter.entities)) {
          const declaredWiki = frontmatterExtraction(
            { relations: parsed.frontmatter.relations, claims: parsed.frontmatter.claims, entities: parsed.frontmatter.entities },
            { defaultSource: wirePlan.self.name },
          );
          if (declaredWiki) {
            const dg = await applyExtraction(w, page, declaredWiki.entities, declaredWiki.relations, declaredWiki.claims, 'tier0.frontmatter', { docDate });
            g = { entities: g.entities, relations: g.relations + dg.relations };
          }
        }
      }
      if (root === 'docs' && isSource) {
        // declared facts first: they carry names, types and aliases the concept
        // miner's bare terms then resolve onto instead of minting duplicates
        if (declared) {
          const dg = await applyExtraction(w, page, declared.entities, declared.relations, declared.claims, 'tier0.frontmatter', { docDate });
          g = { entities: g.entities + dg.entities, relations: g.relations + dg.relations };
        }
        const cg = await wireConcepts(w, page, concepts);
        g = { entities: g.entities + cg.entities, relations: g.relations + cg.relations };
        if (!tier1 && opts.queueTier1) await w.enqueueTier1(docId);
      }
      // a capabilities/*.md file is an ordinary source *and* the semantic layer
      // over the capabilities it names: both halves belong to this one scope,
      // so removing the file retires the notes with it
      for (const note of capabilityNotes) await w.capabilityNote({ ...note, source_path: file });
    },
  );

  // a quarantined source cannot silently become the knowledge base's position:
  // where it disagrees with a trusted claim, the disagreement is recorded
  if (res.outcome === 'applied') await detectDisputes(store, res.scope.id);

  /* ── child scopes: human prose on a generated page, tier-1 replay ── */
  if (humanPlan) {
    const humanSha = crypto.createHash('sha256').update(cls.humanBody).digest('hex');
    await applyScope(
      store,
      { kind: 'wiki-human', key: file },
      humanSha,
      { parentId: res.scope.id, actor, at: opts.at, meta: { documentId: docId } },
      async (w) => {
        const s = await applyWirePlan(w, page, humanPlan, { extractor: 'human' });
        g = { entities: g.entities + s.entities, relations: g.relations + s.relations };
      },
    );
  }

  if (root === 'docs' && isSource) {
    // sidecar: chunk map + tier-0 extraction results; restore usage on rebuild
    const now = new Date().toISOString();
    const meta = updateSidecarPart(store.dataDir, file, 'meta', (m) => ({
      ...m!,
      title,
      docDate,
      contentSha256: sha,
      ingestedAt: now,
      chunks: chunkRows.map((c) => ({ id: c.id, seq: c.seq, tokenCount: c.tokenCount })),
    }));
    if (meta) {
      updateSidecarPart(store.dataDir, file, 'tier0', () => ({
        contentSha: sha,
        concepts,
        wikilinks: extractWikilinks(parsed.body),
        extractedAt: now,
        declared: declared ? { entities: declared.entities, relations: declared.relations, claims: declared.claims } : null,
      }));
      await restoreUsageFromSidecar(store, docId, readSidecarPart(store.dataDir, file, 'usage'));
    }

    if (tier1) {
      await applyScope(
        store,
        { kind: 'tier1', key: file },
        sha,
        { parentId: res.scope.id, actor: 'tier1', at: opts.at, meta: { documentId: docId, model: tier1.model } },
        async (w) => {
          const lg = await applyExtraction(w, page, tier1.entities, tier1.relations, tier1.claims ?? [], `tier1.llm:${tier1.model}`, { docDate });
          g = { entities: g.entities + lg.entities, relations: g.relations + lg.relations };
        },
      );
    }
  }

  return { outcome: 'applied', chunks: chunkRows.length, entities: g.entities, relations: g.relations, scopeId: res.scope.id };
}

async function ensureTier1Replay(store: Store, file: string, sha: string, docId: string, parentId: string, opts: ApplyDocOptions): Promise<void> {
  const tier1 = replayableTier1(readSidecarPart(store.dataDir, file, 'tier1'), sha);
  if (!tier1) return;
  const child = await findLiveScope(store, 'tier1', file);
  if (child && child.sha === sha) return;
  const chunks = await store.query<{ id: string; content: string }>(`SELECT id, content FROM chunks WHERE document_id = $1 ORDER BY seq`, [docId]);
  const [docRow] = await store.query<{ doc_date: string | Date | null }>(`SELECT doc_date FROM documents WHERE id = $1`, [docId]);
  const docDate = docRow?.doc_date ? new Date(docRow.doc_date).toISOString() : null;
  const page: PageContext = { documentId: docId, path: file, title: path.basename(file), chunkIds: chunks };
  await applyScope(
    store,
    { kind: 'tier1', key: file },
    sha,
    { parentId, actor: 'tier1', at: opts.at, meta: { documentId: docId, model: tier1.model } },
    async (w) => {
      await applyExtraction(w, page, tier1.entities, tier1.relations, tier1.claims ?? [], `tier1.llm:${tier1.model}`, { docDate });
    },
  );
}

export function guessMime(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain',
    '.json': 'application/json', '.jsonl': 'application/jsonl', '.yaml': 'text/yaml',
    '.yml': 'text/yaml', '.csv': 'text/csv', '.html': 'text/html', '.pdf': 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}
