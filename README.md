# knode-os

> Local-first knowledge OS for coding agents — an auto-built **wiki** + **knowledge graph** + **vector recall** over your documents, your agents' traces, and the skills they use. One process, one folder, embedded Postgres.

[简体中文](./README.zh-CN.md) · [Design overview](./docs/design/00-overview.md) · [Agent Context Database (v2)](./docs/design/05-agent-context-db.md) · [OKF compatibility](./docs/design/02-okf-compatibility.md) · [Obsidian compatibility](./docs/design/03-obsidian-vault.md)

knode-os combines two ideas — [llm_wiki](https://github.com/nashsu/llm_wiki)'s "the LLM maintains a persistent, interlinked wiki instead of doing RAG from scratch every time" and [gbrain](https://github.com/garrytan/gbrain)'s "markdown is the system of record, Postgres is a disposable derived index" — and points them at what coding agents leave behind: docs, session traces, and skills.

## Highlights

- **One command**: `knode-os serve` starts the web UI, the REST API, a file watcher, periodic trace sync, and the nightly dream.
- **Your filesystem is the database.** A plain data directory (`raw/` + `wiki/`) you can read, edit, grep, and `git init`. The embedded [PGlite](https://pglite.dev) (Postgres + pgvector, WASM) index under `.knode/` is rebuildable at any time with `knode-os ingest`.
- **Agent traces, collected automatically.** Claude Code (`~/.claude/projects`) and Codex CLI (`~/.codex/sessions`) session transcripts are mirrored into `raw/traces/`; used skills into `raw/skills/`. Traces feed the nightly dream analysis; they stay out of search until `trace.episodes` is on, which prepares each transcript as a searchable episode. Skills are searchable.
- **Hybrid retrieval**: pgvector cosine recall + Postgres full-text + knowledge-graph signals, fused with RRF, plus a mild usage-heat boost. Works offline out of the box (built-in hashing embedder); plug in any OpenAI-compatible embedding endpoint for production quality.
- **SAG multi-hop retrieval**: opt-in `chunk → entity → chunk` event expansion over the existing graph, vector coarse ranking, direct-route fallback, and an inspectable bridge-entity trace for every structural hit.
- **Tiered knowledge graph**: tier 0 wires `[[wikilinks]]` and mines NLP concepts deterministically on every ingest (no LLM); entity co-occurrence is derived from chunk mentions at query time rather than stored. Changed docs are queued for tier-1 LLM entity/relation/claim extraction, which runs in the background while `serve` is up (or via `knode-os extract`), hottest documents first; each pass then checks the entities it wrote for duplicates (a merge stays reversible) and writes the documents' summary pages. Results are persisted to per-document sidecars so a rebuild never re-pays LLM cost. Multi-hop graph search and graph insights (hubs, isolated nodes).
- **Sign-in, and access from anywhere**: accounts on the server (an administrator and the members they create), a sign-in in the web UI and the macOS app, everywhere — on the same Mac too. Other machines come in through a domain (Cloudflare Tunnel), an SSH tunnel the app keeps open itself, or an HTTPS listener on an IP address; each account may use only the API groups allowed it from outside, and selected APIs of other local services can be published under `/gw/<id>` behind the same sign-in. See [docs/remote-access.md](docs/remote-access.md).
- **Labeling as leased work, on any machine**: once an administrator starts processing (in the app, the web UI or `POST /api/labeling/start` — `serve` never starts it on its own), `serve` hands extraction segments, summary pages and the duplicate reviews' judge calls to worker slots — several agents side by side, e.g. Codex and Cursor (`extraction.workers`) — and to remote workers: `worker/knode-worker.mjs` runs Codex, Cursor, Claude Code or an OpenAI-compatible API on another machine and talks to `/remote/v1` with a per-machine token, over an SSH tunnel or public HTTPS. It reads what it may take and how the server runs each stage on each CLI from the server itself. A slow call holds up nothing, rate limits pause a backend instead of burning attempts, a lapsed lease puts its work back in line. The same API reads, searches and writes the knowledge and answers read-only SQL. See [docs/remote-labeling.md](docs/remote-labeling.md).
- **`/dream`**: every night (or on demand) it digests recent agent sessions — what was asked, which tools failed, what repeats — and proposes improvements to your **skills**, **memory**, and **knowledge base**, queued for one-click accept/reject.
- **Live data sources — one logical database.** Register MySQL, TimescaleDB, parquet/CSV directories (DuckDB, an HDFS stand-in), JSON-over-HTTP endpoints, Prometheus metrics and object stores; knode-os introspects them into the knowledge graph as capabilities (`datasource` / `dataset` entities, `appears_in` links and locators from sampled entity columns — endpoints and metrics get theirs derived from the tables and aliases already known) and generates `wiki/datasets/` pages — while the rows stay in their source systems and are fetched live. Mention a company and the graph knows *which documents*, *which tables* and *which API endpoints* can answer for it.
- **Context packs.** `knode-os pack "<utterance>"` (or the `knode_context_pack` MCP tool) matches entities in the utterance, expands the graph (doc chunks, time-bound claims flagged `STALE`/`CONFLICT`, linked live tables), executes playbook-declared probe queries against the live sources (asOf-stamped, short-TTL cached, never persisted), and returns gap analysis with ready-to-run follow-up SQL.
- **Playbooks that learn.** Context packs are driven by agent-editable `playbooks/packs/*.md` workflows. Every build is logged to `pack_events`; `knode-os pack-optimize` (also part of the nightly dream) turns failure/gap patterns into full playbook revisions — accepted suggestions are written back to `playbooks/packs/`, so the next query runs a better script.
- **MCP server** so Claude Code / Codex (CLI or app) can search, ask, read, write, grep, run native SQL against live sources, and build context packs directly.
- **Pluggable models, storage and stages.** A plugin module (`plugins` in `knode.config.json`) adds LLM providers, embedding providers, storage backends, document converters and user-defined hooks at every processing stage — strip boilerplate before hashing, change chunking, filter tier-0 terms, add a rule to every extraction prompt, post-process what the model returned, restyle summaries, get told when a document lands. The built-ins are registered through the same API; a `command` provider runs any executable as a model with no code at all. See [docs/plugins.md](docs/plugins.md).
- **Native Google OKF v0.2 compatibility**: `wiki/` is itself a portable Open Knowledge Format bundle, with validation, version routing, legacy migration, lossless bundle import/export, and graph wiring for ordinary OKF markdown links. The v0.2 provenance/trust/lifecycle families (`generated`, `verified`, `status`, `stale_after`) are understood, and v0.1 bundles are still read through the spec's documented fallbacks. Unknown types, extension frontmatter and broken links are consumed permissively as the specification requires.
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

# the first account — or open the web UI on this machine and create it there
node dist/cli.js user add admin --admin --data ~/knode-data
```

Install globally (`npm link` or `pnpm add -g .`) to use the `knode-os` binary directly.

### Data directory

```
<data>/
├── knode.config.json   # embedding / llm / server / dream settings
├── purpose.md          # what this knowledge base is for
├── schema.md           # wiki structure rules
├── raw/                # originals, never rewritten; the raw path is the key of every source
│   ├── docs/           # your uploads (text, PDF, images)
│   ├── traces/         # claude/ + codex/ session transcripts (auto-synced)
│   └── skills/         # skills & prompts your agents used (auto-synced)
├── .sidecar/           # derived state, one directory per source, mirroring the tree above — keep it
│   └── raw/docs/<file>/  # content.md (Markdown converted from a PDF/image), meta.json (hashes, chunk map),
│                         # tier0.json / tier1.json (extraction), usage.json (heat), views/ (cached LLM summaries)
├── wiki/                 # native OKF v0.2 bundle + Obsidian Vault
│   ├── .obsidian/        # vault settings (never overwrites existing settings)
│   ├── attachments/      # Obsidian attachments
│   ├── index.md  overview.md  log.md
│   ├── entities/  concepts/  sources/  dreams/  datasets/
├── playbooks/          # agent-editable configuration
│   ├── packs/          # context-pack playbooks (revised by the learning loop)
│   ├── concepts/       # tier-0 concept stop list (stoplist.yaml, editable) + learned frequent terms
│   ├── capabilities/   # semantic notes over live datasource capabilities
│   └── intents/        # intent specs: the slots an answer needs
├── plugins/            # optional: plugin modules named in knode.config.json (providers, converters, hooks)
├── ledger/             # events.jsonl (machine truth) + attic/ (sidecars of removed sources)
└── .knode/             # derived PGlite index — safe to delete & reindex
```

Search results cite `raw/docs/...` paths — exactly what you uploaded. Text files are indexed from `raw/` directly (no copies); a PDF or image is converted once into `.sidecar/raw/docs/<file>/content.md`, and opening such a hit in the UI or through `knode_read` shows that Markdown. Unlike `.knode/`, the `.sidecar/` tree is not disposable: it holds paid LLM extraction results and usage history, and a rebuild replays them for free.

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
  "database": {                      // where the derived index lives
    "kind": "postgres",              // default: PostgreSQL (one shared database, a schema per workspace); "pglite" = embedded, zero setup
    "host": "127.0.0.1", "port": 5432,
    "user": "", "password": "",      // password also takes "env:VAR"; empty for trust/peer auth
    "url": "",                       // or one connection string instead (postgres://…, "env:VAR" too), with "ssl": "require" and "poolSize"
    "database": "knode",             // one shared database, created on first open
    "schemaPrefix": "ws"             // one schema per workspace: <prefix>_<workspace>_<hash>
  },
  "llm": {
    "provider": "openai",            // also: "codex-cli" / "claude-cli" / "cursor-cli", "command" (any executable), or a plugin's
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "env:OPENAI_API_KEY",
    "model": "gpt-4.1-mini"          // empty = LLM features off, heuristics used
  },
  "extraction": {
    "entityLlm": { "provider": "codex-cli", "model": "" },
    "documentLlm": { "provider": "codex-cli", "model": "" }, // vision: API / Codex / Claude Code
    "summaryLlm": { "provider": "codex-cli", "model": "" },  // one summary page per document
    "judgeLlm": { "provider": "claude-cli", "model": "" }    // knode_ask, Dream, duplicate-entity and claim reviews
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
  "pack": { "maxEntities": 4, "maxDocs": 6, "maxProbes": 6, "liveTtlSeconds": 30, "staleNewsDays": 7 },
  "plugins": [                       // providers, storage backends, converters and hooks — see docs/plugins.md
    { "module": "./plugins/house-rules.mjs", "options": { "redact": ["CONFIDENTIAL"] } }
  ]
}
```

Any OpenAI-compatible endpoint works (Ollama, vLLM, SiliconFlow, …). `protocol` picks the wire: the default `auto` probes once per endpoint (tokenlessly) for a `/responses` route and prefers it — reasoning models return their thinking as a first-class output item there, while Chat Completions can only smuggle it through a non-standard `message.reasoning_content` — and falls back to `/chat/completions` when there is none. Pin it to `responses` or `chat` to skip the probe. For embeddings, `"provider": "ark-multimodal"` additionally targets Volcengine Ark's `/embeddings/multimodal` route (`doubao-embedding-vision-*`), which is not OpenAI-shaped: it returns one fused vector per request, so `baseUrl` ends at `/api/v3`, `model` is the endpoint id (`ep-…`), and `batchSize` becomes the concurrency window over single-text calls. Document vision, entity extraction, document summaries and judging (`knode_ask`, Dream, the duplicate-entity and claim reviews) each have their own route, which names a model or an agent; a route left empty is written down as the default it would have run on. Image/scanned-PDF conversion supports a vision-capable OpenAI-compatible model, Codex CLI or Claude Code CLI. Text PDFs are extracted locally without an LLM. Changing `dimensions` drops and rebuilds the embedding table on next start. Everything can also be edited from the web UI's **Settings** tab (with route tests).

**Plugins.** `provider` and `database.kind` name ids from a registry, and the built-ins are only its first entries ([docs/design/11](docs/design/11-plugins-and-udfs.md)). A module listed under `plugins` (or in `KNODE_PLUGINS`) may register an LLM provider for a vendor API knode-os does not speak, an embedding provider, a storage backend that reaches a Postgres some other way, a converter for another file type (`.docx`, `.epub`, …), and hooks at the processing stages: `source.text`, `chunk`, `tier0.concepts`, `extract.request`, `extract.result`, `summary.request`, `document.applied`. The `command` provider needs no plugin: `cliPath` names an executable that gets `{ messages, model, json, maxTokens, images }` on stdin and answers on stdout, with the connection's key in `KNODE_LLM_API_KEY`. `database.url` takes a connection string (`env:DATABASE_URL` too) with `ssl` and `poolSize`; `database.path` moves a PGlite index. `knode-os plugins` and `GET /api/config/providers` show what is registered. Walkthrough and examples: [docs/plugins.md](docs/plugins.md), [demo/plugins](demo/plugins/README.md).

The index lives in PostgreSQL by default (set `KNODE_DATABASE_KIND=pglite` before the first run, or `database.kind: "pglite"`, for the embedded zero-setup index that the test suite also uses). With `postgres` the same schema sits on the server: all workspaces share one database and are isolated by schema, each created on first open. That is worth doing once a workspace outgrows PGlite's single-process 32-bit WASM build (roughly a million chunks) or when several processes must read one index at once. Schema-level isolation is deliberate — a database would carry its own ~8 MB catalog per workspace, while folding every workspace into shared tables keyed by a workspace column would cost the vector index outright: HNSW walks a distance-ordered neighbour graph, so an equality predicate on a scalar column cannot be pushed into the walk and the planner falls back to a sequential scan. Embedding vectors are stored as `halfvec`: pgvector caps an index entry at one 8 KB page, which is 2000 dims for `vector` but 4000 for `halfvec`, so half precision is what keeps the HNSW index reachable at 1536/2048 dims — and halves the table. Switching an existing database between the two column types converts in place without re-embedding.

Further config blocks (see `knode-os config` for the full active set with defaults): `ingest` (chunk size/overlap, file watching, `linkedFolders` — the folders `knode-os folders link` mirrors under raw/docs), `extraction` (batch size and interval of the background document pass, tier-1 model, claims on/off, `workers` — the labeling slots `serve` runs per agent — and `summaryConcurrency`), `retrieval.sag` (seed/frontier/candidate limits, hop count, direct-route ratio), `heat` (usage-heat half-life, search boost weight, cold threshold), `trace` (Claude/Codex trace directories, skill dirs, sync interval), `server` (host/port, `server.mcp` — the Streamable HTTP MCP endpoint `serve` hosts at `/mcp` —, `server.remote` — the token-authenticated remote API at `/remote/v1`: `enabled`, `leaseMinutes`, `maxBodyBytes` —, `server.auth` — sign-in: `enabled`, `sessionDays`, `allowInsecureRemote` — and `server.tls` — an HTTPS listener beside the main one: `port`, `host`, `cert`, `key`), `graph.ontologyPacks` (which `playbooks/ontology/*.yaml` packs define entity and relation types; built-ins `core`, `organization` and the opt-in `finance` — markets, indices, securities, funds, sectors, themes, indicators, policies and who holds, recommends or forecasts what), `research` (which agent writes deep-research wiki pages: `agent` = a named agent from `playbooks/agents/` (Settings → Providers & Agents) — deepagents on one of the models, or a coding-agent CLI with its own path, model and effort — or, as configs written before named agents have it, `claude-cli` / `codex-cli` / `cursor-cli`, a connection id, or `default` for the section-01 connection — an OpenAI-compatible one runs the built-in agent, so no coding-agent CLI is needed; empty = not configured, `model`, `profile` = a research profile under `playbooks/research/profiles/` (reasoning effort, web search freshness, verification bar and the sub-agent roles, each with its own CLI, model, tools and prompt — built-ins `default` / `quick` / `thorough` / `native`, editable in Settings → Research), `pipeline` = `team` (plan, parallel research, synthesize, review, revise), `native` (one session with the roles as the CLI's own sub-agents) or `single`, `maxTurns`, `timeoutMs`, `concurrency`, `readDirs`, `researchers`, `reviewRounds`, `auto.enabled` / `auto.dailyJobs`), `research.init` (the initialize button always first extracts what the tier-1 queue still holds, for up to `extractionMaxMs` — edited with the Extract stage under Settings → Ingest — then queues up to `followUps` topic pages), `chat` (the agent behind Ask: `agent` — a named agent, a connection id, a CLI, or `default` for the section-01 connection, which is also the shipped value — plus `model`, `historyTurns` and `keep`; model, effort and web access come from the agent's own `playbooks/agents/<name>.yaml`, and the turn cap, timeout and tools are the same for every agent) and `review` (how much checking sits between extraction and the graph: `resolution` = `exact` | `suffix` for write-time merges, `llmJudge` = `off` | `suggest` | `auto` with `llmMinConfidence` / `autoMergeMinConfidence`, `claims` = `off` | `suggest`, `external` = `off` | `verify` | `research` for the agent's web tools). See [docs/design/06](docs/design/06-wiki-research-agent.md) and [docs/design/07](docs/design/07-init-and-chat.md).

The LLM unlocks: tier-1 entity/relation/claim extraction into the graph with a duplicate-entity review right after it, one summary page per document, `ask` answers, the nightly claim review, and LLM-grade dream analysis; concept pages come from research agents ([docs/design/09](docs/design/09-ingest-stage-rework.md)). Without it, everything still runs on deterministic/heuristic paths.

## CLI

```
knode-os init                 create the data directory layout + database
knode-os serve [-p port]      web UI + API + watcher + trace sync + background document pass
                              (extract → resolve duplicates → summarize)
                              + usage-stats flush + nightly dream & tier-2 pass
knode-os sync [--only p..] [--verify] [--no-llm] [--no-datasources] [--reapply] [--defer-embeddings]
                                      # --reapply: recompute tier-0 for unchanged documents too (chunks and vectors kept)
knode-os concepts learn [--ratio 0.02]  # learn the corpus-frequent stop terms into playbooks/concepts/frequent.yaml
                              reconcile declared sources (raw/docs, wiki, skills, datasources) with
                              the index: apply changed files as scopes, dispose removed ones (every
                              effect reverted), regenerate dependent wiki views. `ingest` is an alias.
knode-os lineage show <entity|relation|claim|page|document> <id>
                              evidence behind a graph row (source scope, extractor, time window)
knode-os history <path>       apply / dispose / purge history of a source
knode-os forget <path>        delete a source, dispose it and purge its history (irreversible)
knode-os purge [--before iso] [--archived]  erase disposed history / archived pages
knode-os rebuild [--history]  drop the index (.knode/db, or the workspace's PostgreSQL schema) and
                              reconstruct it from files + ledger
knode-os datasource list|sync             registered live tables / re-introspect schemas into the graph
knode-os datasource query <id> <sql>      read-only native SQL against a configured source
knode-os pack <utterance> [--json] [--as-of iso] [--valid-at iso]
                                          build a context pack (entities + evidence + live probes + gaps)
knode-os pack-optimize [--apply]          learn from pack_events → playbook revision suggestions
knode-os demo seed-stock                  stock-analysis demo data (see demo/stock/README.md)
knode-os extract [--batch n] [--concurrency n]  one document pass: extract a batch, resolve duplicates, summarize
knode-os remote token create --name <machine> --scope label,read,write,sql --workspace <user>/<ws>
                              per-machine tokens for the remote API (also: `remote token list | revoke`)
knode-os user add <name> [--admin] [--team t] [--remote-apis groups] [--gateway id]
                              accounts that may sign in (also: `user list | set | passwd | signout | remove | token | sessions`)
knode-os gateway add <id> <http://127.0.0.1:port/path>   publish a local service under /gw/<id> (also: `gateway list | remove`)
knode-os tls init [--host ip-or-name]   self-signed certificate for the HTTPS listener (server.tls)
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
knode-os okf validate [bundle] [--json]  validate OKF v0.2 (defaults to <data>/wiki)
knode-os okf migrate [--dry-run]         migrate a legacy wiki structure to OKF v0.2
knode-os okf import <bundle> [--name n]  losslessly import under raw/docs/okf/<name>
knode-os okf export <dir>                validate and export the native wiki bundle
knode-os folders import <folder> [--to d] [--replace]  copy a folder from this machine into raw/docs/<name>,
                              its tree intact, and index it (only text, PDF and image files travel)
knode-os folders link <folder> [--to d]   the same, remembered: `serve` watches the folder and mirrors every
                              change — adds, edits, deletions — into the index as it happens
knode-os folders list | sync [dest] | unlink <dest> [--remove-files]
knode-os wiki generate        summary pages still missing + entity stubs
knode-os wiki refine          tier-2: claim audit + full duplicate audit + claim review + hot topics + research recommendations
knode-os trace sync           pull new Claude Code / Codex traces + skills
knode-os dream [--lookback d] sync traces, then analyze → skills/memory/knowledge suggestions
knode-os mcp                  MCP server on stdio (standalone; next to a running serve use --http below)
knode-os connect claude|codex|cursor [--stdio]  register the MCP endpoint serve hosts (Streamable HTTP; --stdio for a standalone process)
knode-os research init [--now]   initialize the knowledge base: sync + extraction, then the agent writes
                              wiki/overview.md and the AGENTS.md / CLAUDE.md guide later agents read, and queues topic pages
knode-os research queue <kind> <target> [--now]   have the research agent write a wiki page (entity|concept|comparison|timeline|question|refresh|init)
knode-os research ask "<question>"   answer a question and file it as wiki/questions/<slug>.md
knode-os research list|show|run|cancel|retry|recommend|templates|export|reclaim
knode-os research profiles | profile <name> [--use]   research profiles: effort, web search, verification, sub-agent roles and prompts
knode-os chat "<message>" [-c <conversation>]   talk to the configured CLI about the knowledge base (it answers over MCP
                              and writes what you teach it as a quarantined note); `chat list` shows recent conversations
knode-os entities merge|unmerge|merges|dedupe|resolve   entity resolution: reversible merges and the duplicate audit
knode-os entities relink       recompute every document's tier-0 links after a stop-list edit or a surface-rule change
knode-os review entities|claims   the review passes (LLM judge over duplicate candidates; verdicts on disputed / suspected claims)
knode-os wiki lint             orphans, broken links, stale / unreviewed research pages, expired and superseded text
knode-os wiki prune-summaries [--dry-run] [--min-chars n]   archive the summary pages of documents under extraction.summaryMinChars
knode-os config               show active config (redacted)
knode-os plugins [--json]     the plugins this data directory loads and what they — and the built-ins — provide
```

Every command takes `--data <path>` (or set `KNODE_OS_DATA`).

## Use from Claude Code / Codex

```bash
knode-os connect claude   # registers http://127.0.0.1:9100/mcp (Streamable HTTP; bearer token in <data>/.knode/mcp-token) with claude mcp add
knode-os connect codex    # codex mcp add --url … --bearer-token-env-var KNODE_MCP_TOKEN (export the token in your shell)
knode-os connect cursor   # writes the endpoint into ~/.cursor/mcp.json
knode-os connect claude --stdio   # without a running serve: a standalone `knode-os mcp` process (opens the index itself)
```

MCP tools exposed: `knode_resolve` (the one to call first — see below), `knode_plan`, `knode_feedback`, `knode_capabilities`, `knode_checkout` / `knode_commit` / `knode_worksets` (pin a consistent view for a long task, then write conclusions back as a source), `knode_absences` (what we looked for and did not find), `knode_disputes` / `knode_trust` (contradictions, and promoting a quarantined write), `knode_subscribe` (watch an entity, source or intent), `knode_learning` (what the planner has learned), `knode_search`, `knode_graph_search`, `knode_claims`, `knode_ask`, `knode_ls`, `knode_read` (a path starting with `/` reads the virtual filesystem; a PDF or image under raw/docs returns its derived Markdown), `knode_write` (wiki/, raw/docs and playbooks/packs/ only), `knode_grep`, `knode_ingest` / `knode_sync`, `knode_lineage`, `knode_history`, `knode_forget`, `knode_okf_validate`, `knode_graph_insights`, `knode_survey` (what this base holds, in numbers — the orientation call for an unfamiliar workspace), `knode_suggestions`, `knode_context_pack`, `knode_datasources`, `knode_query` (read-only native SQL; `source="catalog"` queries the knowledge base's own `v_*` views). The MCP server also hands every client the base's own guide (`AGENTS.md`) as its instructions. Three independent time axes: `as_of` (system time — what was believed then), `valid_at` / `valid_range` (world time — when a claim holds), and `freshness` (how old a live read may be); `kinds` / `sources` bound which sources may answer.

**`knode_resolve` instead of search.** Search returns whatever text matches. `resolve` works out what an answer to this *kind* of question needs — the slots declared in `playbooks/intents/*.yaml` — fills everything the local index can answer, and compiles what is left into a plan of tool calls the agent executes. A required slot nothing can fill comes back in `unknowns` rather than being papered over with plausible documents. Report back with `knode_feedback` and the receipt id, and the next resolve for that kind of question is better.

**The loop actually closes.** Feedback feeds a ranker that learns which capability answers which slot — scored on what the caller *kept*, not on what returned rows — and explores with Thompson sampling so a source that lost one coin flip still gets tried again. Plan shapes that keep working are distilled into recipe proposals, replayed offline against the receipts they came from and checked for read-only safety, then held for human approval; nothing is published automatically. `knode-os learning` prints all of it, and `wiki/learning/` keeps it reviewable.

**Agent writes are quarantined.** Anything an agent commits is indexed, searchable and attributable, but cannot silently become the knowledge base's position: where it disagrees with a trusted claim, a dispute is opened rather than the claim overwritten. Promote it with `knode_trust` once a person has looked. Empty lookups are recorded as negative knowledge with an expiry, so the same fruitless query is not re-run every session — and starts being tried again once the window closes.

Typical loop: your agent searches before re-deriving project knowledge, writes new conclusions to `wiki/concepts/…` via `knode_write`, and the next session finds them.

## Web UI

`knode-os serve` → http://127.0.0.1:9100 — sign in with an account of the server (the first one is created on this machine, with `knode-os user add` or on the first screen). The same UI works from other machines through a domain, an SSH tunnel or the HTTPS listener ([docs/remote-access.md](docs/remote-access.md)).

Four sections, each with its own tabs.

- **Library** — what is in the box
  - **Files** — browse the tree, edit markdown with preview, upload text/PDF/images to `raw/docs` (auto-converts and ingests; PDF and image hits open as the Markdown derived from them); **＋ add → Import / Link folder from this Mac** brings a folder in by its path with its directory structure kept — copied once, or linked so that `serve` keeps the copy in sync with the original (a linked folder shows 🔗 in the tree and is read-only there)
  - **Search** — hybrid/vector/keyword plus SAG query-time multi-hop retrieval with score and path breakdown, scopable to the folder picked in Files
  - **Traces** — collected agent sessions; a row opens its mirrored file under `raw/traces/`
- **Ask** — one question, one agent session. The configured agent answers over MCP, follows leads across turns, and writes what you teach it as a quarantined note you can adopt. With nothing named it runs on the section-01 default connection, so Ask works as soon as any model is configured; the screen says what to configure when even that is unset.
- **Knowledge** — what the system made of it
  - **Graph** — the knowledge graph the way Obsidian draws one: a force layout that settles and sleeps (the same d3-force parameters as the web graph, so both settle alike), nodes sized by their links and coloured by type, hover isolates a neighbourhood, zoom/pan/drag, labels that fade in with zoom, a legend that hides types, and a settings popover for filters, display and forces (kept across launches); an empty search is the overview, a name is the local graph around it; plus insights (hubs / isolated / types)
  - **Entities** — every entity in a table the service pages, filters and sorts: mentions, documents, relations, evidence and which extractors wrote it; a name opens its local graph, a row's wiki page opens in Files
  - **Wiki** — one button initializes the knowledge base (survey → overview page + `AGENTS.md` guide + queued topic pages), then queue and review deep-research pages
  - **Dream** — run dreams, review and accept/reject suggestions
- **Settings** — **Providers & Agents** (every model endpoint and key once, embedding and LLM in one table — `llmUse` marks which LLM is the default, and every job that names no provider of its own follows it — and the agents in a second table below: deepagents on one of those models, or a coding-agent CLI (Claude Code / Codex / Cursor) with its own path, model and effort. A CLI is an agent, not a model), **Ingest** (independently routed entity/concept/document-vision stages, each naming the model or agent it runs on — any agent is called one-shot, and a stage no longer follows the default; saving re-embeds or refreshes conversions when needed), **Research**, **Ask** (which agent answers, how many recent messages each reply replays, how many conversations are kept), **Workspace**, **Access** (your password and sessions; for an administrator, the users of the server and the gateways it publishes). The middle three follow knowledge through the workspace: processed as it comes in, researched into the wiki, used to answer. Members see settings read-only

## REST API

`GET /api/health · /api/config · /api/config/providers · /api/plugins · /api/stats · /api/tree · /api/file · /api/search[?as_of] · /api/grep · /api/graph[?as_of&valid_at&limit&types&edges] · /api/graph/insights · /api/entities[?q&type&sort&order&offset&limit&merged] · /api/documents · /api/datasources · /api/okf/validate · /api/traces · /api/suggestions · /api/lineage?kind&id · /api/history?path`
`PUT /api/config` · `PUT /api/file` · `DELETE /api/file` (disposes the source) · `POST /api/config/test | /api/upload | /api/ingest | /api/sync | /api/forget | /api/purge | /api/rebuild | /api/ask | /api/pack | /api/mv | /api/mkdir | /api/datasources/sync | /api/datasources/:id/query | /api/traces/sync | /api/dream | /api/wiki/generate | /api/suggestions/:id/status` · folders from this machine: `GET /api/folders` · `POST /api/folders/preview | /api/folders/import` (`{ source, dest?, mode: copy | link, replace? }`) `| /api/folders/sync` · `DELETE /api/folders?dest=…&removeFiles=1`

Every route needs a session — a signed-in browser's cookie, or `Authorization: Bearer knu_…` (the app's, or a script's from `knode-os user token`) — and the route's API group; sign-in itself is under `/api/auth/*` ([docs/remote-access.md](docs/remote-access.md)). Workspace-scoped data APIs also take `X-Knode-Workspace-Kind` (`personal` or `team`), `X-Knode-Workspace-ID`, and `X-Knode-Workspace-Name`; the workspace's owner is the signed-in account (`X-Knode-User` names it only with sign-in off). `DELETE /api/workspace` completely clears the selected workspace.

## Development

```bash
pnpm dev -- serve --data ./.dev-data   # tsx, no build
pnpm typecheck && pnpm test            # tsc + vitest
```

## Security notes

The server binds to `127.0.0.1` and asks every client to sign in — the browser, the app and scripts, local or not (`src/auth`): scrypt-hashed passwords, sessions stored as hashes, sign-in throttled per address and per name, CSRF-guarded browser writes. Requests from other machines must arrive over HTTPS (through a tunnel, or the `server.tls` listener) and reach only the API groups their account is allowed from outside; `/mcp` answers this machine only; `serve` refuses to listen where other machines would reach it over plain HTTP. Members never change settings, and open only their own workspaces and the Teams given them — but Ask and Research run coding agents on the server's machine, so give those only to people you trust with it. Remote labeling workers use per-machine tokens on `/remote/v1` (hashed at rest, scoped by workspace and capability, rate-limited, audited) — see [docs/remote-access.md](docs/remote-access.md) and [docs/remote-labeling.md](docs/remote-labeling.md). API keys can be referenced as `env:VAR` so the config file stays secret-free. File APIs are confined to the selected workspace directory (path-traversal guarded); write/move/delete operations — both HTTP and MCP — are restricted to `wiki/`, `raw/docs/` and `playbooks/packs/`, and never reach the system-owned `.sidecar/` tree. Native SQL against configured datasources is kept read-only by the database, not only by a text check: a guard that reads the statement by the source's own lexical rules (MySQL's for MySQL, PostgreSQL's for TimescaleDB and DuckDB) refuses early — one statement, SELECT/SHOW/DESCRIBE/EXPLAIN/WITH, no write keyword — and the connector then runs it alone, in a read-only transaction that is always rolled back, under a statement timeout, with rows capped; a DuckDB source can read only the files behind its own views. Still, point knode-os at read-only database credentials: what reaches outside the transaction (dblink, the server's files) is only as limited as the database user, and on MariaDB a single statement can lift the read-only mode for itself (`SET STATEMENT … FOR`, `BEGIN NOT ATOMIC … END`), which only the guard refuses.

## License

MIT
