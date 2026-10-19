# 05 — Agent Context Database: redesigning the knowledge base for agents

> Status: Phases 1–6 are **all implemented** — the lineage ledger, the Temporal Resolver, the Capability Graph, the Context Compiler, the learning loop (ranker / recipe distillation / pack evaluation), and negative knowledge, worksets, trust tiers, ACL inheritance and change subscriptions. Chinese version: [05-agent-context-db.zh-CN.md](05-agent-context-db.zh-CN.md).

## 0. In one sentence

**To an agent it looks like one database while the data physically stays where it lives; every derived byte has lineage and an inverse; the core operation is `resolve`, not `search`.**

knode-os started as a local knowledge base where markdown is the system of record and PGlite a disposable index. This redesign turns it into an *Agent Context Database* (ACD): one logical database over documents, images, agent traces, memories, skills, offline warehouses and live MySQL tables; four query surfaces for agents (filesystem, RAG, graph, LLM wiki); world time and system time on every fact; and, step by step, a configurable and learnable Context Compiler that turns "analyze stock X" into everything the agent needs plus the queries it could still run.

## 1. Motivation: five requirements

| # | Requirement | Answer in this design | Phase |
|---|---|---|---|
| ① | Spatiotemporal composability: deleting a document/datum removes every effect it produced | Effect Ledger: each source is a scope; every derived write is either evidence closed by scope id or an explicit effect with a recorded inverse; `dispose` reverts in reverse order, `sync` reconciles declared vs running state | Phase 1 ✅ |
| ② | One logical database over many modalities and physical stores | Materialize only the catalog plus stable, expensive derivations; federate volatile data; connectors are Cordis-style plugins (registering one = applying a scope); the Capability Graph turns "what can be asked, how, at what cost, how fresh" into one table | Phases 1–3 ✅ |
| ③ | Agent-friendly querying: FS, RAG, graph, LLM wiki, temporal validity | Four surfaces over one catalog; wiki pages are materialized views over the graph; three time axes (`as_of` system time, `valid_at`/`valid_range` world time, `freshness` for live reads) are kept apart by the Temporal Resolver and run through retrieval; `kinds`/`sources` bound which sources may answer | Phases 1–2 ✅ |
| ④ | Minimize agent exploration, configurable and learnable | Context Compiler: intent specs (configurable) + receipts/feedback (learnable) → ContextPack v2 + a workflow-style Plan executed on the agent side; the ranker trades exploitation against exploration with Thompson sampling | Phases 4–5 ✅ |
| ⑤ | Other things today's databases get wrong for agents | Budgets and cut reports, receipts, negative knowledge, snapshots/working sets, trust tiers, ACL inheritance, change subscriptions | Phase 6 ✅ |

## 2. Theoretical grounding

- **DeepSeek, *A Programming Paradigm for Spatiotemporal Composability* (arXiv 2608.25512, Cordis).** Temporal composability: every effect carries an inverse held by the runtime in a dispose stack; removing a component reverts its effects in reverse registration order. Spatial composability: components declare coeffects via `inject`; dependents are reactively activated/deactivated when the context changes. Configuration reconciliation: diff the declared state against the running state and mount/unmount only what changed. §4 maps all three onto the knowledge base.
- **DeepSeek Harness PTC (Programmatic Tool Calling).** The model writes a program against a typed SDK generated from tool definitions; intermediate data stays in the executor and only curated results reach the model. A Plan can be rendered as such a TypeScript program (§8).
- **Karpathy's LLM wiki.** Immutable raw sources, an LLM-owned wiki, a co-evolved schema, ingest/query/lint — but no answer to "what happens to the wiki when a source is deleted". Ours: wiki pages are materialized views with declared inputs (§5).
- **Argus (arXiv 2605.16217).** Research as evidence assembly with an evidence graph that says which pieces are still missing — the origin of `unknowns` / `available_next_queries` in the ContextPack (§8).

## 3. Architecture and principles

```
Agent (Claude / Codex / DeepSeek Harness / custom)
        │  MCP · CLI · HTTP · virtual filesystem · read-only SQL (catalog)
        ▼
┌──────────────────── Context Compiler (Phase 4) ──────────┐
│ resolve(query, actor, as_of, valid_at, budget)            │
│   intent → grounding → evidence-slot planning → fill      │
│   locally what the materialized layer has → compile the   │
│   rest into a Plan (workflow program, agent-executed)     │
│   → ContextPack + receipt                                 │
├───────────── Temporal Resolver ── Policy / ACL ───────────┤
│ valid_time ⟂ tx_time ⟂ freshness                          │
├─────────────────── Effect Ledger (Phase 1 ✅) ────────────┤
│ scopes · effects(+inverse) · evidence · deps · pages       │
│ apply / dispose / fold / propagate / sync / purge / rebuild│
├────────── Knowledge (materialized) ────── Capability Graph ┤
│ chunks · entities · claims · pages · memories · episodes   │ datasets(✅) · capabilities · locators
└───────────────────────────────────────────────────────────┘
   ▲ files = human truth                ▲ ledger/events.jsonl = machine truth
   raw/ .sidecar/ wiki/ playbooks/              .knode/db = rebuildable projection
   ▲ physical stores: MySQL · TimescaleDB · parquet/DuckDB (✅) · S3 · HTTP APIs · Prometheus (Phase 3)
```

Principles:

1. **One logical database, many physical stores.** Placement is a per-capability setting: `materialize | federate | cache(ttl)`.
2. **Every derived byte has lineage and an inverse.** A write without a `(scope, effect, inverse)` triple does not exist.
3. **Dependencies are declared, resolution is reactive.** Derived artifacts declare `deps(required|optional)`; a vanished required input archives, a changed optional input recomputes.
4. **Bitemporal by default.** `valid_from/valid_to` (world time) + `tx_from/tx_to` (system time). Deletion closes `tx_to` (tombstone); only `purge` erases.
5. **The core operation is `resolve`, not `search`.**
6. **Files remain the human truth; the ledger is the machine truth; the database is a rebuildable projection of both. Current state = materialized aggregate columns; history = evidence.**

## 4. The Effect Ledger (Phase 1, implemented)

### 4.1 Cordis → database

| Cordis | ACD implementation |
|---|---|
| component | **Source**: a file (raw document, skill, human wiki page, purpose/schema), a datasource config, one dream. One apply = one `scopes` row; tier-1 extraction, human prose on a generated page (`wiki-human`) and every live table (`dataset`) are child scopes |
| `ctx.effect(() => inverse)` | Graph evidence (entity/relation/claim), mentions and chunks/embeddings have an **implicit** inverse (closed or deleted by `scope_id`); file writes, managed regions, queue entries, suggestions, deps, page rows and dataset rows are **explicit** effects recorded in `effects(scope_id, seq, kind, target, inverse)` |
| dispose stack | `disposeScope`: children first, then close evidence, delete mentions and the projection, then replay `effects` in `seq DESC` order |
| `inject` (coeffect) | `deps(artifact ← input, required)`; inputs are only `entity / relation / claim / document / dataset / trace / set` — **a page can never depend on a page** |
| reactive (de)activation | `foldTouched` recomputes the aggregates of touched rows → a changed `fold_sha` or a tombstone → `propagate`: a dead required input archives the page, anything else marks it dirty; dependent suggestions become `stale` |
| configuration reconciliation / HMR | `sync`: declared state (raw/ file tree + datasource configs) vs running state (live root scopes), apply/dispose only the delta |
| idempotency | applying the same `(kind, key, sha)` returns `unchanged` before any transaction opens: zero writes, zero ledger lines |

### 4.2 Schema (migration v2)

```
scopes    (id, kind, key, sha, parent_id, status: applying|active|disposed, actor, applied_at, disposed_at, meta)
          UNIQUE (kind, key) WHERE status <> 'disposed'
effects   (seq, scope_id, kind, target, inverse JSONB, reverted_at)
evidence  (id, kind: entity|relation|claim, target_id, scope_id, segment_id, weight, extractor, attrs, tx_from, tx_to)
deps      (artifact_kind: page|suggestion, artifact_id, input_kind, input_id, required, input_sha)
pages     (path, kind, scope_id, generator, inputs_sha, file_sha, regions, status: active|dirty|archived, dirty_reason, tx_from, tx_to)
entities  + tx_from, tx_to, evidence_count, fold_sha
relations + tx_from, tx_to, evidence_count, fold_sha           (document_id no longer written)
claims    + valid_from, valid_to, tx_from, tx_to, evidence_count, fold_sha, primary_scope_id
entity_mentions  primary key becomes (entity_id, chunk_id, scope_id)
datasets  + scope_id, tx_from, tx_to ; documents + scope_id, kind: source|view, status gains disposed
```

Migrations (`src/store/migrations.ts`) run per version in their own transaction; a database without `schema_version` but with a `documents` table is v1. v2 **rebuilds the graph layer** (old rows carry no per-source evidence and inflated weights) while keeping chunks and embeddings (chunk ids are content-derived and reused as-is); tier-1 results replay from sidecars for free.

### 4.3 Evidence and fold: shared rows, per-source contributions

The old defect: `relations.id = sha(source|type|target)` and `claims.id = sha(subject|statement)` were document-independent, yet each row belonged to whichever document wrote it first, `weight = weight + δ` inflated on every re-ingest, and deleting a document by `document_id` removed edges other documents still asserted.

New model: entities, relations and claims remain **content-addressed shared rows**, but each source's support is one `evidence` row. The visible columns are recomputed by `src/lineage/fold.ts` inside the same transaction, **for exactly the touched ids**, from live evidence, with order-independent rules (rebuilds reproduce them):

- entity: `name` from the highest-weight evidence (ties: earliest, then lexicographic); `type` by fixed precedence; longest `description`; case-insensitive alias union; `mention_count = COUNT(DISTINCT chunk_id)`.
- relation: `weight = SUM(evidence.weight)`, one row per source — re-ingesting never accumulates. Only **typed predicates** are rows. `co_occurs` is **derived, not stored** (migration v13, 2026-10-18): `src/graph/cooccur.ts` computes it from `entity_mentions` on read — two entities co-occur when a live document mentions both (0.2 per shared document), strongly when one chunk does (+0.3 per shared chunk) — and `graphSearch` (hop gain ×0.5), `graphOverview` and `graphInsights` (the isolated list) read it from there. The stored rows said nothing the mentions did not, and they were 92% of the finance workspace's relations table (844k of 912k rows) with 2.0M evidence rows behind them; the migration only adds the mentions-by-document index and flags the cleanup, and the first open by the new code then deletes them in the background in short autocommitted batches (`dropStoredCoOccurrence`: 10k relations per statement, about 1 s each and 100 s in all on a Postgres copy of that workspace, the open itself returning in 0.1 s; stopped by `close`, resumed by the next open) while readers ignore rows of that type.
- claim: any disputed → disputed, else any fact → fact, else suspected; `valid_from = MIN`; `valid_to` is NULL if any evidence is open-ended ("an undated re-assertion means still asserted"), else MAX; `primary_scope_id` = the earliest live source.
- No live evidence, or a dead endpoint / subject entity → the row is tombstoned (`tx_to`); regained evidence reopens it (new `tx_from`; the full history lives in evidence).

Why neither views nor delta counters: a whole-table `GROUP BY evidence` on every hot query (`graphSignal`, SAG ordering, `matchEntities`) is too slow on single-threaded PGlite; delta counters are only exact if every writer is disciplined, whereas a touched-id recount is exact by construction and self-healing (`sync --verify` recounts everything and reports drift).

### 4.4 Views are not sources: closing the three resurrection paths

Three paths used to resurrect entities whose sources were gone: `wiki/entities/*.md` stubs re-ingested as concept nodes; the hot-topics block in `wiki/index.md` with `[[entity]]` links; `[[links]]` inside `wiki/sources/*.md` summaries. The new classification (`src/ingest/apply.ts`):

- **Sources**: `raw/docs/**` (prepared: text normalized in memory, converted originals through their sidecar `content.md`), `raw/skills/**`, `purpose.md`/`schema.md`, human pages under `wiki/**` that are neither reserved nor views (with a self-entity, as before), datasource configs.
- **Views** (wiki files with a live `pages` row or `generated: true`): chunked and embedded for search only, **no entity evidence**; only prose written outside the managed regions counts as evidence (`extractor: human` — a human writing on a stub asserts the entity), recorded as a `wiki-human` child scope.
- **Reserved**: `index.md` at any level is searchable but never wired; `wiki/log.md`, `wiki/.archive/**`, `attachments/**`, `*.knode.json`, `ledger/**`, `raw/traces/**` are never sources. `ledger/events.jsonl` supersedes `log.md` as the machine log; `appendLog` stays the human-readable OKF log.

### 4.5 apply / dispose / sync / purge / rebuild

**`applyScope(store, {kind, key}, sha, opts, body)`** (`src/lineage/scope.ts`): ① a live scope with the same sha → `unchanged`, no transaction; ② a different sha → `dispose(old, 'replaced')` first (document scopes keep chunks/embeddings for the new apply to reuse); ③ one transaction: insert scope → `ledger_seq++` → `body(writer)` → `foldTouched` → `propagate` → scope `active`; ④ after COMMIT, run the queued file operations (idempotent); ⑤ append the ledger line. **Bodies never await network / LLM / embedding calls** — everything is computed first, so the PGlite mutex is held briefly.

**`disposeScope(store, id, {reason})`**: children first; in one transaction close evidence (RETURNING → touched) → delete mentions → delete chunks and set `documents.status = disposed` when the scope owns a projection → replay `effects` inverses in reverse → fold → propagate → scope `disposed`; after COMMIT run the file inverses (with `reason = archived`, `file.delete` becomes a move into `wiki/.archive/`); a `removed` cooked document also loses its cooked file and its sidecar moves to `ledger/attic/`. With `reason = replaced`, propagate only marks pages dirty (never archives) and no file inverses run: the replacing apply normally restores the same evidence a moment later, and inputs that are really gone are archived when `reconcileViews` re-plans.

**`sync(ctx, {only?, verify?})`** (`src/ingest/sync.ts`) replaces the three old orphan sweeps: cook (create/update only) → `enumerateDeclared` (cooked files count only while their raw original exists; `raw/docs/x` prefixes map to the cooked twin; the `datasources` pseudo-prefix) → running state = live root scopes → diff → dispose removed first, then prepare added/replaced with `ingest.concurrency` while the scope transactions serialize → datasource scopes → `reconcileViews` (archive / regenerate / drift repair) → with `--verify`, `recountAll` plus ledger backfill. The watcher, the trace timer, HTTP and MCP all call `sync`; incremental runs (`only`) **dispose removed sources exactly like full runs**.

**`purge`**: only disposed scopes; physically deletes evidence / effects / mentions / attic sidecar / previous file versions and garbage-collects entities, edges and claims no evidence references; `purge --before <ts>` compacts history; `purge --archived` empties `wiki/.archive/`. Live sources cannot be purged. **`forget <path>`** = delete the file + `sync` + purge.

**`rebuild [--history]`**: drop `.knode/db` → reopen (migrations) → re-seed `ledger_seq` from the log → `sync`, keeping the original apply time of unchanged sources (`tx_from` stays faithful) → replay feedback events (suggestion decisions); `--history` additionally re-applies sources that were removed but whose sidecars survive in the attic at their original time and disposes them at their original time, so graph-layer `as_of` answers match the pre-rebuild timeline (verified end to end on the stock demo: 3 claims before deleting a report, 2 after, and 3 again for `--as-of` after `rebuild --history`).

### 4.6 Bitemporal semantics

- Queries default to `tx_to IS NULL`; `as_of = T` means `tx_from <= T AND (tx_to IS NULL OR tx_to > T)`; `valid_at = T` means `(valid_from IS NULL OR valid_from <= T) AND (valid_to IS NULL OR valid_to >= T)`. Helpers live in `src/store/temporal.ts`; `as_of` graph reads do not use the aggregate columns but recompute from evidence (`entitiesAsOf / relationsAsOf / claimsAsOf`).
- Phase 1 `as_of` covers the graph layer (entities, relations, claims, pages, datasets, documents-as-scopes). Chunks, embeddings and mentions are hard-deleted on dispose — pgvector has no index, and tombstones would slow every vector query; `as_of` search returns the current chunks of documents that were live then.
- Co-occurrence follows the mentions: an `as_of` graph read derives it from the mentions of documents that were already live then (`docLiveAt`), so a source disposed since contributes none — the rule `as_of` search already follows for chunks.
- A plain delete is a dispose (history stays queryable); `forget` / `purge` erase.

### 4.7 Machine truth: `ledger/events.jsonl` + `ledger/attic/`

Events `apply | dispose | purge | feedback | migrate | rebuild` carry `seq, ts, actor, scope{id, kind, key, sha, parent}` and **never content**; `seq` comes from `meta.ledger_seq`, incremented inside the scope transaction so rows and lines agree. `ledger/attic/` keeps the sidecars of removed sources (paid extractions, including tier-0.5 declared entities/claims) and the previous bytes of overwritten human files (`blobs/<sha>`).

### 4.8 Idempotency and crash safety

Three applies of the same `(kind, key, sha)` write nothing; a content change is dispose(t) + apply(t' > t) in two transactions and the fold only reads live evidence, so weights cannot inflate; the database transaction is the atomic unit and file operations run idempotently after COMMIT; a crash between commit and the ledger append is repaired by `sync --verify`; a crash mid-apply leaves the old scope disposed and no new scope, so the next sync sees declared ≠ running and retries; content-derived ids plus order-independent folds make two syncs over the same files produce identical rows.

## 5. Wiki pages as views (Phase 1, implemented)

`src/wiki/pages.ts` defines `PageGenerator {kind, version, llm, mode, plan(), render()}`: `plan` declares deps from the current graph and computes `inputsSha`; `render` produces frontmatter and managed regions; `regeneratePage` writes the `pages` row, deps and the file inside a `page` scope, then builds the file's search projection.

| kind | path | deps (**required**) | LLM | cache |
|---|---|---|---|---|
| `entity_stub` | `wiki/entities/<id>.md` | **entity**, claims | no | — |
| `source_summary` | `wiki/sources/<slug>.md` | **document** (sha) | yes | doc sidecar `views.sourceSummary` |
| `dataset` | `wiki/datasets/<id>.md` | **dataset** (schema sha), linked entities | no | — |
| `sources_index` | region `wiki/sources/index.md#sources` | `set:docs`, documents | no | — |
| `hot_topics` | region `wiki/index.md#hot-topics` | `set:hot-entities`, entities | no | — |
| `concept_cluster` | `wiki/concepts/<slug>-cluster.md` | **anchor entity**, members | yes | `.sidecar/wiki/…/render.md` |
| `dream` | `wiki/dreams/<date>.md` | traces | yes | one-shot scope |

- Managed regions: `<!-- knode:begin <id> --> … <!-- knode:end <id> -->`. Human prose outside them survives every regeneration and is itself a knowledge source. Legacy `generated: true` pages without markers are managed wholesale; the old `<!-- hot-topics:start -->` block is rewritten on first regeneration.
- Frontmatter gains `knode: { view, inputs: {entities, claims, documents…} }` — ids instead of verbatim copies.
- A human-owned file at the target path (no `pages` row, no `generated: true`) is `blocked` and never touched.
- Archival: a dead required input → `pages.status = archived` → `reconcileViews` disposes the page scope (file moved to `wiki/.archive/`, `wiki_path` restored) and its search projection; when the source returns, `generateWiki` restores the archived copy before regenerating (human parts survive).
- **No loops**: views emit no evidence, so regeneration cannot change any fold; dirtiness is triggered only by *changes* of `fold_sha` / document sha; `deps.input_kind` excludes pages; index-like pages depend on `set:*` shas computed once per pass; `reconcileViews` takes at most three passes.

## 6. One logical, multimodal database (Phase 1 partial + Phase 3)

Implemented: a datasource config is a `datasource` scope (sha = config + introspected schema list); each table is a `dataset` child scope (sha = schema + sampled entity values); the dataset entity, `stored_in` / `appears_in` edges, the `datasets` row and the dataset wiki page are its effects. Removing a source from the config → `sync` disposes → rows tombstoned, edges closed, page archived, while entities still asserted by documents are untouched (test: `tombstones datasets, links and pages when a source leaves the config`).

**Endpoint and metric bindings are derived.** A table can enumerate its own column values; an HTTP endpoint or a Prometheus metric cannot — there is nothing to sample without calling it. `sync` therefore processes the sources that can sample (tables, object prefixes) first and then *derives* locators for endpoints/metrics: an entity already bound under the same parameter name on any other capability (`symbol = 300750` on the parquet table) gets the same binding on an endpoint that declares `entityParams: [{ column: symbol }]`; for `symbol / code / ticker`-shaped parameters the entity's ticker-style alias (the `aliases: ["300750"]` a report declares) produces a binding directly, so an API that is the only live source still binds. Derived bindings emit an `appears_in` edge (described as `bound by param quote.symbol`, evidence weight 0.25) and a locator, so the planner produces `quote?symbol=300750` instead of an unbound call; the result does not depend on config order.

**CSV sits next to parquet.** The `duckdb` source registers `.csv / .tsv` files (gzip included) in its directory as views too (`read_csv_auto`); a parquet file wins over a CSV with the same stem.

**Probes render per dialect.** A playbook's `{symbol}` becomes a SQL string literal for SQL sources, a URL component for HTTP endpoints and a quoted label value for PromQL; the "next query" a pack suggests for an unprobed endpoint is written in that source's own dialect (`quote?symbol=300750`) instead of SQL. End-to-end test: `tests/quote-api.test.ts` (a locally mocked quote API + a CSV of daily bars + a research report; `resolve` plans and runs both bound calls; removing the API from the config retires its capability, locators and plan node together).

Phase 3:

- **Source catalog**: scope kinds extend to image/audio/video/trace/memory/note/api/metric. Cooking derives per medium: images → caption + OCR segments (optional image vectors); audio/video → transcript time ranges; traces → turn segments (user request, tool call, observation, outcome).
- **Capability Graph**: `capabilities(id, scope_id, kind: table|endpoint|metric|tool, schema, semantics, sample_queries, freshness, cost, acl, placement)` + `locators(entity_id, capability_id, column_or_param, value)`; the human/agent-written semantic layer (metric definitions, join paths, pitfalls) lives in `capabilities/*.md` and is itself a source.
- **Connectors as Cordis plugins**: keep mysql/timescale/duckdb; add `http-json`, `prometheus`, `object` (local/S3 blobs). Removing a config disposes it → recipes that depend on it are reactively deactivated.
- **Placement policy**: materialize (documents and parsed text, media metadata/descriptions/embeddings, traces, memories, skills, schemas and semantics, entities and relations, long-lived facts, provenance/permissions, historical plans); federate (utilization, demand state, inventory, live orders, owners, monitoring metrics, high-churn MySQL rows, warehouse detail); cache(ttl) (query results, point-in-time snapshots, expensive computations, the current task's working set — the pack's in-process TTL cache, never persisted).

## 7. Agent-facing query surfaces

Implemented:

- `knode_search / knode_graph_search / knode_context_pack` accept `as_of` (system time), `valid_at` / `valid_range` (world time, claims) and `kinds` / `sources` (source scope); `knode_context_pack` also takes `freshness`. HTTP `?as_of= / ?valid_at= / ?valid_range= / ?kinds= / ?sources=`; CLI `--as-of / --valid-at / --valid-range / --freshness / --kinds / --sources`.
- `knode_lineage {kind, id}`: every live and historical evidence row behind an entity/relation/claim (source scope, extractor, weight, system-time window), the inputs of a page, the scope history of a document.
- `knode_history {path}`, `knode_sync {only?, verify?}`, `knode_forget {path}`; HTTP `/api/lineage`, `/api/history`, `/api/sync`, `/api/forget`, `/api/purge`, `/api/rebuild`; `DELETE /api/file` now has dispose semantics (delete + scoped sync).
- CLI: `sync` (`ingest` is an alias), `lineage show`, `history`, `forget`, `purge`, `rebuild`.

### 7.1 Temporal Resolver (Phase 2, implemented)

`src/store/resolver.ts` is the single place that turns loosely typed agent input into an explicit query envelope. Three time axes are kept apart on purpose — conflating them is the classic way an agent reads a stale number and calls it current:

| Axis | Parameter | Meaning | Scope |
|---|---|---|---|
| system time (tx) | `as_of` | what the knowledge base **believed then** | narrows history; the graph layer is recomputed from evidence |
| world time (valid) | `valid_at` (instant) / `valid_range` (interval) | when the assertion **holds in the world** | applies to the validity window of claims |
| freshness | `freshness` | how old a live/federated read **may be** | bounds the future: a probe cached longer than this is re-run |

A claim can be believed today (tx), be about last quarter (valid), while the live table behind it was read five minutes ago (freshness). None of the three substitutes for another.

- `valid_at` and `valid_range` are mutually exclusive; a range means **window overlap** (open ends are ±∞), and an instant degenerates to "the window contains it".
- Calendar shorthand widens automatically: `2026` → that year, `2026-08` → that month, `2026-08-10` → that day. Ranges accept `2026-01-01..2026-06-30`, `2026-03-01..` (open ended), a `{from, to}` object, or a `[from, to]` tuple.
- `freshness` takes seconds or `30s / 15m / 2h / 7d / 1w`.
- Invalid input throws `TemporalError`, which HTTP maps to 400 rather than 500 — it is an error the caller can fix.
- `resolved.notes` echoes the constraints that actually applied (the ContextPack's `applied` field, the CLI's `applied:` line).

### 7.2 `kinds` / `sources` filters (Phase 2, implemented)

- `kinds`: `doc` (raw/docs), `wiki` (human-written wiki prose), `view` (a generated wiki page), `skill` (raw/skills). `wiki` and `view` share a directory, but only the first is a knowledge source.
- `sources`: path prefixes, reusing `normalizePrefixes`, so `raw/docs/reports` selects that subtree.
- For chunk retrieval the filter is a `documents` predicate funnelled through `docLiveAt`, so no recall route can silently drop it. For graph rows (entities, relations, claims) it means "**supported by evidence from a scope that passes the filter**" — the lineage-faithful reading, and one that composes with `as_of` by looking only at evidence live at that time.
- The SAG bipartite expansion carries the same predicates: an `as_of` walk must not bridge through an entity that did not exist then, and a scoped walk must not escape its sources through a shared entity.

### 7.3 Structured `knode_claims` and the catalog (Phase 2, implemented)

- `knode_claims {subject?, object?, types?, statuses?, text?, as_of?, valid_at?, valid_range?, kinds?, sources?, limit?}` returns the assertions themselves instead of prose the agent has to read and trust. Each row carries its validity window, `status` (fact/suspected/disputed), `stale` (the window has closed), the scope path that supports it and its evidence count. CLI `knode-os claims [subject]`, HTTP `GET /api/claims`.
- `knode_query(source='catalog')` runs SQL against the read-only PGlite views `v_documents / v_entities / v_relations / v_claims / v_scopes / v_evidence / v_pages / v_datasets / v_mentions`. The views hide fold bookkeeping (`fold_sha`, `dirty_reason`) and default to currently believed rows, so a plain SELECT cannot read a tombstone as if it were current; history stays reachable through `v_evidence`. The guard is `assertReadOnlySql` + SELECT/WITH only + a relation allowlist checked at every place Postgres reads a relation (FROM and comma lists, JOIN, LATERAL, TABLE, parenthesised FROM items; CTE names only where in scope) + an enforced outer `LIMIT`. The database enforces the same: each query runs in a READ ONLY transaction that is always rolled back, under a statement timeout, as the workspace's own reader role, which may only SELECT its schema's views — so a function call the guard cannot see into, such as `query_to_xml`, reaches nothing more. `knode_datasources` and `datasource list` list the views.

### 7.4 Virtual filesystem (Phase 4, implemented)

`src/compiler/vfs.ts`. Agents are good at reading files, so there is a file-shaped surface too:

```
/                                    the roots
/entities/<id>.md                    one entity: type, aliases, claims, neighbours, how it can be reached
/claims/<subject>.md                 that subject's assertions with their validity windows
/capabilities/<source>/<name>.md     schema, semantics, pitfalls, sample queries
/live/<capability>?<param>=<value>   executes the capability and renders the rows
```

Everything is **rendered on read**: there is no directory to keep in sync, no page to regenerate, and `?as_of=` works on every path because the render is just a query. `/live/` is the one path that reaches outside the process, so it goes through the same executor every other live read uses — dialect-routed, guarded, row-capped.

Entry points: `knode_read` (a path starting with `/` reads the virtual FS), `GET /api/vfs?path=`, `knode-os vfs <path>`.

## 8. Context Compiler (Phase 4, implemented; the plan runs on the agent side)

### 8.1 `resolve`

```
resolve({query, actor, as_of?, valid_at?, budget:{max_tool_calls, max_latency_ms, max_tokens}})
 1. intent        intents/*.yaml matchers (regex / keywords / entity types) + example-embedding similarity + optional LLM classification; fallback default
 2. grounding     entities / parameters (matchEntities over locators and alias index)
 3. planning      per evidence slot, enumerate candidates: local (claims/pages/chunks) vs live capabilities (templates)
                  Utility = expected success gain − tokens − latency − data cost − permission risk − noise probability (statistics from receipts)
 4. local fill    slots the materialized layer can answer are filled in the DB (cheap, ACL-filtered, with provenance)
 5. compile Plan  remaining slots (live / expensive / external tools) become a Plan for the agent
 6. assemble      ContextPack v2 (a strict superset of today's fields) + receipt_id
```

### 8.2 ContextPack v2

```json
{ "intent": {"type","entities","time_range"},
  "facts": [{claim, valid_time, tx_time, status, confidence, evidence:[{scope_key, segment_id, extractor}]}],
  "documents": [{path, chunk_id, score, why}], "graph_context": [...],
  "live_results": [],                       // filled in through feedback after the agent ran the plan
  "skills": [{recipe, success_rate, applicable}], "memories": [...],
  "unknowns": [{question, default_assumption, risk}],
  "plan": {...},
  "available_next_queries": [{node_id, capability, args, est_cost, est_latency, expected_gain}],
  "provenance": [...], "permissions": [...], "budget_report": {used, cut:[...]}, "receipt_id": "..." }
```

### 8.3 Plan DSL: one plan, two renderings

```yaml
plan_id: r_01J...            # = receipt id
intent: stock_analysis
budget: { max_tool_calls: 8, max_latency_ms: 5000, max_tokens: 12000 }
slots: { required: [canonical_identity, latest_quote, recent_filings], optional: [peer_baseline, recent_news] }
nodes:
  - id: quote
    fills: latest_quote
    tool: { kind: mcp, server: knode-os, name: knode_query }   # kind: mcp (any server) | cli | http
    args: { source: market-mysql, sql: "SELECT ... WHERE symbol = '300750' ORDER BY trade_date DESC LIMIT 5" }
    freshness: 30s
    on_error: { fallback: hist_bars }
  - id: hist_bars
    fills: latest_quote
    tool: { kind: mcp, server: knode-os, name: knode_query }
    args: { source: hist-parquet, sql: "..." }
  - id: news
    fills: recent_news
    tool: { kind: mcp, server: knode-os, name: knode_search }
    args: { query: "CATL latest", valid_range: ["2026-08-01", null], k: 6 }
  - id: peers
    fills: peer_baseline
    tool: { kind: mcp, server: knode-os, name: knode_resolve }  # nested resolve
    args: { query: "recent valuations of peers", as_of: "$as_of" }
    after: [quote]
render: json-graph | ts-program
```

- `json-graph`: Claude / custom agents call MCP/CLI tools node by node, `after` decides parallel vs sequential — the shape of Claude Code's workflow phases/parallel/pipeline; `ts-program`: a program against the generated SDK (`tools.knode_query(...)`) for DeepSeek Harness's `run_code`. Rendering happens in the database, execution on the agent side — the database embeds no sandbox, but every call to its own tools still enforces read-only SQL, `maxRows`, token estimates and ACL: budgets are hard on the DB's tools and annotations on the plan.
- `knode_capabilities` returns the tool catalog and a d.ts (each datasource table → `live.<ds>.<table>.query(template, params)` with column names/types in doc comments).
- Feedback: `knode_feedback(receipt_id, executed:[{node_id, ok, elapsed_ms, rows|tokens}], used_ids[], ignored_ids[], outcome, revised_plan?)`; a `revised_plan` enters the recipe distillation queue.
- **Recipe** (the configurable part) = a plan template with slots, `type: recipe` under `packs/*.md` (playbooks upgrade automatically: `retrieval` → a `kb.search` node, `probes[]` → `live.<source>.sql` nodes); selection order `entity:<id> > intent + entity type > intent > default`.
- **Receipts** (schema v5): `receipts(id, kind, query, actor, recipe_path, recipe_sha, program_sha, entities, calls[], budget, summary, as_of, valid_at)`; `pack_events` becomes a compatibility view over `receipts` (existing rows are migrated across), so the learning loop's query does not change by a character; receipts are also appended to `ledger/receipts.jsonl`.
- **Learning** (Phase 5): receipts → `(intent, slot, capability)` success / usage / cost → a ranker (counting statistics + Thompson sampling first, explainable, written to `wiki/learning/`); successful and novel plans → clustering → candidate recipes → offline replay over historical receipts → read-only / permission checks → approval (the suggestions flow; suggestions go `stale` when their recipe is deleted) → published to `packs/`.

### 8.5 The learning loop (Phase 5, implemented)

**Ranker (`src/compiler/ranker.ts`).** Two things have to be true at once. It must *exploit* — a source that has answered this slot nine times running should keep getting the call — and it must *explore*, because a capability that lost its first coin flip would otherwise never be tried again, and the planner would happily converge on a mediocre source forever. Thompson sampling gets both from one draw: score each candidate by sampling its Beta posterior. A well-evidenced 90% capability almost always beats a once-failed one, but the once-failed one has a wide posterior and so gets picked occasionally — which is exactly the evidence it needs to prove itself or be dropped for good.

Three decisions matter:

- **`used`, not `ok`, is the success signal.** A source that returns rows nobody keeps is answering the wrong question, and counting it as a win is how a planner learns to be confidently useless.
- **The posterior decides "is this worth a call"; the draw decides "which one".** A required slot with one candidate must never be dropped because a draw came out low — Thompson sampling chooses which arm to pull, not whether to pull.
- **Freshness the caller asked for is a constraint, not a preference.** A source staler than the ceiling sorts behind every compliant one and exploration happens within each group: trying a stale source "to learn" is answering a different question than the one asked.

The counts are written to `wiki/learning/capability-ranking.md` as an ordinary wiki page — **the numbers steering the planner have to be reviewable, and correctable, by a person**. `rng` is injectable, because an exploration strategy nobody can reproduce is one nobody can debug.

**Recipe distillation (`src/compiler/distill.ts`).** When the same shape of plan keeps succeeding, that shape is knowledge; leaving it implicit means re-deriving it, and re-paying for the exploration, every time. A candidate must survive three checks before it is even *proposed*:

1. **replay** — offline against the receipts it came from (no source is contacted). The question is not "would this run" but "when this shape ran before, did the caller keep what it produced";
2. **safety** — every statement must be read-only. A recipe is published configuration: once accepted it runs unattended, so "the agent only ever sent SELECTs before" is not an argument;
3. **approval** — through the existing suggestions queue; only an accept writes into `packs/`.

The ordering matters. Auto-publishing means a mistake in one lucky plan silently becomes the default for every future question of that kind, and the receipts that would reveal it are now measuring the mistake. A plan the agent rewrote and sent back via `revised_plan` forms its own shape — the most valuable signal there is, because somebody had to fix our plan to get an answer.

**Pack evaluation (`src/compiler/evaluate.ts`).** Retrieval benchmarks ask "did the right document come back". That is the wrong question for a context pack, which is judged by what the agent *kept*: returning twenty documents to deliver two burns eighteen documents' worth of context on nothing, and no recall metric will say so. So the headline number is **precision = used / returned**, measured from receipts rather than a fixture set — the only honest judge of whether context was useful is the caller that had it. Unreported resolves are counted separately rather than assumed successful: an agent that never reports back is a measurement gap, not a perfect score. The report lands in `wiki/learning/pack-evaluation.md` and names capabilities that are called repeatedly and never used.

All three run in the nightly dream, and on demand via `knode-os learning [--distill]` / `knode_learning`.

## 9. Other agent-database features (Phase 6, implemented)

Schema v6. These are the things a database usually gets wrong for agents, each independent of the others.

### 9.1 Negative knowledge (`src/compiler/absence.ts`)

Without it an agent re-runs the same empty query every session, pays for it every time, and never accumulates the one thing the failure taught it. An empty result is recorded as an ordinary claim with `status: absent` — subject, statement, and **a validity window**. The window is the point: "no filings for this company" is true of a moment, not forever, and recording it without an expiry turns one empty result into a permanent blind spot.

- Scope kind `absence`, keyed by the exact binding that came back empty (`<capability>:<param>=<value>`), so re-observing **replaces** rather than accumulates, and disposing the datasource takes every absence it produced with it — a "we checked and found nothing" about a source that no longer exists is not knowledge, it is litter.
- Only a call that **succeeded and returned zero rows** counts. An *error* does not: a source that was down tells you nothing about whether the data exists, and recording it as absence would suppress the retry that would have found it.
- In the fold, `absent` is not a weak `fact`: it holds only while every piece of evidence says absent, and stops the moment any source asserts otherwise. (This fold branch was forced by a test — an earlier version folded `absent` into `suspected`, quietly erasing every recorded absence.)
- The planner reads absences to skip a call that came back empty recently, and starts proposing it again once the window closes. Suppressed calls appear in `budget_report.cut` with the reason.

### 9.2 Snapshots and worksets (`src/compiler/workset.ts`)

A plan takes minutes; a research session takes hours. Without a pin, every step reads a slightly different knowledge base, and the contradiction the agent reports at the end may be nothing but two reads taken either side of a sync. `checkout` freezes the system time once, and every later call passing `workset` answers at that instant. An explicit `as_of` still wins — a workset is a default for a session, not a cage.

`commit` is the other half: conclusions are written back **as an ordinary Source** (`raw/docs/notes/<id>.md`), picked up by the next sync as a document with its own scope, attributable and revertible. An agent's conclusion earns no shortcut into the graph: if it is wrong, deleting the file has to undo it exactly like any other bad source.

### 9.3 Trust tiers and disputes (`src/lineage/trust.ts`)

An agent's writes land **quarantined**: indexed, searchable and attributable, but unable to silently become the knowledge base's position. Where a quarantined claim disagrees with a trusted one, the fold records a **dispute instead of overwriting**. That is the difference between a system that accumulates knowledge and one that accumulates whatever the last agent happened to believe.

- **Trust follows the document's origin, not whoever ran the sync.** Frontmatter `actor` (or an explicit `trust`) decides the tier; sync is a mechanical reconciliation, not the author. (This was also forced by end-to-end verification: an earlier version let an agent-written note become trusted because somebody else ran a sync.)
- "Contradicts" is deliberately narrow: same subject, same claim type, different statement, overlapping validity window. Two claims about different quarters do not disagree, and a broad definition would bury the real disagreements under noise nobody reads.
- Promoting a source with `knode_trust` **resolves the disputes it opened** — the review is what the quarantine was waiting for.
- On the read side, `trust: 'trusted'` excludes unreviewed agent writes; the default is `any` (visible and marked, but unable to override a trusted claim).

### 9.4 ACL inheritance

ACLs live on the scope and are **intersected** on the way down: a page derived from a public document and a restricted one is restricted, because taking the union — or the first input's list — is how derived artifacts leak. An empty ACL means unrestricted, so it is the identity for the intersection; and a restricted scope must refuse when **who is asking is unknown**, because that is not the same as "anyone may read this".

### 9.5 Change subscriptions (`src/compiler/subscribe.ts`)

Polled, not pushed, and the cursor is a **system time** rather than a queue position. A subscriber that was offline for a week still sees everything since, and two subscribers reading the same target never consume each other's events — something a queue would have to be careful about and a bitemporal store gets for free. `peek` does not advance the cursor: a subscriber that crashes mid-handling should see the same events again.

Targets are `entity` (evidence + claims), `source` (scope applies/disposes) and `intent` (receipts).

### 9.6 Delivered in earlier phases

Budgets and cut reports (Phase 4's `budget_report.cut`), receipts and feedback (Phase 4 receipts + Phase 5 precision), capability cost/freshness labels (Phase 3), explainable plans (Phase 4's `node.why`).

## 10. Data directory (layout v3)

Layout v3 (2026-09-13) removed the `cooked/` copy layer: the raw path is every
source's key, text sources are normalized in memory, and everything derived
lives in `.sidecar/<key>/` split by lifecycle. Mentions of `cooked/` elsewhere
in this document describe the v2 implementation.

```
<data>/
├── raw/            originals (L0) and the key space: raw/docs, raw/traces, raw/skills
├── .sidecar/       derived state (L1), one directory per source key, mirroring the tree:
│                   content.md (converted PDF/image, trace episode), meta.json, tier0.json, tier1.json,
│                   usage.json, views/source-summary.md; .sidecar/wiki/…/render.md caches concept pages
├── wiki/           views + human pages (L3); wiki/.archive/  archived generated pages
│                   wiki/learning/  capability ranking and pack evaluation (reviewable)
├── playbooks/      packs/ (playbooks / recipes), capabilities/ (semantic layer over live sources, itself a Source),
│                   intents/ (intent specs: the slots an answer needs)
├── ledger/         events.jsonl (machine truth); receipts.jsonl (one per resolve); attic/<scopeId>/ (whole sidecar
│                   directories of removed sources); attic/blobs/ (previous file versions)
└── .knode/db       PGlite projection (`rebuild` reconstructs it)
```

## 11. Roadmap and decisions

| Phase | Content | Status |
|---|---|---|
| 1 | migrations · lineage runtime · evidence/fold · sync reconciliation · page views · as_of/valid_at · lineage/history/forget/purge/rebuild · tests | ✅ |
| 2 | Temporal: a Resolver that separates the three time axes, `valid_range/kinds/sources` in search/sag/graph/pack, `knode_claims`, `knode_query(source='catalog')` over the `v_*` views, drop the legacy TEXT date columns (schema v3) | ✅ |
| 3 | Logical catalog and modalities: capabilities/locators/notes (schema v4), trace→episode, http-json/prometheus/object connectors, image captions | ✅ (audio/video transcripts await an ASR dependency) |
| 4 | Context Compiler: intents, planner, Plan DSL with both renderings, `knode_resolve/plan/feedback/capabilities`, recipes, receipts (schema v5), virtual FS | ✅ |
| 5 | Learning loop: ranker (Thompson sampling), recipe distillation and offline replay, pack evaluation | ✅ |
| 6 | Negative knowledge, checkout/commit, trust tiers and disputes, ACL inheritance, subscriptions (schema v6) | ✅ |

Decisions (Phases 5–6): the ranker's success signal is `used`, not `ok`; the posterior decides whether a call is worth making and the draw decides which capability makes it; `used_ids: []` reads as "kept nothing", never "kept everything"; a caller's freshness ceiling is a hard constraint and exploration happens only within the compliant group; distilled recipes always go through human approval and are never auto-published; an absence is created only by a call that succeeded with zero rows, and always carries an expiry; `absent` survives the fold only while every piece of evidence agrees; trust follows the document's origin rather than the actor running sync; ACLs intersect down the derivation chain, an empty ACL is the identity, and an unknown actor cannot read restricted content; subscription cursors are system times and `peek` does not advance them.

Decisions (Phases 3–4): a capability's machine-discovered half and its written half live in separate tables and are folded on read — retiring a source must not delete someone's prose; capabilities, locators and notes are owned by the writing scope and closed by scope id, reusing the evidence contract instead of adding inverses; built-in tools are synthesized on read rather than stored; `http-json` endpoints are an allowlist, not a template; dialect routing funnels through `execute.ts` and only SQL goes through the SQL guard; trace episodes are off by default; intent matching stays explainable (the LLM classifier is a later refinement); a recipe beats the planner, but its nodes for locally-filled slots are dropped; plans render on the DB side and execute on the agent side, with budgets hard on knode's tools and advisory on the plan.

Decisions (Phases 1–2): migrations are numbered by consecutive schema version, so Phase 2 landed as **v3** (an earlier draft of this document called it "migration 4"); the `claims.start_date/end_date` TEXT projection was dropped — one fact needs one representation, two drift apart, and the date projection is computed on read (`toDateString`); the catalog exposes views rather than base tables, so agent-written SQL is unaffected by base-schema changes; aggregate columns are recomputed per touched id (not views, not delta counters); entity ids stay `slugify(name)` in Phase 1 (evidence attrs keep each source's original name, so entities can be split later without losing lineage); chunks are hard-deleted on dispose, `as_of` guarantees the graph layer, chunk history comes from `rebuild --history`; machine truth is a small event log plus the attic while effect details stay in the rebuildable database; the Context Compiler embeds no sandbox and plans run on the agent side; old databases upgrade by rebuilding the graph layer while keeping chunks and embeddings.

## 12. Behavioural differences from the previous version

- `ingest` is an alias of `sync`; `--only` and watcher-driven incremental runs now dispose removed sources too.
- `wiki/sources/index.md` is no longer overwritten wholesale; it carries a managed `sources` region. The hot-topics block in `wiki/index.md` uses `knode:begin hot-topics` markers.
- `generateWiki` no longer skips existing pages; it regenerates by deps. Human content outside the markers is preserved.
- `documents.status` gains `disposed`; `suggestions.status` gains `stale`; `entities/relations/claims` carry `tx_from/tx_to`, and readers see live rows only by default.
- After deleting a file, `.knode/db` keeps tombstones and evidence history; use `forget` or `purge` to erase.
- (Phase 2) `claims.start_date` / `end_date` are gone; the `startDate` / `endDate` fields on read paths are projected from `valid_from` / `valid_to`, with unchanged semantics.
- (Phase 2) The `sources` array of `knode_datasources` and `GET /api/datasources` gained a `catalog` entry, alongside a `catalog` list of the views.
- (Phase 3) `DataSourceConnector` gained `dialect`; every source query now goes through `runSourceQuery`, and the SQL guard applies only to the sql dialect. Beyond `datasources[].tables[]`, http-json declares `endpoints[]` and prometheus declares `metrics[]`.
- (Phase 3) `initDataDir` creates `capabilities/` and `intents/`, and writes `packs/default.md` and `intents/entity-overview.yaml` on first run (`ensureDefaultPlaybooks` had never actually been called).
- (Phase 4) `pack_events` is a view rather than a table; writes go to `receipts`. Code that reads it is unaffected.
- (Phase 4) `knode_read` serves the virtual filesystem for any path starting with `/`.
- (Phase 5) `node.why` gained `posterior` and `exploring`; `expectedGain` is now a Thompson draw and therefore not deterministic — pass `rng` when you need reproducibility, and assert on `posterior`.
- (Phase 5) New suggestion kind `recipe`, accepted by `applySuggestion` into `packs/`; new CLI `suggestions list/accept/reject` (only HTTP had an accept path before).
- (Phase 6) `scopes` gained `trust` / `acl` and `evidence` gained `trust`; the `v_scopes` view appends both. `search` / `graph` / `claims` / `resolve` gained `--trust` and `--actor`.
- (Phase 6) `CLAIM_STATUS` gained `absent`; `ScopeKind` gained `absence`.
