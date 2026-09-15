import crypto from 'node:crypto';
import fs from 'node:fs';
import { safePath } from '../fs/files.js';
import {
  CLAIM_STATUS,
  claimId,
  ENTITY_TYPES,
  ExtractedEntity,
  RELATION_TYPES,
  relationId,
  slugify,
} from '../graph/store.js';
import { toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { Queryable } from '../store/migrations.js';
import { toIso } from '../store/temporal.js';
import { DocRoot, SuggestionRow } from '../types.js';
import { storeBlob } from './attic.js';
import { readDeps, writeDeps } from './deps.js';
import { replaceRegion, splitRegions } from '../wiki/regions.js';
import { TrustTier } from './trust.js';
import {
  ArtifactKind,
  DepDecl,
  EffectKind,
  emptyTouched,
  EvidenceRef,
  FsOp,
  InverseSpec,
  ScopeRow,
  TouchedSet,
  WriterStats,
} from './types.js';

/**
 * The effect writer: everything a scope body writes goes through here, so
 * every write is either implicit evidence (closed by scope id on dispose) or
 * an explicit effect whose inverse is recorded before the forward action.
 *
 * Bound to one scope and one open transaction. Bodies must not await
 * network / LLM / embedding calls — compute first, write second — so the
 * single PGlite connection is held briefly.
 */

export interface DocumentProjection {
  id: string;
  path: string;
  root: DocRoot;
  title: string | null;
  sha256: string;
  mime: string;
  bytes: number;
  kind: 'source' | 'view';
}

export interface ChunkRow {
  id: string;
  seq: number;
  content: string;
  tokenCount: number;
}

export interface DatasetUpsert {
  id: string;
  source_id: string;
  table_name: string;
  kind: string;
  columns: { name: string; type: string }[];
  row_count: number | null;
  schema_sha: string;
  description: string;
  entity_count: number;
}

export interface CapabilityUpsert {
  /** Logical id, stable across re-applies: `<source>.<name>`. */
  id: string;
  kind: 'table' | 'endpoint' | 'metric' | 'tool';
  source_id: string;
  name: string;
  title?: string;
  /** How a request against this capability is written: sql, promql, http, object, tool. */
  dialect?: string;
  /** The dataset / tool entity this capability corresponds to, when there is one. */
  entity_id?: string | null;
  schema?: unknown;
  semantics?: string;
  sample_queries?: unknown[];
  freshness_seconds?: number | null;
  cost?: number;
  acl?: unknown[];
  placement?: 'materialize' | 'federate' | 'cache';
}

export interface CapabilityNote {
  capability_id: string;
  source_path: string;
  semantics?: string;
  sample_queries?: unknown[];
  pitfalls?: unknown[];
  joins?: unknown[];
  cost?: number | null;
  freshness_seconds?: number | null;
}

export interface PageUpsert {
  path: string;
  kind: string;
  generator: string;
  inputs_sha: string;
  file_sha: string | null;
  regions: { id: string; sha: string }[];
}

export interface NewSuggestion {
  id?: string;
  kind: SuggestionRow['kind'];
  title: string;
  body: string;
  evidence: SuggestionRow['evidence'] | EvidenceRef[];
  reportPath?: string | null;
  payload?: unknown;
}

export class ScopeWriter {
  readonly touched: TouchedSet = emptyTouched();
  readonly fsOps: FsOp[] = [];
  readonly stats: WriterStats = { entities: 0, relations: 0, claims: 0, mentions: 0, chunks: 0, effects: 0, capabilities: 0, locators: 0 };
  private readonly seenEvidence = new Set<string>();
  /** Entity ids known to exist in this transaction (created here or verified once). */
  private readonly knownEntities = new Set<string>();

  constructor(
    readonly q: Queryable,
    readonly scope: ScopeRow,
    readonly txTime: string,
    readonly dataDir: string,
    /** Tier every evidence row this scope writes is stamped with. */
    readonly trust: TrustTier = 'trusted',
  ) {}

  /* ------------------------------ evidence ------------------------------ */

  /** Entity evidence. `id` overrides slugify(name) when the value resolved to an existing entity via alias. */
  async entity(e: ExtractedEntity, o: { extractor: string; weight?: number; segmentId?: string | null; id?: string }): Promise<string> {
    const name = e.name.trim();
    const id = o.id ?? slugify(name);
    const type = ENTITY_TYPES.includes(e.type) ? e.type : 'concept';
    await this.q.query(
      `INSERT INTO entities (id, name, type, description, aliases, tx_from)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz) ON CONFLICT (id) DO NOTHING`,
      [id, name || id, type, e.description ?? '', JSON.stringify(e.aliases ?? []), this.txTime],
    );
    await this.addEvidence('entity', id, o.extractor, o.weight ?? 1, o.segmentId ?? null, {
      name: name || id,
      type,
      description: e.description ?? '',
      aliases: (e.aliases ?? []).map(String),
    });
    this.knownEntities.add(id);
    this.touched.entities.add(id);
    return id;
  }

  private async entitiesExist(ids: string[]): Promise<boolean> {
    const unknown = ids.filter((id) => !this.knownEntities.has(id));
    if (unknown.length === 0) return true;
    const ph = unknown.map((_, i) => `$${i + 1}`).join(',');
    const rows = await this.q.query<{ id: string }>(`SELECT id FROM entities WHERE id IN (${ph})`, unknown);
    for (const r of rows) this.knownEntities.add(r.id);
    return rows.length === unknown.length;
  }

  async relation(
    sourceId: string,
    targetId: string,
    r: { type: string; description?: string; weight?: number; extractor: string; segmentId?: string | null },
  ): Promise<string | null> {
    if (sourceId === targetId) return null;
    if (!(await this.entitiesExist([sourceId, targetId]))) return null;
    const type = RELATION_TYPES.includes(r.type) ? r.type : 'related_to';
    const id = relationId(sourceId, type, targetId);
    await this.q.query(
      `INSERT INTO relations (id, source_id, target_id, type, description, weight, tx_from)
       VALUES ($1, $2, $3, $4, $5, 0, $6::timestamptz) ON CONFLICT (id) DO NOTHING`,
      [id, sourceId, targetId, type, r.description ?? '', this.txTime],
    );
    const added = await this.addEvidence('relation', id, r.extractor, r.weight ?? 1, r.segmentId ?? null, {
      type,
      description: r.description ?? '',
    });
    if (added) this.stats.relations++;
    this.touched.relations.add(id);
    return id;
  }

  async claim(
    subjectId: string,
    c: {
      objectId?: string | null;
      type: string;
      statement: string;
      status: string;
      validFrom?: string | null;
      validTo?: string | null;
      extractor: string;
      segmentId?: string | null;
      weight?: number;
    },
  ): Promise<string | null> {
    const statement = c.statement.trim();
    if (!statement) return null;
    const id = claimId(subjectId, statement);
    const status = (CLAIM_STATUS as readonly string[]).includes(c.status) ? c.status : 'fact';
    const validFrom = toIso(c.validFrom);
    const validTo = toIso(c.validTo);
    await this.q.query(
      `INSERT INTO claims (id, subject_id, object_id, type, statement, status, valid_from, valid_to, tx_from)
       VALUES ($1, $2, NULL, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::timestamptz) ON CONFLICT (id) DO NOTHING`,
      [id, subjectId, (c.type || 'fact').trim(), statement, status, validFrom, validTo, this.txTime],
    );
    const added = await this.addEvidence('claim', id, c.extractor, c.weight ?? 1, c.segmentId ?? null, {
      type: (c.type || 'fact').trim(),
      status,
      statement,
      valid_from: validFrom,
      valid_to: validTo,
      object_id: c.objectId ?? null,
    });
    if (added) this.stats.claims++;
    this.touched.claims.add(id);
    return id;
  }

  /** Chunk-level mention; the chunk row must already exist (call `document` first). */
  async mention(entityId: string, chunkId: string, documentId: string): Promise<void> {
    const rows = await this.q.query<{ entity_id: string }>(
      `INSERT INTO entity_mentions (entity_id, chunk_id, document_id, scope_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING RETURNING entity_id`,
      [entityId, chunkId, documentId, this.scope.id],
    );
    if (rows.length) this.stats.mentions++;
    this.touched.entities.add(entityId);
  }

  /**
   * Weak `co_occurs` edges between entities appearing in the same source.
   * Each entity is paired with the next `window - 1` entities in list order,
   * so edge count stays linear in the entity count.
   */
  async coOccurrence(entityIds: string[], o: { weight: number; window: number; extractor: string }): Promise<number> {
    const ids = [...new Set(entityIds)];
    let count = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length && j < i + o.window; j++) {
        if (await this.relation(ids[i], ids[j], { type: 'co_occurs', weight: o.weight, extractor: o.extractor })) count++;
      }
    }
    return count;
  }

  private async addEvidence(kind: string, targetId: string, extractor: string, weight: number, segmentId: string | null, attrs: Record<string, unknown>): Promise<boolean> {
    const key = `${kind}|${targetId}|${extractor}`;
    if (this.seenEvidence.has(key)) return false;
    this.seenEvidence.add(key);
    await this.q.query(
      `INSERT INTO evidence (kind, target_id, scope_id, segment_id, weight, extractor, attrs, tx_from, trust)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, $9)`,
      [kind, targetId, this.scope.id, segmentId, weight, extractor, JSON.stringify(attrs), this.txTime, this.trust],
    );
    if (kind === 'entity') this.stats.entities++;
    return true;
  }

  /* --------------------------- document projection ---------------------- */

  /**
   * The search projection of a source: documents row + chunks + embeddings.
   * Chunk ids are content-derived, so unchanged chunks (and their paid
   * embeddings) survive a re-apply; only vectors passed in are (re)written.
   */
  async document(row: DocumentProjection, chunks: ChunkRow[], vectors: Map<string, number[]>, model: string): Promise<void> {
    // a pre-lineage row may hold this path under another id: it is replaced wholesale
    await this.q.query(`DELETE FROM documents WHERE path = $1 AND id <> $2`, [row.path, row.id]);
    await this.q.query(
      `INSERT INTO documents (id, path, root, title, sha256, mime, bytes, status, scope_id, kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'indexed', $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         path = EXCLUDED.path, root = EXCLUDED.root, title = EXCLUDED.title, sha256 = EXCLUDED.sha256, mime = EXCLUDED.mime,
         bytes = EXCLUDED.bytes, status = 'indexed', error = NULL, scope_id = EXCLUDED.scope_id, kind = EXCLUDED.kind, updated_at = now()`,
      [row.id, row.path, row.root, row.title, row.sha256, row.mime, row.bytes, this.scope.id, row.kind],
    );
    if (chunks.length === 0) {
      await this.q.query(`DELETE FROM chunks WHERE document_id = $1`, [row.id]);
    } else {
      const params: unknown[] = [row.id, ...chunks.map((c) => c.id)];
      const ph = chunks.map((_, i) => `$${i + 2}`).join(',');
      await this.q.query(`DELETE FROM chunks WHERE document_id = $1 AND id NOT IN (${ph})`, params);
    }
    for (const c of chunks) {
      await this.q.query(
        `INSERT INTO chunks (id, document_id, seq, content, token_count, metadata, tsv)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, to_tsvector('simple', $4))
         ON CONFLICT (id) DO UPDATE SET metadata = EXCLUDED.metadata, token_count = EXCLUDED.token_count`,
        [c.id, row.id, c.seq, c.content, c.tokenCount, JSON.stringify({ path: row.path, title: row.title })],
      );
    }
    for (const [chunkId, vec] of vectors) {
      await this.q.query(
        `INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::${VECTOR_TYPE})
         ON CONFLICT (chunk_id) DO UPDATE SET model = EXCLUDED.model, embedding = EXCLUDED.embedding`,
        [chunkId, model, toVectorLiteral(vec)],
      );
    }
    this.stats.chunks = chunks.length;
    this.touched.documents.add(row.path);
  }

  /* --------------------------- explicit effects ------------------------- */

  /** Record the inverse, then run the forward action. */
  async effect(kind: EffectKind, target: string, inverse: InverseSpec, forward: () => Promise<void>): Promise<void> {
    await forward();
    await this.q.query(
      `INSERT INTO effects (scope_id, kind, target, inverse) VALUES ($1, $2, $3, $4::jsonb)`,
      [this.scope.id, kind, target, JSON.stringify(inverse)],
    );
    this.stats.effects++;
  }

  async setWikiPath(entityId: string, wikiPath: string | null): Promise<void> {
    const [cur] = await this.q.query<{ wiki_path: string | null }>(`SELECT wiki_path FROM entities WHERE id = $1`, [entityId]);
    if (!cur || cur.wiki_path === wikiPath) return;
    await this.effect('wiki_path', entityId, { op: 'wiki_path.restore', entityId, prev: cur.wiki_path }, async () => {
      await this.q.query(`UPDATE entities SET wiki_path = $2 WHERE id = $1`, [entityId, wikiPath]);
    });
  }

  async upsertDataset(row: DatasetUpsert): Promise<void> {
    const [prev] = await this.q.query<Record<string, unknown>>(`SELECT * FROM datasets WHERE id = $1`, [row.id]);
    await this.effect('row_upsert', `datasets:${row.id}`, { op: 'row.restore', table: 'datasets', id: row.id, prev: prev ? jsonSafe(prev) : null }, async () => {
      await this.q.query(
        `INSERT INTO datasets (id, source_id, table_name, kind, columns, row_count, schema_sha, description, entity_count, refreshed_at, scope_id, tx_from, tx_to)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, now(), $10, $11::timestamptz, NULL)
         ON CONFLICT (id) DO UPDATE SET
           source_id = EXCLUDED.source_id, table_name = EXCLUDED.table_name, kind = EXCLUDED.kind, columns = EXCLUDED.columns,
           row_count = EXCLUDED.row_count, schema_sha = EXCLUDED.schema_sha, description = EXCLUDED.description,
           entity_count = EXCLUDED.entity_count, refreshed_at = now(), scope_id = EXCLUDED.scope_id,
           tx_from = CASE WHEN datasets.tx_to IS NOT NULL THEN EXCLUDED.tx_from ELSE datasets.tx_from END, tx_to = NULL`,
        [row.id, row.source_id, row.table_name, row.kind, JSON.stringify(row.columns), row.row_count, row.schema_sha, row.description, row.entity_count, this.scope.id, this.txTime],
      );
    });
    this.touched.datasets.add(row.id);
  }

  /* ----------------------------- capabilities ---------------------------- */

  /**
   * Register what can be asked of a source. Capability rows, their locators
   * and their notes are owned by the writing scope and closed by scope id on
   * dispose — the same "implicit evidence" contract entity evidence uses — so
   * they need no explicit inverse and cannot outlive the source that declared
   * them.
   */
  async capability(row: CapabilityUpsert): Promise<string> {
    await this.q.query(
      `INSERT INTO capabilities (id, scope_id, kind, source_id, name, title, dialect, entity_id, schema,
                                 semantics, sample_queries, freshness_seconds, cost, acl, placement, tx_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12, $13, $14::jsonb, $15, $16::timestamptz)`,
      [
        row.id, this.scope.id, row.kind, row.source_id, row.name, row.title ?? '', row.dialect ?? 'sql',
        row.entity_id ?? null, JSON.stringify(row.schema ?? {}), row.semantics ?? '',
        JSON.stringify(row.sample_queries ?? []), row.freshness_seconds ?? null, row.cost ?? 1,
        JSON.stringify(row.acl ?? []), row.placement ?? 'federate', this.txTime,
      ],
    );
    this.stats.capabilities++;
    return row.id;
  }

  /** Bind one entity to one capability parameter (`symbol = '300750'`). */
  async locator(entityId: string, capabilityId: string, param: string, value: string): Promise<void> {
    const v = value.trim();
    if (!v) return;
    await this.q.query(
      `INSERT INTO locators (entity_id, capability_id, param, value, scope_id, tx_from)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
       ON CONFLICT (entity_id, capability_id, param, value) WHERE tx_to IS NULL DO NOTHING`,
      [entityId, capabilityId, param, v, this.scope.id, this.txTime],
    );
    this.stats.locators++;
  }

  /** The semantic layer a `capabilities/*.md` source contributes to a capability. */
  async capabilityNote(row: CapabilityNote): Promise<void> {
    await this.q.query(
      `INSERT INTO capability_notes (capability_id, scope_id, source_path, semantics, sample_queries, pitfalls, joins, cost, freshness_seconds, tx_from)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10::timestamptz)`,
      [
        row.capability_id, this.scope.id, row.source_path, row.semantics ?? '',
        JSON.stringify(row.sample_queries ?? []), JSON.stringify(row.pitfalls ?? []),
        JSON.stringify(row.joins ?? []), row.cost ?? null, row.freshness_seconds ?? null, this.txTime,
      ],
    );
    this.stats.capabilities++;
  }

  async enqueueTier1(documentId: string): Promise<void> {
    const [existing] = await this.q.query<{ document_id: string }>(`SELECT document_id FROM extraction_queue WHERE document_id = $1`, [documentId]);
    if (existing) return;
    await this.effect('enqueue', documentId, { op: 'queue.remove', documentId }, async () => {
      await this.q.query(
        `INSERT INTO extraction_queue (document_id, tier, priority) VALUES ($1, 1, 0) ON CONFLICT (document_id) DO NOTHING`,
        [documentId],
      );
    });
  }

  async suggestion(row: NewSuggestion): Promise<string> {
    const id = row.id ?? crypto.createHash('sha256').update(`${row.kind}|${row.title}`).digest('hex').slice(0, 16);
    await this.effect('suggestion', id, { op: 'suggestion.retract', id }, async () => {
      await this.q.query(
        `INSERT INTO suggestions (id, kind, title, body, evidence, status, report_path, payload, scope_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', $6, $7::jsonb, $8)
         ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, evidence = EXCLUDED.evidence, report_path = EXCLUDED.report_path,
           payload = EXCLUDED.payload, scope_id = EXCLUDED.scope_id,
           status = CASE WHEN suggestions.status = 'stale' THEN 'pending' ELSE suggestions.status END`,
        [id, row.kind, row.title, row.body, JSON.stringify(row.evidence ?? []), row.reportPath ?? null, row.payload === undefined ? null : JSON.stringify(row.payload), this.scope.id],
      );
    });
    return id;
  }

  async page(row: PageUpsert): Promise<void> {
    const [prev] = await this.q.query<Record<string, unknown>>(`SELECT * FROM pages WHERE path = $1`, [row.path]);
    await this.effect('page', row.path, { op: 'page.restore', path: row.path, prev: prev ? jsonSafe(prev) : null }, async () => {
      await this.q.query(
        `INSERT INTO pages (path, kind, scope_id, generator, inputs_sha, file_sha, regions, status, dirty_reason, tx_from, tx_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'active', NULL, $8::timestamptz, NULL)
         ON CONFLICT (path) DO UPDATE SET
           kind = EXCLUDED.kind, scope_id = EXCLUDED.scope_id, generator = EXCLUDED.generator, inputs_sha = EXCLUDED.inputs_sha,
           file_sha = EXCLUDED.file_sha, regions = EXCLUDED.regions, status = 'active', dirty_reason = NULL,
           tx_from = CASE WHEN pages.tx_to IS NOT NULL THEN EXCLUDED.tx_from ELSE pages.tx_from END, tx_to = NULL`,
        [row.path, row.kind, this.scope.id, row.generator, row.inputs_sha, row.file_sha, JSON.stringify(row.regions), this.txTime],
      );
    });
  }

  async deps(artifact: { kind: ArtifactKind; id: string }, inputs: DepDecl[]): Promise<void> {
    const prev = await readDeps(this.q, artifact);
    await this.effect('dep', `${artifact.kind}:${artifact.id}`, { op: 'deps.restore', artifactKind: artifact.kind, artifactId: artifact.id, prev }, async () => {
      await writeDeps(this.q, artifact, inputs);
    });
  }

  /* ---------------------------- file effects ---------------------------- */

  /** Write a whole file owned by this scope. Executed after COMMIT; the previous content (if any) goes to the attic. */
  async writeFile(rel: string, content: string): Promise<void> {
    const abs = safePath(this.dataDir, rel);
    let inverse: InverseSpec;
    if (fs.existsSync(abs)) {
      const prev = fs.readFileSync(abs, 'utf8');
      inverse = { op: 'file.restore', path: rel, blob: storeBlob(this.dataDir, prev) };
    } else {
      inverse = { op: 'file.delete', path: rel };
    }
    await this.effect('file_write', rel, inverse, async () => {});
    this.fsOps.push({ op: 'write', path: rel, content });
  }

  /** Replace one managed region inside a (possibly human-owned) file. */
  async writeRegion(rel: string, regionId: string, content: string): Promise<void> {
    const abs = safePath(this.dataDir, rel);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    const prev = splitRegions(current).regions.get(regionId) ?? null;
    await this.effect('region_write', `${rel}#${regionId}`, { op: 'region.restore', path: rel, region: regionId, prev }, async () => {});
    this.fsOps.push({ op: 'region', path: rel, region: regionId, content });
  }
}

/** Execute queued file operations (after the transaction committed). Idempotent. */
export function runFsOps(dataDir: string, ops: FsOp[]): void {
  for (const op of ops) {
    const abs = safePath(dataDir, op.path);
    fs.mkdirSync(require_dirname(abs), { recursive: true });
    if (op.op === 'write') {
      fs.writeFileSync(abs, op.content);
    } else {
      const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
      fs.writeFileSync(abs, replaceRegion(current, op.region, op.content));
    }
  }
}

function require_dirname(abs: string): string {
  return abs.slice(0, Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\')));
}

function jsonSafe(row: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}
