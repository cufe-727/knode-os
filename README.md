# knode-os

> Local-first knowledge OS for coding agents — an auto-built **wiki** + **knowledge graph** + **vector recall** over your documents, your agents' traces, and the skills they use. One process, one folder, embedded Postgres.

[简体中文](./README.zh-CN.md) · [Design overview](./docs/design/00-overview.md) · [Agent Context Database (v2)](./docs/design/05-agent-context-db.md) · [OKF compatibility](./docs/design/02-okf-compatibility.md) · [Obsidian compatibility](./docs/design/03-obsidian-vault.md)

knode-os combines two ideas — [llm_wiki](https://github.com/nashsu/llm_wiki)'s "the LLM maintains a persistent, interlinked wiki instead of doing RAG from scratch every time" and [gbrain](https://github.com/garrytan/gbrain)'s "markdown is the system of record, Postgres is a disposable derived index" — and points them at what coding agents leave behind: docs, session traces, and skills.

## Highlights

- **One command**: `knode-os serve` starts the web UI, the REST API, a file watcher, periodic trace sync, and the nightly dream.
- **Your filesystem is the database.** A plain data directory (`raw/` + `wiki/`) you can read, edit, grep, and `git init`. The embedded [PGlite](https://pglite.dev) (Postgres + pgvector, WASM) index under `.knode/` is rebuildable at any time with `knode-os ingest`.
- **Agent traces, collected automatically.** Claude Code (`~/.claude/projects`) and Codex CLI (`~/.codex/sessions`) session transcripts are mirrored into `raw/traces/`; used skills into `raw/skills/`. Traces feed the nightly dream analysis (they are not indexed for search); skills are searchable.
- **Hybrid retrieval**: pgvector cosine recall + Postgres full-text + knowledge-graph signals, fused with RRF, plus a mild usage-heat boost. Works offline out of the box (built-in hashing embedder); plug in any OpenAI-compatible embedding endpoint for production quality.
- **SAG multi-hop retrieval**: opt-in `chunk → entity → chunk` event expansion over the existing graph, vector coarse ranking, direct-route fallback, and an inspectable bridge-entity trace for every structural hit.
- **Tiered knowledge graph**: tier 0 wires `[[wikilinks]]` and NLP concept co-occurrence deterministically on every ingest (no LLM). Changed docs are queued for tier-1 LLM entity/relation/claim extraction, which runs in the background while `serve` is up (or via `knode-os extract`) under a daily token budget, hottest documents first. Results are persisted to per-document sidecars so a rebuild never re-pays LLM cost. Multi-hop graph search and graph insights (hubs, isolated nodes).
- **`/dream`**: every night (or on demand) it digests recent agent sessions — what was asked, which tools failed, what repeats — and proposes improvements to your **skills**, **memory**, and **knowledge base**, queued for one-click accept/reject.
- **Live data sources — one logical database.** Register MySQL, TimescaleDB, parquet/CSV directories (DuckDB, an HDFS stand-in), JSON-over-HTTP endpoints, Prometheus metrics and object stores; knode-os introspects them into the knowledge graph as capabilities (`datasource` / `dataset` entities, `appears_in` links and locators from sampled entity columns — endpoints and metrics get theirs derived from the tables and aliases already known) and generates `wiki/datasets/` pages — while the rows stay in their source systems and are fetched live. Mention a company and the graph knows *which documents*, *which tables* and *which API endpoints* can answer for it.
- **Context packs.** `knode-os pack "<utterance>"` (or the `knode_context_pack` MCP tool) matches entities in the utterance, expands the graph (doc chunks, time-bound claims flagged `STALE`/`CONFLICT`, linked live tables), executes playbook-declared probe queries against the live sources (asOf-stamped, short-TTL cached, never persisted), and returns gap analysis with ready-to-run follow-up SQL.
- **Playbooks that learn.** Context packs are driven by agent-editable `packs/*.md` workflows. Every build is logged to `pack_events`; `knode-os pack-optimize` (also part of the nightly dream) turns failure/gap patterns into full playbook revisions — accepted suggestions are written back to `packs/`, so the next query runs a better script.
- **MCP server** so Claude Code / Codex (CLI or app) can search, ask, read, write, grep, run native SQL against live sources, and build context packs directly.
- **Native Google OKF v0.1 compatibility**: `wiki/` is itself a portable Open Knowledge Format bundle, with validation, legacy migration, lossless bundle import/export, and graph wiring for ordinary OKF markdown links. Unknown types, extension frontmatter and broken links are consumed permissively as the specification requires.
- **Native Obsidian Vault**: open `wiki/` directly in Obsidian. Vault-local settings and an attachment directory are preconfigured; Properties, aliases, tags, `[[wikilinks]]`, vault paths, heading/block references and `![[embeds]]` work natively. Every imported or exported OKF knowledge bundle is also initialized as its own Vault.
- **`ask`**: cited answers from your knowledge base with an explicit "what's missing" gap list.

## Quickstart

```bash
pnpm install && pnpm build

# initialize a data directory (default ~/.knode-os, or --data <path> / $KNODE_OS_DATA)
node dist/cli.js init --data ~/knode-data

# drop some markdown/text into <data>/raw/docs, then
node dist/cli.js ingest --data ~/knode-data
node dist/cli.js search "vector recall" --data ~/knode-data

# start everything (web UI at http://127.0.0.1:9100)
node dist/cli.js serve --data ~/knode-data
```

Install globally (`npm link` or `pnpm add -g .`) to use the `knode-os` binary directly.

### Data directory

```
<data>/
├── knode.config.json   # embedding / llm / server / dream settings
├── purpose.md          # what this knowledge base is for
├── schema.md           # wiki structure rules
├── raw/                # originals, never rewritten
│   ├── docs/           # your uploads
│   ├── traces/         # claude/ + codex/ session transcripts (auto-synced)
│   └── skills/         # skills & prompts your agents used (auto-synced)
├── cooked/
│   └── docs/           # normalized Markdown from text, PDF and image sources — indexed —
│                       # plus <name>.knode.json sidecars (metadata, LLM extraction
│                       # results, usage/heat stats) that survive a DB rebuild
├── wiki/                 # native OKF v0.1 bundle + Obsidian Vault
│   ├── .obsidian/        # vault settings (never overwrites existing settings)
│   ├── attachments/      # Obsidian attachments
│   ├── index.md  overview.md  log.md
│   ├── entities/  concepts/  sources/  dreams/  datasets/
├── packs/              # context-pack playbooks (agent-editable, revised by the learning loop)
└── .knode/             # derived PGlite index — safe to delete & reindex
```

Search results cite `cooked/docs/...` paths — the normalized twin of what you put in `raw/docs/`.

When `serve` is used with the web UI, `--data` is the workspace root. A user can own multiple workspaces; every workspace is a complete independent data directory with the layout above:

```
<data>/
├── users/<username>/workspaces/<workspace-id>/  # private files, config, wiki and PGlite index
└── teams/<team-name>/                         # shared by users who select the same Team name
```

Create and switch workspaces from the workspace menu. **Settings → Clear workspace** closes its background services, permanently removes the entire workspace directory (files, database, graph, traces and config), then recreates a clean empty skeleton under the same name. Historical trace auto-sync stays paused after creation/clearing; use **Traces → sync now** once to import history and resume periodic syncing.

Existing files directly under `<data>/raw`, `<data>/wiki`, and `<data>/.knode` are left untouched and are not migrated automatically. CLI commands such as `ingest` and `search` can target a scoped directory directly, for example `--data ~/.knode-os/users/admin/workspaces/default`.

### Configure models

Each web workspace owns its model config. Use **Settings** after selecting the
Personal or Team workspace, or edit the scoped file directly:

- User workspace: `<data>/users/<username>/workspaces/<workspace-id>/knode.config.json`
- Team: `<data>/teams/<team-name>/knode.config.json`

CLI-only data directories continue to use `<data>/knode.config.json`:

```jsonc
{
  "embedding": {
    "provider": "openai",            // default is "local": offline hashing embedder, 384 dims
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "env:OPENAI_API_KEY",  // or a literal key
    "model": "text-embedding-3-small",
    "dimensions": 1536
  },
  "llm": {
    "provider": "openai",            // also: "codex-cli" / "claude-cli" / "cursor-cli"
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "env:OPENAI_API_KEY",
    "model": "gpt-4.1-mini"          // empty = LLM features off, heuristics used
  },
  "extraction": {
    "entityLlm": { "provider": "codex-cli", "model": "" },
    "conceptLlm": { "provider": "cursor-cli", "model": "" },
    "documentLlm": { "provider": "codex-cli", "model": "" } // vision: API / Codex / Claude Code
  },
  "retrieval": {
    "sag": { "seedChunks": 12, "entityFrontier": 24, "maxEventsPerEntity": 12, "candidatePool": 120, "maxHops": 2, "directRatio": 0.5 }
  },
  "dream": { "schedule": "03:00", "lookbackDays": 7 },
  "datasources": [                   // live external tables — schema goes into the graph, rows stay put
    { "id": "market-mysql", "kind": "mysql", "host": "127.0.0.1", "port": 3307,
      "user": "knode", "password": "env:MYSQL_PWD", "database": "market",
      "tables": [
        { "name": "companies",
          "entityColumns": [{ "column": "name", "entityType": "organization", "aliasColumns": ["symbol"] }] },
        { "name": "daily_quotes",
          "entityColumns": [{ "column": "symbol", "entityType": "organization" }] }
      ] },
    { "id": "ticks-tsdb", "kind": "timescale", "port": 5433, "database": "market" },
    { "id": "hist-parquet", "kind": "duckdb", "path": "datasets/hdfs" },   // *.parquet and *.csv become views
    { "id": "quote-api", "kind": "http-json", "baseUrl": "https://api.example.com", "freshness": "15s", "cost": 2,
      "headers": { "Authorization": "env:QUOTE_API_KEY" },
      "endpoints": [{ "name": "quote", "path": "/v1/quote", "params": [{ "name": "symbol", "required": true }],
                      "resultPath": "data", "entityParams": [{ "column": "symbol", "entityType": "organization" }] }] }
  ],
  "pack": { "maxEntities": 4, "maxDocs": 6, "maxProbes": 6, "liveTtlSeconds": 30, "staleNewsDays": 7 }
}
```

Any OpenAI-compatible endpoint works (Ollama, vLLM, SiliconFlow, …). Entity extraction, concept synthesis and document vision can independently inherit the default LLM or use their own route. Image/scanned-PDF conversion supports a vision-capable OpenAI-compatible model, Codex CLI or Claude Code CLI. Text PDFs are extracted locally without an LLM. Changing `dimensions` drops and rebuilds the embedding table on next start. Everything can also be edited from the web UI's **Settings** tab (with route tests).

Further config blocks (see `knode-os config` for the full active set with defaults): `ingest` (chunk size/overlap, file watching), `extraction` (daily token budget, batch size, interval, tier-1/2 models, claims on/off), `retrieval.sag` (seed/frontier/candidate limits, hop count, direct-route ratio), `heat` (usage-heat half-life, search boost weight, cold threshold), `trace` (Claude/Codex trace directories, skill dirs, sync interval), `server` (host/port).

The LLM unlocks: tier-1 entity/relation/claim extraction into the graph, `ask` answers, `wiki generate` source summaries, tier-2 community pages, and LLM-grade dream analysis. Without it, everything still runs on deterministic/heuristic paths.

## CLI

```
knode-os init                 create the data directory layout + database
knode-os serve [-p port]      web UI + API + watcher + trace sync + tier-1 extraction loop
                              + usage-stats flush + nightly dream & tier-2 refinement
knode-os sync [--only p..] [--verify] [--no-llm] [--no-datasources]
                              reconcile declared sources (raw/docs, wiki, skills, datasources) with
                              the index: apply changed files as scopes, dispose removed ones (every
                              effect reverted), regenerate dependent wiki views. `ingest` is an alias.
knode-os lineage show <entity|relation|claim|page|document> <id>
                              evidence behind a graph row (source scope, extractor, time window)
knode-os history <path>       apply / dispose / purge history of a source
knode-os forget <path>        delete a source, dispose it and purge its history (irreversible)
knode-os purge [--before iso] [--archived]  erase disposed history / archived pages
knode-os rebuild [--history]  drop .knode/db and reconstruct it from files + ledger
knode-os datasource list|sync             registered live tables / re-introspect schemas into the graph
knode-os datasource query <id> <sql>      read-only native SQL against a configured source
knode-os pack <utterance> [--json] [--as-of iso] [--valid-at iso]
                                          build a context pack (entities + evidence + live probes + gaps)
knode-os pack-optimize [--apply]          learn from pack_events → playbook revision suggestions
knode-os demo seed-stock                  stock-analysis demo data (see demo/stock/README.md)
knode-os extract [--batch n] [--concurrency n]  drain the tier-1 LLM extraction queue within the daily budget
knode-os import archive <dir> [--since YYYY-MM] [--until YYYY-MM] [--platform p,..] [--relevant-only]
                              import crawler-archive envelope NDJSON into raw/docs/finance volumes
knode-os bench build          full build (ingest → tier-1 drain → wiki) with per-stage timing report
knode-os bench qa-gen [--n]   generate a QA eval set (eval/qa.jsonl) from stratified chunk samples
knode-os bench retrieval      recall@k / MRR / NDCG@10 for vector|keyword|hybrid|sag|graph over the QA set
knode-os bench answer [--n]   end-to-end ask() quality, graded by an LLM judge
knode-os bench extract-compare [--backends ..]  same-doc extraction shootout: openai vs codex-cli vs claude-cli
knode-os search <q> [-m hybrid|vector|keyword|sag] [-k n] [--as-of iso] [--json]
knode-os ask <question> [-m hybrid|vector|keyword|sag]  cited answer + gaps (needs llm.model)
knode-os graph [q] [--depth n] [--as-of iso] [--valid-at iso] [--insights] [--json]
                              (no query: top-entity overview; --as-of recomputes from evidence)
knode-os obsidian init [dir]           initialize/repair a Vault (default: <data>/wiki)
knode-os obsidian status [dir]         check whether a Vault is ready to open
knode-os okf validate [bundle] [--json]  validate OKF v0.1 (defaults to <data>/wiki)
knode-os okf migrate [--dry-run]         migrate a legacy wiki structure to OKF v0.1
knode-os okf import <bundle> [--name n]  losslessly import under raw/docs/okf/<name>
knode-os okf export <dir>                validate and export the native wiki bundle
knode-os wiki generate        source summary pages + entity stubs
knode-os wiki refine          tier-2: hot-community concept pages + claim audit + hot topics
knode-os trace sync           pull new Claude Code / Codex traces + skills
knode-os dream [--lookback d] sync traces, then analyze → skills/memory/knowledge suggestions
knode-os mcp                  MCP server on stdio
knode-os connect claude|codex register the MCP server with your agent CLI
knode-os config               show active config (redacted)
```

Every command takes `--data <path>` (or set `KNODE_OS_DATA`).

## Use from Claude Code / Codex

```bash
knode-os connect claude   # runs: claude mcp add --scope user knode-os -- node <cli> mcp --data <dir>
knode-os connect codex    # appends [mcp_servers.knode-os] to ~/.codex/config.toml
```

MCP tools exposed: `knode_resolve` (the one to call first — see below), `knode_plan`, `knode_feedback`, `knode_capabilities`, `knode_checkout` / `knode_commit` / `knode_worksets` (pin a consistent view for a long task, then write conclusions back as a source), `knode_absences` (what we looked for and did not find), `knode_disputes` / `knode_trust` (contradictions, and promoting a quarantined write), `knode_subscribe` (watch an entity, source or intent), `knode_learning` (what the planner has learned), `knode_search`, `knode_graph_search`, `knode_claims`, `knode_ask`, `knode_ls`, `knode_read` (a path starting with `/` reads the virtual filesystem), `knode_write` (wiki/, raw/docs and packs/ only), `knode_grep`, `knode_ingest` / `knode_sync`, `knode_lineage`, `knode_history`, `knode_forget`, `knode_okf_validate`, `knode_graph_insights`, `knode_suggestions`, `knode_context_pack`, `knode_datasources`, `knode_query` (read-only native SQL; `source="catalog"` queries the knowledge base's own `v_*` views). Three independent time axes: `as_of` (system time — what was believed then), `valid_at` / `valid_range` (world time — when a claim holds), and `freshness` (how old a live read may be); `kinds` / `sources` bound which sources may answer.

**`knode_resolve` instead of search.** Search returns whatever text matches. `resolve` works out what an answer to this *kind* of question needs — the slots declared in `intents/*.yaml` — fills everything the local index can answer, and compiles what is left into a plan of tool calls the agent executes. A required slot nothing can fill comes back in `unknowns` rather than being papered over with plausible documents. Report back with `knode_feedback` and the receipt id, and the next resolve for that kind of question is better.

**The loop actually closes.** Feedback feeds a ranker that learns which capability answers which slot — scored on what the caller *kept*, not on what returned rows — and explores with Thompson sampling so a source that lost one coin flip still gets tried again. Plan shapes that keep working are distilled into recipe proposals, replayed offline against the receipts they came from and checked for read-only safety, then held for human approval; nothing is published automatically. `knode-os learning` prints all of it, and `wiki/learning/` keeps it reviewable.

**Agent writes are quarantined.** Anything an agent commits is indexed, searchable and attributable, but cannot silently become the knowledge base's position: where it disagrees with a trusted claim, a dispute is opened rather than the claim overwritten. Promote it with `knode_trust` once a person has looked. Empty lookups are recorded as negative knowledge with an expiry, so the same fruitless query is not re-run every session — and starts being tried again once the window closes.

Typical loop: your agent searches before re-deriving project knowledge, writes new conclusions to `wiki/concepts/…` via `knode_write`, and the next session finds them.

## Web UI

`knode-os serve` → http://127.0.0.1:9100

- **Files** — browse the tree, edit markdown with preview, upload text/PDF/images to `raw/docs` (auto-converts and ingests)
- **Search** — hybrid/vector/keyword plus SAG query-time multi-hop retrieval with score and path breakdown
- **Ask** — cited Q&A with gap analysis
- **Graph** — force-directed graph explorer + insights (hubs / isolated / types)
- **Traces** — collected agent sessions
- **Dream** — run dreams, review and accept/reject suggestions
- **Settings** — embedding plus independently routed entity/concept/document-vision models; saving re-embeds or refreshes conversions when needed

## REST API (localhost)

`GET /api/health · /api/config · /api/stats · /api/tree · /api/file · /api/search[?as_of] · /api/grep · /api/graph[?as_of&valid_at] · /api/graph/insights · /api/entities · /api/documents · /api/datasources · /api/okf/validate · /api/traces · /api/suggestions · /api/lineage?kind&id · /api/history?path`
`PUT /api/config` · `PUT /api/file` · `DELETE /api/file` (disposes the source) · `POST /api/config/test | /api/upload | /api/ingest | /api/sync | /api/forget | /api/purge | /api/rebuild | /api/ask | /api/pack | /api/mv | /api/mkdir | /api/datasources/sync | /api/datasources/:id/query | /api/traces/sync | /api/dream | /api/wiki/generate | /api/suggestions/:id/status`

Workspace-scoped data APIs require `X-Knode-User`, `X-Knode-Workspace-Kind` (`personal` or `team`), `X-Knode-Workspace-ID`, and `X-Knode-Workspace-Name`. `GET/POST /api/workspaces` require only `X-Knode-User`; `DELETE /api/workspace` completely clears the selected workspace.

## Development

```bash
pnpm dev -- serve --data ./.dev-data   # tsx, no build
pnpm typecheck && pnpm test            # tsc + vitest
```

## Security notes

The server binds to `127.0.0.1` and still uses mock browser authentication — the workspace headers provide storage routing, not trusted authorization. Don't expose it. API keys can be referenced as `env:VAR` so the config file stays secret-free. File APIs are confined to the selected workspace directory (path-traversal guarded); write/move/delete operations — both HTTP and MCP — are restricted to `wiki/`, `raw/docs/` and `packs/`. Native SQL against configured datasources passes a read-only guard (single statement, SELECT/SHOW/DESCRIBE/EXPLAIN only, banned-keyword scan, row caps); still, point knode-os at read-only database credentials.

## License

MIT
