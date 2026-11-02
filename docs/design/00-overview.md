# knode-os — design overview

> Local-first knowledge OS for coding agents. One TypeScript process, one data
> directory, one PostgreSQL + pgvector index (embedded PGlite as the opt-in
> alternative).
>
> **v2 direction — Agent Context Database.** Every source is a scope whose
> effects can be reverted (Cordis-style temporal composability), wiki pages are
> materialized views with declared inputs, every fact is bitemporal, and the
> next step is a Context Compiler that hands agents a ready context pack plus a
> plan for what to query next. See [05 — Agent Context Database](05-agent-context-db.md)
> ([中文](05-agent-context-db.zh-CN.md)).

## Lineage

knode-os combines three ideas:

| source | idea we borrowed |
| --- | --- |
| [knode-os (cloud design)](../../../knode-os-bak) | `raw / wiki` knowledge filesystem, chunk/embedding schema, MCP tool surface, trace-driven optimization loop |
| [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) | wiki as the persistent product of ingestion (entities/concepts/sources pages, `purpose.md`/`schema.md`/`index.md`/`log.md` anchors), graph derived from `[[wikilinks]]`, hybrid retrieval with graph expansion |
| [garrytan/gbrain](https://github.com/garrytan/gbrain) | **markdown is the system of record, the DB is a disposable derived index** (PGlite), deterministic zero-LLM graph wiring on every write, nightly "dream cycle", CLI + MCP-first surface |
| [Zleap-AI/SAG](https://github.com/Zleap-AI/SAG) | event/entity bipartite retrieval: seed events, SQL multi-hop expansion through shared entities, vector coarse ranking, and direct-route fallback |

## Architecture

```
   data dir (files = truth)   ledger/ (events,   ~/.claude/projects,
   raw/{docs,traces,skills}   attic = machine    ~/.codex/sessions
   wiki/ playbooks/           truth)             (mirrored by trace sync)
            ▼                  ▼                 ▼
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
│   sync (tier 0): prepare (raw → sidecar) → declared        │
│       vs running scopes diff → per source: chunk → embed   │
│       (reusing unchanged chunks) → pgvector + tsvector →   │
│       tier-0 graph evidence (wikilinks + NLP concepts +    │
│       frontmatter) → enqueue for tier 1; removed sources   │
│       are disposed (every effect reverted) → dependent     │
│       wiki views regenerate or archive                     │
│                         │                                  │
│   background (serve): tier-1 LLM extraction (child scopes) │
│       · usage-stats flush → sidecars · nightly dream       │
│       · tier-2 refinement · view reconciliation            │
└─────────────────────────┬──────────────────────────────────┘
                          ▼
┌────────────────────────────────────────────────────────────┐
│ index — PostgreSQL + pgvector, one schema per workspace    │
│ (opt-in: embedded PGlite in .knode/db) — rebuildable       │
│                                                            │
│   scopes · effects · evidence · deps · pages               │
│   documents · chunks · embeddings · entities · relations   │
│   entity_mentions · claims · datasets · stats · queue      │
└────────────────────────────────────────────────────────────┘
```

## Data directory

```
<data>/
├── knode.config.json   embedding/llm/server/dream settings
├── purpose.md          what this KB is for (steers generation)
├── schema.md           wiki structure rules
├── raw/                originals, never rewritten (L0); the raw path is every source's key
│   ├── docs/           user uploads (text, PDF, images)
│   ├── traces/         agent sessions (claude/, codex/), auto-synced
│   └── skills/         skills/prompts agents have used, auto-synced
├── .sidecar/           derived layer, system-managed (L1), one directory per source key
│   └── raw/docs/<f>/   content.md (Markdown converted from a PDF/image), meta.json,
│                       tier0.json / tier1.json, usage.json, views/ (cached LLM summaries)
├── wiki/               curated knowledge (L3); OKF v0.2 + Obsidian Vault
│   ├── .obsidian/      vault-local settings
│   ├── attachments/    Obsidian attachments
│   ├── index.md  log.md  overview.md
│   ├── entities/  concepts/  sources/  dreams/  datasets/
├── playbooks/          agent-editable configuration: packs/ capabilities/ intents/
├── ledger/             events.jsonl (machine truth) + attic/ (sidecars of removed sources)
└── .knode/             local state; with PGlite also the index itself (L2, db/)
```

The index (L2) is derived: by default the workspace's schema in PostgreSQL with
pgvector, or with `database.kind: "pglite"` the embedded PGlite database in
`.knode/db`; `knode-os rebuild` drops it and builds it again from the files and
the ledger. `documents.sha256` makes ingestion incremental and idempotent;
sidecars let a rebuild replay paid LLM extractions and usage history for free.
Ingest indexes `raw/docs` (text sources straight from the file, normalized in
memory; PDFs and images through the Markdown in their sidecar), `raw/skills`
and `wiki/` — traces are indexed only when `trace.episodes` is on; otherwise
they feed the dream cycle only.

## Retrieval

1. **vector** — pgvector cosine over configured embeddings (default: offline
   feature-hashing embedder so the system works with zero keys; configure any
   OpenAI-compatible endpoint for real quality).
2. **keyword** — Postgres `tsvector`('simple'), and where that finds too little
   (CJK has no word boundaries for it) a substring fallback: chunks ranked by how
   many query terms they contain, looked up through a GIN index over the n-grams
   of the text (`match_grams`, `src/store/grams.ts`) that also serves the entity
   name matching of the graph and SAG routes.
3. **graph** — chunks mentioning entities whose name/alias matches the query (live
   at `as_of` when one is given), one row per chunk, ranked by how many matching
   entities it mentions, then by their mention counts.
4. **sag** — opt-in query-time event retrieval. A chunk is the phase-one event
   unit and `entity_mentions` is the event/entity join. Direct hits seed up to
   two `chunk → entity → chunk` rounds; rare/shared entities score the structural
   pool, embeddings coarse-rank it, and RRF merges it with a reserved direct route.
5. Hybrid signals are fused with reciprocal-rank fusion (RRF, k=60; graph weighted 0.6).
6. `graph search` does seeded BFS over persistent `relations` with per-hop decay 0.5;
   `co_occurs` edges are derived from shared chunk mentions at query time (never
   stored, see `src/graph/cooccur.ts`) and discounted ×0.5.
7. `ask` defaults to hybrid + graph retrieval; `--mode sag` swaps in the SAG
   route without changing existing defaults. SAG results expose hop count,
   seed chunk, bridge entities, and direct/SAG/both provenance.

See [04 — SAG query-time event retrieval](04-sag-query-time-events.md) for the
mapping, scoring, configuration, and phase-two event model.

## Knowledge graph

Tiered extraction (details in [01](01-doc-processing-graph-wiki.md)):

- **Tier 0 — deterministic, at ingest** (always): `[[wikilinks]]` → entities +
  `mentions` edges; wiki pages under `entities|concepts/` are themselves
  entities (path = type, like gbrain schema packs); NLP concept mining
  (capitalized phrases, acronyms, CJK n-grams) → concept entities. Co-occurrence
  is not stored: graph reads derive weak `co_occurs` edges from the chunk mentions.
- **Tier 1 — LLM, asynchronous** (when `llm.model` configured): changed docs
  are queued; a background pass (while `serve` runs, or `knode-os extract`)
  drains the queue by priority (heat × freshness × root importance), one
  batch per pass, extracting typed entities (10 types), typed relations
  (7 LLM types; `co_occurs` is derived at read time) and claims, grounded to chunks by
  name/alias matching. Results persist in the document sidecar for free replay.
- **Tier 2 — nightly pass**: a zero-LLM claim audit (contradictions, expired
  facts) feeding the suggestions queue, the full duplicate-entity audit, the
  disputed-claim review and research recommendations. Hot communities became
  `concept` research suggestions instead of LLM community pages, and every
  extraction pass now reviews the entities it wrote for duplicates and writes
  its documents' summary pages ([09](09-ingest-stage-rework.md)).

The background pass writes `wiki/sources/<slug>.md` summaries (LLM; `wiki
generate` fills gaps by hand) and `wiki generate` writes entity stub pages, as
materialized views with declared inputs: they regenerate when
the entities/claims/documents they depend on change, and are archived when a
required input is disposed. Human prose outside the managed regions survives
regeneration and is itself a source.

## Dream cycle

`knode-os dream` (CLI, `POST /api/dream`, or nightly at `dream.schedule` while
`serve` runs). Every trigger path syncs traces first, then:

1. digest traces from the lookback window — user requests, per-tool call and
   error counts, error samples; parses both Claude Code transcripts and Codex
   rollouts.
2. LLM proposes 3–8 suggestions of kind `skill | memory | knowledge`
   (heuristic fallback works offline).
3. writes `wiki/dreams/YYYY-MM-DD.md` + queues rows in `suggestions` for
   accept/reject in the UI or via MCP `knode_suggestions`.

## Non-goals (v0.1)

- No auth/multi-tenancy — bind to 127.0.0.1.
- PDF/image sources are normalized to Markdown; scanned pages require a configured vision route.
- No A/B routing of optimizations — suggestions end at human review.

## Further design docs

- [01 — 文档处理系统：面向海量文本的 Graph Wiki 方案](01-doc-processing-graph-wiki.md)
  — tiered extraction pipeline (Tier 0/1/2), sidecar metadata + heat tracking,
  `raw → sidecar → wiki` directory layers, 100k–1M document scaling plan.
  The core of this design (sidecars, tiers, heat) is implemented; layout v3
  replaced the cooked copy layer with per-source sidecar directories.
- [02 — Google Open Knowledge Format (OKF) v0.2 兼容设计](02-okf-compatibility.md)
  — specification summary, native bundle mapping, validation/import/export,
  permissive consumption, and ordinary markdown-link graph wiring.
- [03 — Obsidian Vault 原生兼容设计](03-obsidian-vault.md)
  — Vault boundaries, non-destructive settings, Properties and internal-link
  compatibility, attachments, and OKF coexistence.
- [04 — SAG 查询时事件检索](04-sag-query-time-events.md)
  — maps chunks and entity mentions onto SAG's event/entity retrieval model,
  including multi-hop expansion, dual-route fusion, provenance, and next steps.
- [05 — Agent Context Database](05-agent-context-db.md) ([中文](05-agent-context-db.zh-CN.md))
- [06 — Wiki research agents and graph upgrades](06-wiki-research-agent.md) ([中文](06-wiki-research-agent.zh-CN.md))
  — the v2 redesign: Cordis-style effect ledger (scopes / evidence / deps /
  pages, dispose reverts everything a source produced), bitemporal `as_of` /
  `valid_at`, wiki pages as views, one logical multimodal database, and the
  Context Compiler roadmap (intent specs, agent-executed plans, receipts).
  All six phases are implemented: the ledger; a Temporal Resolver keeping
  system time, world time and freshness apart, with `kinds` / `sources` scoping
  on every retrieval surface, a structured `knode_claims` and read-only `v_*`
  catalog views; a Capability Graph (what can be asked of which source, how to
  bind an entity to it, and the written semantics over both) with http-json /
  prometheus / object connectors; the Context Compiler — `knode_resolve` turns
  a question into filled slots plus a plan the agent executes, and
  `knode_feedback` closes the loop into receipts; a learning loop that ranks
  capabilities by what callers actually kept and distils repeatedly-successful
  plan shapes into recipe proposals for human approval; and the agent-database
  features around them — negative knowledge with an expiry, worksets that pin a
  consistent view, quarantined agent writes that open disputes instead of
  overwriting, ACLs intersected down the derivation chain, and change
  subscriptions cursored on system time.
- [11 — Plugins: pluggable processing stages, storage and models](11-plugins-and-udfs.md) ([中文](11-plugins-and-udfs.zh-CN.md))
  — one registry for LLM / embedding providers, storage backends, document
  converters and user-defined hooks at every processing stage; the built-ins
  are registered through the same API. How-to: [docs/plugins.md](../plugins.md).
- [12 — Remote processing: embeddings, summaries and reviews on remote workers](12-remote-processing.md)
  — one lease protocol for extraction segments, summary pages and a review's
  judge calls, taken by `serve`'s own slots and by remote workers, which read
  their setup from the server; remote embedding is proposed. How-to:
  [docs/remote-labeling.md](../remote-labeling.md).
- [13 — The client contract: how other projects use knode-os, starting with rookie-trade](13-client-contract.md) ([中文](13-client-contract.zh-CN.md))
  — proposed: one contract (`contract/`, generated OpenAPI and golden schemas)
  behind `/remote/v1`, MCP and a thin Python SDK; tokens with a role and a
  trust tier; `known_at`, a fourth time axis that reads only what was available
  at a decision time; market data and a run registry read in place as
  datasources; experiments and author track records written back as sources.
- [15 — Research studies: from a topic to a set of wiki pages, with the sources kept](15-research-studies.md)
  — a topic refined into a brief the person edits, then collected (web, the
  base, MCP / API / site sources, or a deep-research model) into originals
  under raw/docs/research that the pipeline converts and indexes, written up as
  one page per part plus a report, with charts as data blocks.
- [18 — Estimates before a task starts: time, tokens, transfer, cost, and each plan's share](18-estimates.md)
  — every leased call measured (tokens from Codex, Claude Code, Cursor and endpoints, time, bytes); the processing
  and a study counted and costed before Start; Codex's windows read from Codex and calibrated on the account's
  tokens, Cursor and Claude Code against what their plans include.
- [19 — Mind maps: pictures of trees read as outlines, drawn as maps, joined to the graph](19-mind-maps.md)
  — one outline form (`type: MindMap`) for a picture, a person's outline or a reviewed transcript beside the
  picture; the image converter asks for it; chunks carry their branch's path; named nodes join the graph to the
  nearest named node above them, typed by the two types; the file view draws the tree with its entity links.
- [21 — Feishu documents: imported once or kept in sync, pictures included](21-feishu-documents.md)
  — a Docs or wiki link mirrored under raw/docs/feishu with its pictures and attachments, through lark-cli as the
  signed-in Feishu user (one device-flow authorization); linked documents polled by last-edit time, the changed
  ones re-fetched; long screenshots read in bands.
- [16 — Time in the knowledge base: entries, mention timelines, measures and market data](16-time.md)
  — proposed: time belongs to entries (a post, comment or message at its
  minute, read from the export's headings); a census of mentions per entry;
  `timeline`, `feed`, `between` and `changes` reads over a `posted` window;
  shelf lives for undated claims; numbers as measures checked against the
  market; rookie-trade's prices and statements read in place, point in time,
  with instruments and market events as producer documents.
