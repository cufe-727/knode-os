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
│   ├── mentions/  timelines/  disagreements/   pages across documents
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
2. **keyword** — BM25 over the chunks holding the query's terms: its words and
   CJK bigrams, without stopwords, each weighted by how rare it is in the corpus.
   Candidates are the chunks Postgres `tsvector`('simple') finds holding every
   word, and the chunks of the rarest terms, looked up through a GIN index over
   the n-grams of the text (`match_grams`, `src/store/grams.ts`) that also serves
   the entity name matching of the graph and SAG routes. A quoted phrase or an
   excluded word keeps what full-text search matched in front.
3. **graph** — chunks mentioning the entities the query names (live at `as_of`
   when one is given): runs of its words or CJK characters that are an entity's
   spelling, looked up by the normalized keys entity resolution keeps
   (`entity_alias_keys`), whole words only, the longer spelling winning where
   two overlap. One row per chunk, ranked by the summed rarity (BM25 IDF over
   the chunks each entity is mentioned in) of the named entities it mentions,
   then by how many. A query that names none falls back to the entities whose
   name or alias holds one of its terms, through the same gram index.
4. **sag** — opt-in query-time event retrieval. A chunk is the phase-one event
   unit and `entity_mentions` is the event/entity join. Direct hits seed up to
   two `chunk → entity → chunk` rounds; rare/shared entities score the structural
   pool, embeddings coarse-rank it, and RRF merges it with a reserved direct route.
5. Hybrid signals are fused with reciprocal-rank fusion (RRF, k=60; graph weighted 0.2:
   alone it puts about half the benchmark's gold documents in its top five, where
   vectors and keywords put about four in five, so it lifts the chunks about the
   entity a question names over chunks that only resemble the question, and a
   heavier weight starts to outvote them where one statute is in fifty chunks;
   the measurements are in `FUSION_WEIGHTS`, `src/search/search.ts`).
6. `graph search` does seeded BFS over persistent `relations` with per-hop decay 0.5;
   `co_occurs` edges are derived from shared chunk mentions at query time (never
   stored, see `src/graph/cooccur.ts`) and discounted ×0.5.
7. `ask` defaults to hybrid + graph retrieval; `--mode sag` swaps in the SAG
   route without changing existing defaults. SAG results expose hop count,
   seed chunk, bridge entities, and direct/SAG/both provenance.
8. Beside the chunks, `ask` lists up to 24 known facts (`src/search/facts.ts`):
   the claims about the entities the question names, as subject or object, and
   about the entities the retrieved chunks mention — ranked by the question's
   terms and its embedding, taken a few per source so a list question reaches
   many documents, each with its date and source and a reference number the
   answer cites like a chunk's. `knode_resolve` picks its claims the same way.
   A question that asks for every case — which…s, list/every, how many, what
   the documents say about, disagreements, timelines; 哪些, 列出, 全部, 一共有几条,
   都说了些什么, 矛盾, 从早到晚 (`isListQuestion`) — gets two more things in the
   same single call. Its facts also draw on the named entities' relations, read
   as facts with their source, and on the claims about the entities one relation
   away and about the named entities' variants ("Gemini-3 Pro" for "Gemini").
   And it gets excerpts (`src/search/excerpts.ts`): the lines of further
   documents that hold what the question names, found through the chunk gram
   index. These are the named entities' names; or the quoted term inside the
   named entities' documents ("《公司法》哪些条文提到了“注册资本”"); or, when
   nothing is named, the question's rarest word. A list item is shown with the
   line introducing it, and a paragraph with the opening line of its article
   (第X条, Article N), also when that line ended the chunk before. Documents take
   turns, up to 6,000 characters. On the benchmark's corpus-level questions,
   the share of gold evidence quotes in the prompt went from 0.567 to 0.861
   (law-cn) and from 0.356 to 0.834 (research-ai). Over those questions the
   prompt grew by 2,000–4,400 characters and ask took 20–30 ms longer.
   Single-fact and multi-hop questions did not lose. What a bounded prompt still
   cannot hold is an exhaustive list longer than the excerpt budget, and a fact
   no document's wording names: a count over every article, a finance topic
   spread over papers that never say "finance". Those need an agent with search,
   or a page computed ahead of time.

   Nearest claims by embedding over all of `claim_embeddings` added 0.009 of
   research-ai's evidence and cost law-cn 0.007. That is a sequential scan
   (22–64 ms on 1–2k claims; linear in a workspace of hundreds of thousands),
   and it is left out. Should it be wanted, it needs an HNSW index like
   `embeddings_hnsw_idx`: `CREATE INDEX claim_embeddings_hnsw_idx ON
   claim_embeddings USING hnsw (embedding vector_cosine_ops)`, under the same
   `HNSW_MAX_DIM` guard, with the model filter applied after the index scan.

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
generate` fills gaps by hand) and entity pages (no model), as materialized
views with declared inputs. Below the model's summary, cached by the
document's content, a summary page lists the document's own claims from the
database (up to 30, those with figures and dates first, each with its date and
tagged when it is a view or a forecast): the figures, dates and article numbers
a 400-word summary drops, re-rendered without a model whenever the claims change
([14 §6](14-summary-pages-worth-their-cost.md)). An entity page lists everything the knowledge
base holds about its entity, each line with the document it comes from:
standing facts, views and forecasts, a dated timeline, disagreements, what
claims about other entities say of it, and its relations (up to 300 claims;
past that it says how many there are). The pass writes one for each entity
it touched that claims from two or more documents now speak of; `wiki
generate` writes them for the best documented entities first (one page per
four documents a call, 30 to 300) and keeps `wiki/entities/index.md`, which
lists every entity page with what it is and how much it holds. Pages regenerate when
the entities/claims/documents they depend on change, and are archived when a
required input is disposed. Human prose outside the managed regions survives
regeneration and is itself a source.

### Pages across documents

A corpus-level question — which papers use Gemini, which articles name 国务院,
the laws in the order they were last amended, which sources disagree — has
its answer on a dozen entity pages, or on none: a paper that evaluates
"Gemini-3 Pro" in passing gets no claim about Gemini. Three kinds of page,
none written by a model, gather such answers (`src/wiki/corpus-views.ts`,
created and refreshed by `src/wiki/corpus.ts`). Each line names its source,
as on an entity page:

- `wiki/mentions/<entity>.md`: every source document that names an entity or
  a name that extends it ("Gemini 1.5", "Qwen3", "Llama3.2": Latin names
  only, since a CJK name that begins with another is usually something else).
  Each document's line gives the names it uses and how often, the article or
  section numbers they appear in (第二十五条, Article 12), and a passage of
  about 240 bytes. The text is searched through the chunk gram index, with a
  Latin name matched as a whole word and the longer name counted first. The
  families the graph's mentions put in the most documents get pages, at least
  three documents each, as many as entity pages get (one per four documents,
  30 to 300). A variant goes under its root. A family named in more than
  half of a corpus of twenty documents or more gets no page: 中华人民共和国 in
  every chapter of a statute, or an alias such as 本法, lists what the sources
  index lists already. A page lists at most 100 documents, the ones that use
  the names most.
- `wiki/timelines/<period>.md`: every dated claim of every entity (its event,
  else the start of its window), in order. The period is the coarsest that
  holds at most 400 claims: `all` while everything fits, else a decade
  (`2020s`), else a year, else a month. A month past 400 lists the oldest
  400 and says how many more there are. A page per year gave law-cn sixteen
  pages of one to three claims.
- `wiki/disagreements/<n>.md`: two claims the Judge found in conflict
  (`claim_pair_verdicts`, with its reason) and claims extracted as disputed,
  by subject, 200 to a page. The claim audit's other findings (similar
  wordings from two sources, expired facts) stay in the suggestions queue:
  they are leads to check, 207 and 1,710 of them on two benchmark builds,
  not statements that two sources disagree.

Each directory's `index.md` lists its pages in a managed region (OKF allows
frontmatter only on the root index). `wiki generate` writes them all. The
background document pass writes them for what it has just written: the
families its entities belong to (up to 30 new pages a pass), the periods its
dated claims fall in, and the disagreement pages when one of its claims is in
a conflict or disputed. Between passes they are views like any other page:
an entity, claim or document they list changing makes them dirty. What their
deps cannot show (a new document naming the family, a new dated claim, a new
verdict) waits for the next pass.

Measured with `listcov.ts` (the model-free benchmark harness), which counts
the share of a list task's gold items that one page holds. An item counts
when a line names it, or cites its document if no other item shares that
document, and the line, a heading above it or the page's title names what
the question asks about. Before → after, on one page / on the best three:

| pack | tasks | before | after | pages, bytes added |
| --- | --- | --- | --- | --- |
| research-ai | 13 aggregate | 0.438 / 0.682 | 0.771 / 0.869 | 34 pages, 158 KB (wiki 507 → 665 KB) |
| research-ai | 12 profile | 0.205 / 0.348 | 0.594 / 0.688 | |
| law-cn | 26 articles naming a term | 0.334 / 0.401 | 0.419 / 0.514 | 20 pages, 110 KB (wiki 559 → 669 KB) |
| law-cn | 10 article counts | 0.293 / 0.336 | 0.425 / 0.482 | |
| law-cn | 1 timeline (laws by last amendment) | 0.429 / 0.714 | 0.857 / 1.000 | |
| synthetic-life-zh | no list tasks | | | 17 pages, 68 KB (wiki 53 → 121 KB) |

What these pages leave unanswered:

- Questions about a word the graph has no entity for. law-cn's "which
  articles of 公司法 mention 注册资本" asks about about 30 terms, and 28 of
  them are no entity. research-ai's GitHub, ablation, hallucination,
  multi-agent and finance are no entity either. A term index would have to
  choose its vocabulary. Mining one from n-grams without a model gives mostly
  function words (应当, 依照本法), and a list of each term's articles comes to
  about 80 KB per statute for the 300 most frequent terms, more than the
  statute itself. These are full-text questions: ask's excerpts answer them
  at question time (docs above), and an agent greps.
- Disagreements the Judge has not judged. law-cn's 核准 versus 注册 (公司法
  2018 against 证券法 2019) is in no verdict, and finding it takes a model.

## Navigation

The wiki is navigable from `wiki/index.md` at any size, without a model
(`src/wiki/nav-views.ts`, `navigation.ts`). Its `contents` region links the
overview, every index with its counts and the 20 entity pages the most
documents speak of. `wiki/sources/index.md` lists every document, and
`wiki/entities/index.md` every entity page; a list longer than 200 rows is
cut into pages of 200, by folder (`sources/by-folder/<folder>/[<n>/]index.md`,
in the order documents were dated or, undated, added, so an arrival rewrites
only its folder's last page) and by type (`entities/by-type/<type>/…`, the
best documented first). Every other wiki folder (concepts, dreams, datasets,
research) gets the same list in its own `index.md`. A hub links every page
of its list while there are at most 400, so 80,000 documents or entity pages
stay three links from the front page; past that it links each folder's list,
one step more. No index file holds more than 200 rows or 400 links. The
smallest folders past 200 share one `_other` list. The pages are reserved
`index.md` region views: OKF allows no frontmatter there, and the lint and
the evaluation count no index as knowledge.

Measured with `~/knode-eval/bench/reach.ts` on the five pilot packs, every
page is reachable from `index.md` within three links (before: 1–20 entity
pages and `datasets/index.md` were linked from nowhere); with
`navscale.ts` at the real workspace's size — 26,878 documents, 17,250
summary pages, 3,000 entity pages — all of them are linked within three
steps, from 174 index files of at most 28.7 KB (the old single list: 2,000
rows, about 400 KB, the rest unlisted). The first build took 36 s (each file
is indexed and embedded like any wiki page), a new document 0.8 s and five
files, a refresh with nothing changed 10 ms.

`wiki/overview.md` keeps initialization's prose (07) and gains a generated
region, `holdings`: what the base holds — documents by kind, folder and
date, entities by type and the ones the most documents speak of (linked),
claims by kind and status, relations, where the indexes are — counted by
`surveyHoldings`, the part of `knode_survey` without the graph-health
queries. `isSeedTemplate` ignores managed regions, so an overview nobody
initialized still reads as the seed and the "initialize" notice stays.

New documents and summary pages are inputs no index depends on yet, so the
paths that run anyway refresh the navigation: `wiki generate`, the nightly
refine, initialization, `knode-os extract`'s document pass, and `serve`'s
follow-up review every `extraction.intervalMinutes` (also when it has
nothing to review). Each refresh first compares a few counts and skips when
none moved; otherwise it reads the rows once and writes only the pages
whose text changed. The sources lists no longer show heat: on a base nobody
reads through knode every line said `cold` (09 said the index shows heat).

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
- [14 — Summary pages worth their cost](14-summary-pages-worth-their-cost.md)
  — no page under 1,500 characters, the scaffold in the document's language,
  links only to the graph's names, long documents segment by segment; and the
  specifics a summary drops put back without a model: the document's claims
  listed below the summary, a compact figures list in the model's own output.
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
- [24 — Agent conversations: picked one by one, kept in sync, read as dialogue](24-agent-conversations.md)
  — Claude Code and Codex sessions searched by title and prompt and picked, each rendered into
  raw/docs/conversations/<project> as exchanges (prompt, replies, answers, tools used) without thinking or tool
  output, secrets redacted; imported once or followed, re-rendered once quiet; stable rendering, so a growing
  conversation pays only for its new exchanges.
- [26 — Feeds: connectors, filter and transform layers, and a protocol to push and pull](26-feeds.md)
  — one module for every source that keeps producing (Feishu groups, IMAP mail, X, arXiv, GitHub, RSS/RSSHub,
  OpenCLI sites, web pages, programs, pushes): items kept with every stage's decision in a ledger, judged as units
  (items, threads, conversation windows) by rules, plugins, programs, models or agents, rendered as stable dated
  documents; knode-feed/1 for programs as connectors, a push API and MCP tool, scheduled under `serve`.
- [22 — Research that waits out a usage limit, resumes where it stopped, and is put away](22-research-pauses-and-housekeeping.md)
  — a session refused for a spent quota, a rate limit or a lost login pauses its job (and the account's queue)
  until the reset the agent named, its attempts untouched; a restart requeues instead of failing; collect keeps
  the notes it has; finished studies are archived, failed ones removed with their jobs and logs.
- [16 — Time in the knowledge base: entries, mention timelines, measures and market data](16-time.md)
  — proposed: time belongs to entries (a post, comment or message at its
  minute, read from the export's headings); a census of mentions per entry;
  `timeline`, `feed`, `between` and `changes` reads over a `posted` window;
  shelf lives for undated claims; numbers as measures checked against the
  market; rookie-trade's prices and statements read in place, point in time,
  with instruments and market events as producer documents.
