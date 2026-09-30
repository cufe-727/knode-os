import crypto from 'node:crypto';
import { DataSourceConfig, DataSourceKind, EntityColumnConfig, KnodeConfig, SourceDialect } from '../config.js';
import { summaryLlmClient } from '../context.js';
import { resolveEntityIdByNameOrAlias, slugify } from '../graph/store.js';
import { createEmbeddingProvider, EmbeddingProvider } from '../ingest/embeddings.js';
import { applyScope } from '../lineage/scope.js';
import { LlmClient } from '../llm/client.js';
import { entitySymbol } from '../pack/playbook.js';
import { parseDuration } from '../store/resolver.js';
import { Store } from '../store/db.js';
import { regeneratePage } from '../wiki/pages.js';
import { DataSourceRegistry } from './registry.js';
import { TableSchema } from './types.js';

/**
 * Schema ingestion: the bridge between live systems and the knowledge graph.
 * For every configured source it materializes *metadata only* —
 *
 *   datasource entity ──stored_in──▶ dataset entity (one per table)
 *   value entity (e.g. a company) ──appears_in──▶ dataset entity
 *
 * plus a wiki page per table (schema, sample rows, linked entities). Row data
 * itself always stays in the source system.
 *
 * Every datasource config is a scope (its sha covers config + introspected
 * schema list); every table is a child scope (schema + linked samples). A
 * source removed from the config is simply absent from the declared state:
 * `sync` disposes its scope, which tombstones the dataset rows, the
 * `appears_in` edges and archives the generated pages.
 */

export interface DatasourceSyncStats {
  sources: number;
  tables: number;
  linkedEntities: number;
  wikiPages: number;
  capabilities: number;
  locators: number;
  errors: string[];
}

/**
 * What a source's queryable units are called, and how a request against one is
 * written. A table, an endpoint and a metric are the same thing to the planner
 * — something that can be asked a question at a cost — so they differ only in
 * these two labels.
 */
const CAPABILITY_SHAPE: Record<DataSourceKind, { kind: 'table' | 'endpoint' | 'metric'; dialect: SourceDialect }> = {
  mysql: { kind: 'table', dialect: 'sql' },
  timescale: { kind: 'table', dialect: 'sql' },
  duckdb: { kind: 'table', dialect: 'sql' },
  'http-json': { kind: 'endpoint', dialect: 'http' },
  prometheus: { kind: 'metric', dialect: 'promql' },
  object: { kind: 'endpoint', dialect: 'object' },
};

export function capabilityId(sourceId: string, unit: string): string {
  return `${sourceId}.${unit}`;
}

/**
 * Which columns/params/labels of one unit carry entity values. The three
 * source families spell this differently in config; the linker only cares
 * about "name of the thing to bind, and what kind of entity its values are".
 */
function entityColumnsFor(ds: DataSourceConfig, unit: string): EntityColumnConfig[] {
  if (ds.kind === 'http-json') {
    return ds.endpoints?.find((e) => e.name === unit)?.entityParams ?? [];
  }
  if (ds.kind === 'prometheus') {
    return ds.metrics?.find((m) => m.name === unit)?.entityLabels ?? [];
  }
  return ds.tables?.find((t) => t.name === unit)?.entityColumns ?? [];
}

function unitDescription(ds: DataSourceConfig, unit: string): string | undefined {
  if (ds.kind === 'http-json') return ds.endpoints?.find((e) => e.name === unit)?.description;
  if (ds.kind === 'prometheus') return ds.metrics?.find((m) => m.name === unit)?.description;
  return ds.tables?.find((t) => t.name === unit)?.description;
}

function freshnessOf(ds: DataSourceConfig): number | null {
  if (ds.freshness === undefined || ds.freshness === null || ds.freshness === '') return null;
  try {
    return parseDuration(ds.freshness);
  } catch {
    return null;
  }
}

export interface DatasourceSyncContext {
  store: Store;
  dataDir: string;
  config: KnodeConfig;
  embedder?: EmbeddingProvider;
  llm?: LlmClient;
  datasources?: DataSourceRegistry;
}

export function datasetEntityId(sourceId: string, table: string): string {
  return slugify(`${sourceId}.${table}`);
}

interface LinkSample {
  column: string;
  entityType: string;
  value: string;
  aliases: string[];
  /** Already-known entity (derived bindings); otherwise resolved by name / alias. */
  entityId?: string;
  /** How the binding was found: sampled from the unit, or derived from the graph. */
  origin: 'sampled' | 'derived';
}

/**
 * Sources that can enumerate their own values (tables, object prefixes) go
 * first; endpoints and metrics are bound afterwards from what those tables
 * and the documents already established.
 */
const KIND_ORDER: Record<DataSourceKind, number> = { mysql: 0, timescale: 0, duckdb: 0, object: 0, 'http-json': 1, prometheus: 1 };

/**
 * An endpoint or metric cannot be sampled — there is no column to enumerate
 * without calling it — so its bindings are *derived*: an entity reachable as
 * `symbol = 300750` on any table is reachable the same way on an endpoint
 * that declares a `symbol` parameter, and a company whose alias is a ticker
 * is reachable through a `symbol`-shaped parameter even before any table has
 * been configured. This is what turns "quote(symbol)" into a locator the
 * planner can bind instead of a call it would have to guess at.
 */
async function deriveSamples(store: Store, capId: string, columns: EntityColumnConfig[]): Promise<LinkSample[]> {
  const out: LinkSample[] = [];
  const seen = new Set<string>();
  const push = (s: LinkSample) => {
    const key = `${s.column}|${s.entityId}|${s.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  for (const col of columns) {
    const bound = await store.query<{ entity_id: string; value: string }>(
      `SELECT DISTINCT l.entity_id, l.value FROM locators l JOIN entities e ON e.id = l.entity_id
       WHERE l.param = $1 AND l.capability_id <> $2 AND l.tx_to IS NULL AND e.tx_to IS NULL AND e.type = $3
       ORDER BY l.entity_id, l.value LIMIT 1000`,
      [col.column, capId, col.entityType],
    );
    for (const b of bound) push({ column: col.column, entityType: col.entityType, value: b.value, aliases: [], entityId: b.entity_id, origin: 'derived' });

    if (/symbol|code|ticker/i.test(col.column)) {
      const ents = await store.query<{ id: string; name: string; aliases: string[] }>(
        `SELECT id, name, aliases FROM entities
         WHERE type = $1 AND tx_to IS NULL AND jsonb_array_length(aliases) > 0 ORDER BY mention_count DESC, id LIMIT 1000`,
        [col.entityType],
      );
      for (const e of ents) {
        const symbol = entitySymbol({ name: e.name, aliases: Array.isArray(e.aliases) ? e.aliases : [] });
        if (symbol && symbol !== e.name) push({ column: col.column, entityType: col.entityType, value: symbol, aliases: [], entityId: e.id, origin: 'derived' });
      }
    }
  }
  return out;
}

export async function applyDatasourceScopes(
  ctx: DatasourceSyncContext,
  registry: DataSourceRegistry,
  opts: { actor?: string; onProgress?: (msg: string) => void; at?: (kind: 'datasource' | 'dataset', key: string) => string | undefined } = {},
): Promise<DatasourceSyncStats> {
  const { store } = ctx;
  const progress = opts.onProgress ?? (() => {});
  const actor = opts.actor ?? 'datasource';
  const stats: DatasourceSyncStats = { sources: 0, tables: 0, linkedEntities: 0, wikiPages: 0, capabilities: 0, locators: 0, errors: [] };
  const pageCtx = {
    store,
    dataDir: ctx.dataDir,
    config: ctx.config,
    llm: ctx.llm ?? summaryLlmClient(ctx.config),
    embedder: ctx.embedder ?? createEmbeddingProvider(ctx.config.embedding),
    datasources: registry,
  };

  const sources = [...registry.list()].sort((a, b) => (KIND_ORDER[a.kind] ?? 0) - (KIND_ORDER[b.kind] ?? 0));
  for (const ds of sources) {
    let tables: TableSchema[];
    try {
      tables = await registry.get(ds.id).introspect();
    } catch (err) {
      const msg = `datasource ${ds.id}: ${err instanceof Error ? err.message : err}`;
      stats.errors.push(msg);
      progress(msg);
      continue;
    }
    stats.sources++;

    const configSha = crypto.createHash('sha256').update(JSON.stringify(ds)).digest('hex').slice(0, 24);
    const schemaListSha = crypto.createHash('sha256')
      .update(JSON.stringify(tables.map((t) => ({ name: t.name, columns: t.columns }))))
      .digest('hex').slice(0, 16);
    const parent = await applyScope(
      store,
      { kind: 'datasource', key: ds.id },
      `${configSha}:${schemaListSha}`,
      { actor, at: opts.at?.('datasource', ds.id), meta: { kind: ds.kind } },
      async (w) => {
        await w.entity({ name: ds.id, type: 'datasource', description: ds.description ?? `${ds.kind} data source` }, { extractor: 'datasource' });
      },
    );
    const sourceEntityId = slugify(ds.id);

    for (const table of tables) {
      const shape = CAPABILITY_SHAPE[ds.kind];
      const datasetId = datasetEntityId(ds.id, table.name);
      const description = unitDescription(ds, table.name) ?? `${shape.kind} ${table.name} in ${ds.kind} source ${ds.id}`;
      const columnsJson = JSON.stringify(table.columns);
      const schemaSha = crypto.createHash('sha256').update(columnsJson).digest('hex').slice(0, 16);

      // Columns that carry alias info (e.g. companies.name + symbol) run first so
      // later bare-symbol columns resolve to the canonical entity via alias lookup.
      const capId = capabilityId(ds.id, table.name);
      const declaredColumns = entityColumnsFor(ds, table.name);
      const samples = await collectSamples(registry, ds, table.name, declaredColumns, stats, progress);
      if (shape.kind !== 'table' && declaredColumns.length > 0) {
        samples.push(...await deriveSamples(store, capId, declaredColumns));
      }
      const childSha = crypto.createHash('sha256')
        .update(`${schemaSha}|${description}|${JSON.stringify(samples)}`)
        .digest('hex').slice(0, 24);

      await applyScope(
        store,
        { kind: 'dataset', key: `${ds.id}.${table.name}` },
        childSha,
        { parentId: parent.scope.id, actor, at: opts.at?.('dataset', `${ds.id}.${table.name}`), meta: { datasetId, sourceId: ds.id, table: table.name } },
        async (w) => {
          await w.entity({ name: `${ds.id}.${table.name}`, type: 'dataset', description }, { extractor: 'datasource' });
          await w.relation(datasetId, sourceEntityId, { type: 'stored_in', description: `${shape.kind} lives in ${ds.kind} source ${ds.id}`, extractor: 'datasource' });
          await w.capability({
            id: capId,
            kind: shape.kind,
            source_id: ds.id,
            name: table.name,
            title: description,
            dialect: shape.dialect,
            entity_id: datasetId,
            schema: { columns: table.columns, rowCount: table.rowCount ?? null },
            semantics: description,
            freshness_seconds: freshnessOf(ds),
            cost: ds.cost ?? 1,
            placement: 'federate',
          });
          stats.capabilities++;
          let linked = 0;
          for (const s of samples) {
            const resolved = s.entityId ?? await resolveEntityIdByNameOrAlias(w.q, s.value);
            const entityId = await w.entity(
              { name: s.value, type: s.entityType, aliases: s.aliases },
              { extractor: 'datasource', weight: s.origin === 'derived' ? 0.25 : 0.5, id: resolved ?? undefined },
            );
            const description = s.origin === 'derived'
              ? `bound by ${shape.kind === 'metric' ? 'label' : 'param'} ${table.name}.${s.column}`
              : `value of ${table.name}.${s.column}`;
            if (await w.relation(entityId, datasetId, { type: 'appears_in', description, extractor: 'datasource' })) linked++;
            // how to reach this entity here: bind <column> to <value>
            await w.locator(entityId, capId, s.column, s.value);
            for (const alias of s.aliases) await w.locator(entityId, capId, s.column, alias);
            stats.locators += 1 + s.aliases.length;
          }
          await w.upsertDataset({
            id: datasetId,
            source_id: ds.id,
            table_name: table.name,
            kind: ds.kind,
            columns: table.columns,
            row_count: table.rowCount ?? null,
            schema_sha: schemaSha,
            description,
            entity_count: linked,
          });
        },
      );
      stats.tables++;
      stats.linkedEntities += samples.length;
      if (samples.length) progress(`linked ${samples.length} entities from ${ds.id}.${table.name}`);

      try {
        const page = await regeneratePage(pageCtx, `wiki/datasets/${datasetId}.md`, 'dataset', { actor });
        if (page === 'regenerated') {
          stats.wikiPages++;
          progress(`wiki page wiki/datasets/${datasetId}.md`);
        }
      } catch (err) {
        stats.errors.push(`page ${datasetId}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  return stats;
}

async function collectSamples(
  registry: DataSourceRegistry,
  ds: DataSourceConfig,
  table: string,
  columns: EntityColumnConfig[],
  stats: DatasourceSyncStats,
  progress: (msg: string) => void,
): Promise<LinkSample[]> {
  const ordered = [...columns].sort((a, b) => (b.aliasColumns?.length ? 1 : 0) - (a.aliasColumns?.length ? 1 : 0));
  const out: LinkSample[] = [];
  for (const col of ordered) {
    try {
      const samples = await registry.get(ds.id).sampleColumn(table, col.column, col.aliasColumns ?? [], 100);
      for (const s of samples) {
        if (!s.value?.trim()) continue;
        out.push({ column: col.column, entityType: col.entityType, value: s.value.trim(), aliases: s.aliases.map(String), origin: 'sampled' });
      }
    } catch (err) {
      const msg = `link ${ds.id}.${table}.${col.column}: ${err instanceof Error ? err.message : err}`;
      stats.errors.push(msg);
      progress(msg);
    }
  }
  return out;
}

/** Back-compat entry point (CLI / HTTP / tests). */
export async function syncDatasources(
  store: Store,
  config: KnodeConfig,
  registry: DataSourceRegistry,
  opts: { onProgress?: (msg: string) => void } = {},
): Promise<DatasourceSyncStats> {
  return applyDatasourceScopes({ store, dataDir: store.dataDir, config, datasources: registry }, registry, opts);
}
