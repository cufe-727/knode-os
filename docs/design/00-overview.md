# knode-os — design overview

> Local-first knowledge OS for coding agents. One TypeScript process, one data
> directory, one embedded Postgres.

## Lineage

knode-os combines three ideas:

| source | idea we borrowed |
| --- | --- |
| [knode-os (cloud design)](../../../knode-os-bak) | `raw / wiki` knowledge filesystem, chunk/embedding schema, MCP tool surface, trace-driven optimization loop |
| [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) | wiki as the persistent product of ingestion (entities/concepts/sources pages, `purpose.md`/`schema.md`/`index.md`/`log.md` anchors), graph derived from `[[wikilinks]]`, hybrid retrieval with graph expansion |
| [garrytan/gbrain](https://github.com/garrytan/gbrain) | **markdown is the system of record, the DB is a disposable derived index** (PGlite), deterministic zero-LLM graph wiring on every write, nightly "dream cycle", CLI + MCP-first surface |

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ knode-os (single Node.js process)                          │
│                                                            │
│  CLI (commander)        HTTP (hono)         MCP (stdio)    │
│  init/serve/ingest/     /api/* + web UI     knode_search   │
│  search/ask/graph/      file CRUD, search,  knode_ask      │
│  dream/trace sync       graph, dream        knode_write …  │
│            │                  │                  │         │
│            └────────────┬─────┴──────────────────┘         │
│                         ▼                                  │
│   ingest pipeline: scan → sha256 diff → LangChain chunk    │
│       → embed (OpenAI-compatible | local hash) → pgvector  │
│       → tsvector FTS → graph wiring (wikilinks + LLM)      │
│                         │                                  │
│                 PGlite (.knode/db)                         │
│   documents · chunks · embeddings · entities · relations   │
│   entity_mentions · traces · suggestions · meta            │
└────────────────────────────────────────────────────────────┘
            ▲                                ▲
   data dir (markdown = truth)      ~/.claude/projects, ~/.codex/sessions
   raw/{docs,traces,skills} wiki/   (mirrored by trace sync)
```

## Data directory

```
<data>/
├── knode.config.json   embedding/llm/server/dream settings
├── purpose.md          what this KB is for (steers generation)
├── schema.md           wiki structure rules
├── raw/
│   ├── docs/           user uploads
│   ├── traces/         agent sessions (claude/, codex/), auto-synced
│   └── skills/         skills/prompts agents have used, auto-synced
├── wiki/               curated, interlinked knowledge
│   ├── index.md  log.md  overview.md
│   ├── entities/  concepts/  sources/  dreams/
└── .knode/             PGlite database — delete + `ingest` to rebuild
```

Everything under `.knode/` is derived. `documents.sha256` makes ingestion
incremental and idempotent.

## Retrieval

1. **vector** — pgvector cosine over configured embeddings (default: offline
   feature-hashing embedder so the system works with zero keys; configure any
   OpenAI-compatible endpoint for real quality).
2. **keyword** — Postgres `tsvector`('simple') + ILIKE fallback for CJK.
3. **graph** — chunks mentioning entities whose name/alias matches the query.
4. Fused with reciprocal-rank fusion (RRF, k=60; graph weighted 0.6).
5. `graph search` does seeded BFS over `relations` with per-hop decay 0.5 and
   `co_occurs` edges discounted ×0.5.
6. `ask` = hybrid + graph retrieval → budgeted context → cited answer with an
   explicit `gaps` list.

## Knowledge graph

Two extraction passes per document:

- **Deterministic** (always): `[[wikilinks]]` → entities + `mentions` edges;
  wiki pages under `entities|concepts/` are themselves entities (path = type,
  like gbrain schema packs); co-occurring links get weak `co_occurs` edges
  whose weight accumulates on re-mention.
- **LLM** (when `llm.model` configured): typed entities (10 types) + typed
  relations (8 types), grounded to chunks by name/alias matching.

`wiki generate` writes `wiki/sources/<slug>.md` summaries (LLM) and entity
stub pages, which the next ingest indexes — the wiki feeds the graph feeds the
wiki.

## Dream cycle

`knode-os dream` (CLI, `POST /api/dream`, or nightly at `dream.schedule` while
`serve` runs):

1. digest traces from the lookback window — user requests, per-tool call and
   error counts, error samples; parses both Claude Code transcripts and Codex
   rollouts.
2. LLM proposes 3–8 suggestions of kind `skill | memory | knowledge`
   (heuristic fallback works offline).
3. writes `wiki/dreams/YYYY-MM-DD.md` + queues rows in `suggestions` for
   accept/reject in the UI or via MCP `knode_suggestions`.

## Non-goals (v0.1)

- No auth/multi-tenancy — bind to 127.0.0.1.
- No OCR — text/markdown files only (PDF etc. registered but skipped).
- No A/B routing of optimizations — suggestions end at human review.
