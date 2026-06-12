# knode-os

> Local-first knowledge OS for coding agents — an auto-built **wiki** + **knowledge graph** + **vector recall** over your documents, your agents' traces, and the skills they use. One process, one folder, embedded Postgres.

[简体中文](./README.zh-CN.md) · [Design overview](./docs/design/00-overview.md)

knode-os combines two ideas — [llm_wiki](https://github.com/nashsu/llm_wiki)'s "the LLM maintains a persistent, interlinked wiki instead of doing RAG from scratch every time" and [gbrain](https://github.com/garrytan/gbrain)'s "markdown is the system of record, Postgres is a disposable derived index" — and points them at what coding agents leave behind: docs, session traces, and skills.

## Highlights

- **One command**: `knode-os serve` starts the web UI, the REST API, a file watcher, periodic trace sync, and the nightly dream.
- **Your filesystem is the database.** A plain data directory (`raw/` + `wiki/`) you can read, edit, grep, and `git init`. The embedded [PGlite](https://pglite.dev) (Postgres + pgvector, WASM) index under `.knode/` is rebuildable at any time with `knode-os ingest`.
- **Agent traces, collected automatically.** Claude Code (`~/.claude/projects`) and Codex CLI (`~/.codex/sessions`) session transcripts are mirrored into `raw/traces/`; used skills into `raw/skills/`.
- **Hybrid retrieval**: pgvector cosine recall + Postgres full-text + knowledge-graph signals, fused with RRF. Works offline out of the box (built-in hashing embedder); plug in any OpenAI-compatible embedding endpoint for production quality.
- **Knowledge graph**: deterministic `[[wikilink]]` wiring on every ingest (no LLM needed) plus optional LLM entity/relation extraction. Multi-hop graph search and graph insights (hubs, isolated nodes).
- **`/dream`**: every night (or on demand) it digests recent agent sessions — what was asked, which tools failed, what repeats — and proposes improvements to your **skills**, **memory**, and **knowledge base**, queued for one-click accept/reject.
- **MCP server** so Claude Code / Codex (CLI or app) can search, ask, read, and write the knowledge base directly.
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
├── raw/
│   ├── docs/           # your uploads
│   ├── traces/         # claude/ + codex/ session transcripts (auto-synced)
│   └── skills/         # skills & prompts your agents used (auto-synced)
├── wiki/
│   ├── index.md  overview.md  log.md
│   ├── entities/  concepts/  sources/  dreams/
└── .knode/             # derived PGlite index — safe to delete & reindex
```

### Configure models

Edit `<data>/knode.config.json`:

```jsonc
{
  "embedding": {
    "provider": "openai",            // "local" = offline hashing embedder (default)
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "env:OPENAI_API_KEY",  // or a literal key
    "model": "text-embedding-3-small",
    "dimensions": 1536
  },
  "llm": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "env:OPENAI_API_KEY",
    "model": "gpt-4.1-mini"          // empty = LLM features off, heuristics used
  },
  "dream": { "schedule": "03:00", "lookbackDays": 7 }
}
```

Any OpenAI-compatible endpoint works (Ollama, vLLM, SiliconFlow, …). Changing `dimensions` drops and rebuilds the embedding table on next start.

The LLM unlocks: entity/relation extraction into the graph, `ask` answers, `wiki generate` source summaries, and LLM-grade dream analysis. Without it, everything still runs on deterministic/heuristic paths.

## CLI

```
knode-os init                 create the data directory layout + database
knode-os serve [-p port]      web UI + API + watcher + trace sync + nightly dream
knode-os ingest [--no-llm]    incremental chunk → embed → graph (sha256-diffed)
knode-os search <q> [-m hybrid|vector|keyword] [-k n] [--json]
knode-os ask <question>       cited answer + gaps (needs llm.model)
knode-os graph [q] [--depth n] [--insights] [--json]
knode-os wiki generate        source summary pages + entity stubs
knode-os trace sync           pull new Claude Code / Codex traces + skills
knode-os dream [--lookback d] analyze traces → skills/memory/knowledge suggestions
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

MCP tools exposed: `knode_search`, `knode_graph_search`, `knode_ask`, `knode_ls`, `knode_read`, `knode_write` (wiki/ and raw/docs only), `knode_ingest`, `knode_graph_insights`, `knode_suggestions`.

Typical loop: your agent searches before re-deriving project knowledge, writes new conclusions to `wiki/concepts/…` via `knode_write`, and the next session finds them.

## Web UI

`knode-os serve` → http://127.0.0.1:9100

- **Files** — browse the tree, edit markdown with preview, upload to `raw/docs` (auto-ingests)
- **Search** — hybrid/vector/keyword with score breakdown
- **Ask** — cited Q&A with gap analysis
- **Graph** — force-directed graph explorer + insights (hubs / isolated / types)
- **Traces** — collected agent sessions
- **Dream** — run dreams, review and accept/reject suggestions

## REST API (localhost)

`GET /api/stats · /api/tree · /api/file · /api/search · /api/graph · /api/graph/insights · /api/entities · /api/documents · /api/traces · /api/suggestions`
`PUT /api/file` · `DELETE /api/file` · `POST /api/upload | /api/ingest | /api/ask | /api/mv | /api/mkdir | /api/traces/sync | /api/dream | /api/wiki/generate | /api/suggestions/:id/status`

## Development

```bash
pnpm dev -- serve --data ./.dev-data   # tsx, no build
pnpm typecheck && pnpm test            # tsc + vitest
```

## Security notes

The server binds to `127.0.0.1` and has no auth — don't expose it. API keys can be referenced as `env:VAR` so the config file stays secret-free. File APIs are confined to the data directory (path-traversal guarded); MCP writes are restricted to `wiki/` and `raw/docs/`.

## License

MIT
