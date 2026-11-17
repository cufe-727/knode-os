# 09 — Reworking the ingest stages: resolve right after extraction, summaries up front, pages to research

> **Record status (2026-11-17): Built, then extended.** This is a decision record, not the description of the system. What the code does now is in [ARCHITECTURE.md](../ARCHITECTURE.md) §5.2. Stale here: "five stages" (Translate is a sixth, 17); a background document pass every `intervalMinutes` (`serve` uses leased slots, 12); "the sources index still shows heat".

> Status: **implemented** (2026‑09‑30). This changes two things in [06 — Wiki research agents](06-wiki-research-agent.md) —
> when fuzzy entity resolution runs (06 · D3) and the nightly Tier‑2 concept pages — plus how Settings' Ingest
> (formerly Pipeline) tab divides the stages.

## 0. Background and decisions

The pipeline had five stages: Convert, Index, Extract, Synthesize, Summarize. The first three run per document; the
last two mixed three different kinds of work:

- **Pages across documents**: every night Synthesize wrote `wiki/concepts/<name>-cluster.md` for hot entity
  clusters — one call, ~350 words, 15 entities and five 300-character excerpts, no source citations;
- **Per-document summaries**: `wiki/sources/<name>.md`, written only when someone ran `wiki generate`, for the
  20 most recently updated documents that were not cold, with no entry point in the app;
- **Judgment**: knode_ask, Dream, the duplicate-entity review, the disputed-claim review.

Which caused four problems:

1. Fuzzy resolution waited for 03:10. For a day after ingest, the graph route of search, the claims knode_ask
   brings along and hot-cluster detection all ran on unmerged entities.
2. Two kinds of concept page coexisted: Synthesize's `-cluster.md`, and the research page
   `wiki/concepts/<name>.md` recommendations proposed for the same cluster — different paths, so the first never
   suppressed the second, and one cluster ended up with two pages.
3. Summary pages covered few documents, although they are an **input** to research agents and knode_ask; they
   came last.
4. One `summaryLlm` route served volume work (one summary per document), knode_ask (someone waits) and the
   reviews (judgment) — no single model fits all three.

Five decisions (confirmed 2026‑09‑30):

| Decision | Outcome |
| --- | --- |
| D1 Resolve earlier | The fuzzy-candidate audit and its LLM judge move from the night to **right after every extraction pass**, looking only at the entities that pass wrote (incremental); a full nightly audit stays as the backstop. Write-time resolution stays deterministic (06 · D3's reason holds) — what moves earlier is the **reversible merge**, not write-time matching |
| D2 Summaries up front | Every `raw/docs` document gets a summary page, written in the **same background pass** right after extraction and cached by content hash; no more hot/cold split |
| D3 Pages to research | Synthesize no longer writes pages: hot clusters only become `concept` research suggestions (queued automatically with `research.auto`), and existing `-cluster.md` pages are archived. Entity pages keep their zero-LLM stubs; research upgrades the ones worth writing |
| D4 Split the route | `extraction.conceptLlm` is removed; `summaryLlm` only writes document summaries; a new `extraction.judgeLlm` (Judge) takes over `ctx.llm`: knode_ask, Dream, the duplicate review, the claim review. An existing config's `judgeLlm` starts as its `summaryLlm`, so those jobs keep running where they ran |
| D5 Review modes in the UI | `review.llmJudge` (off / suggest / auto) and `review.claims` (off / suggest) go on the Judge stage's form and `PUT /api/config` accepts them; the default stays `suggest`, so merges still wait for a person |

## 1. The flow now

```
a file arrives ─sync─▶ ① Convert (vision) ─▶ ② Index (embedding) ─▶ tier‑0 graph ─▶ extraction queue

background document pass runDocumentPass (serve, every extraction.intervalMinutes; `knode-os extract`; init's catch-up)
   ③ Extract: batchSize documents by priority, concurrency at a time ─▶ remember the entities written
      └▶ incremental resolve: candidates for those entities only ─▶ Judge model ─▶ merge suggestion / merge in auto (reversible)
   ④ Summarize: this pass's documents first, then documents with a missing or stale summary, at most batchSize
   └▶ zero-LLM view reconciliation

research (a few objects, picked by recommendations, 06 §5): entity pages, concept pages, comparisons, timelines…
nightly (dream.schedule: Dream at 03:00, Tier‑2 at 03:10 by default):
   claim audit → full resolve backstop → claim review → archive old cluster pages → hot topics → recommendations → reconcile → lint
any time: knode_ask (Judge route)
```

## 2. The five stages and their routes

| # | Stage | Config key | What it asks of a model | When it runs |
| --- | --- | --- | --- | --- |
| 1 | Convert | `extraction.documentLlm` | Vision | on sync |
| 2 | Index | `embeddingUse` | Embedding | on sync |
| 3 | Extract | `extraction.entityLlm` | Volume: fast, cheap, clean JSON | background document pass |
| 4 | Summarize | `extraction.summaryLlm` | Prose: one call per document, read by people | background document pass, after Extract |
| 5 | Judge | `extraction.judgeLlm` | Quality: few calls, decisions must hold; someone waits on knode_ask | after each extraction pass, nightly, on demand |

- `ctx.llm` is the Judge route's client (`judgeLlmClient`, `src/context.ts`). The summary page generator resolves
  `summaryLlm` itself (`summaryLlmClient`). `regeneratePage` asks **the generator's own client** whether a model is
  available instead of always asking `ctx.llm` — which is why a concept page used to need both Synthesize and
  Summarize configured before it could be written.
- `ROUTE_KEYS` = `entityLlm` / `documentLlm` / `summaryLlm` / `judgeLlm`. `pinRoutes`, `renameRetiredAgents` and
  the fallback after deleting an agent walk that list, so the new route is covered everywhere.

## 3. Resolve right after extraction

`runDocumentPass` (`src/ingest/background.ts`) is the only entry to the background document pass:

1. `runTier1Pass` returns the entity ids the pass wrote (`touched`): what each document's `applyExtraction` wrote,
   including the `concept` entities minted for relation endpoints, and sidecar replays.
2. `auditDuplicateEntities(ctx, { focus: touched })`. The four signals are unchanged — same name without a
   corporate suffix 0.98, a shared alias 0.95 / 0.9, a short name that prefixes a longer one 0.85, embedding
   similarity ≥ 0.92 — but only pairs with **at least one side in focus** are kept. The embedding signal only
   embeds the focus entities (cached by `fold_sha` in `entity_embeddings`) and looks for neighbours among the vectors
   already cached.
3. The judge is `ctx.llm` (the Judge route), in `review.llmJudge`'s mode: `suggest` files merge suggestions; a pair
   judged different with confidence ≥ `llmMinConfidence` is recorded as rejected and never proposed again; `auto`
   calls `applyMerge` when a pair is judged the same with confidence ≥ `autoMergeMinConfidence` (0.95). At most
   `review.maxJudgedPerRun` pairs are judged per pass.
4. The nightly full audit (no focus) still runs, for what the increment cannot see: two established entities,
   pairs that only collide once aliases accumulate, a changed embedding model.

**Why this is still reversible.** Write-time resolution stays deterministic because a mention attached to the
wrong entity at write time cannot be taken back (06 · D3). This section produces `entity_link`s on a `merge`
scope, which `knode-os entities unmerge <id>` can always undo, so running it earlier does not change the risk.

**Serialized.** `runDocumentPass` runs one at a time per data dir (`runTier1Pass` keeps its own chain as well), so
serve's timer, `knode-os extract` and an initialization's catch-up never audit or summarize at the same time.

## 4. Summaries join the background pass

`ensureSourceSummaries(ctx, { limit, prefer, concurrency })` (`src/wiki/pages.ts`):

- **Candidates**: indexed source documents under `raw/docs` that have no summary page yet, or whose summary page is
  dirty (the document changed).
- **Order**: the documents this pass just extracted (`prefer`) first, then the rest by `updated_at`, newest first.
  At most `extraction.batchSize` per pass, `extraction.concurrency` at a time — Extract and Summarize share the
  "Documents per pass" and "Parallel calls" settings.
- **Page path**: a document that already has a summary page (found through its deps) keeps it; otherwise
  `wiki/sources/<title slug>.md`, with a `-<6 hex>` path-hash suffix when another document holds that path. The
  second of two documents with the same title used to never get a page.
- **Failures**: after 3 failures on the same content a document is skipped until its content changes; the record
  lives in the document's sidecar at `views/source-summary.failed.json`.
- **Cache**: the body is still cached by the document's content hash in the sidecar's `views/source-summary.md`;
  changing the summary model does not rewrite existing summaries.
- `wiki generate` and `POST /api/wiki/generate` still fill gaps by hand (the same function, 20 per call by default).
- The sources index in `wiki/sources/index.md` still shows heat; it no longer says cold documents have no page.
- Since docs/design/14: no page for a document under `extraction.summaryMinChars`, the scaffold in the document's
  language, links held to the graph's names, and long documents summarized segment by segment.

## 5. Synthesize retires

- The `concept_cluster` generator is gone. `refineWiki` no longer writes `-cluster.md` pages and archives the
  live ones into `wiki/.archive/concepts/` (`retireConceptClusterPages` → `archivePage`; prose a person wrote outside
  the managed region stays with the file in the archive).
- Hot clusters are only found in `refreshRecommendations`: a community of ≥ 4 entities with no
  `wiki/concepts/<anchor>.md` → a `concept` suggestion. Accepting it, or `research.auto.enabled`, queues research,
  which writes the page per the profile with sources, validation and review (06 §5).
- Entity pages: the zero-LLM stubs (facts, timeline) are unchanged; recommendations score popular entities with no
  page or only a stub higher, and research archives the stub when it writes the real page (as 06 §5 already does).

## 6. The nightly pass

`refineWiki` now runs: claim audit (no LLM) → full resolve backstop (Judge) → claim review (Judge) → archive old
cluster pages → hot topics → recommendations. Serve then reconciles views with `llm: true` and lints, as before.
Dream is unchanged and runs on the Judge route.

## 7. Config, API and migration

```jsonc
"extraction": {
  "entityLlm":   { "use": "…" },  // ③ Extract
  "documentLlm": { "use": "…" },  // ① Convert
  "summaryLlm":  { "use": "…" },  // ④ Summarize: one page per document
  "judgeLlm":    { "use": "…" },  // ⑤ Judge: knode_ask, Dream, resolve review, claim review
  "batchSize": 8, "concurrency": 1, "intervalMinutes": 5   // shared by Extract and Summarize
},
"review": { "llmJudge": "suggest", "claims": "suggest" /* other keys unchanged */ }
```

- **Migration** (`loadConfig`; both write the file once): `migrateJudgeRoute` — with no `extraction.judgeLlm` in the
  file, copy the current `summaryLlm` (use, model, effort and speed); `dropConceptRoute` — delete
  `extraction.conceptLlm` and `extraction.tier2Model`.
- **`PUT /api/config`** accepts `extraction.judgeLlm`, `review.llmJudge` ∈ off / suggest / auto and `review.claims` ∈
  off / suggest; the other `review` keys are still file-only.
- **`POST /api/config/test`, `POST /api/config/models`**: the routes are entityLlm / documentLlm / summaryLlm / judgeLlm.
- **`GET /api/stats`**: `llmModel` reports the Judge route (`ctx.llm`).
- **CLI**: `knode-os extract` runs a whole pass (extract → incremental resolve → summaries); `knode-os ask` runs on
  the Judge route.

## 8. UI

The Ingest tab in macOS and on the web lists five stages: Convert · Vision, Index · Embedding, Extract · Volume,
Summarize · Prose, Judge · Quality.

- **Summarize**: Run with / Model / effort, with a note that it runs in Extract's pass with its documents per pass
  and parallel calls.
- **Judge**: Run with / Model / effort, plus Duplicate entities (off / suggest only / merge confident pairs) and
  Disputed claims (off / suggest only).
- **Test stages** reports five rows: 1 Convert, 2 Index, 3 Extract, 4 Summarize, 5 Judge.

## 9. Known limits

1. The incremental resolve only finds embedding neighbours among cached vectors: an entity never in any pass's
   focus and outside the nightly top 600 is not found. The nightly full audit covers it.
2. Summaries share Extract's documents per pass: a large backlog slows both; raise "Parallel calls" or "Documents
   per pass" to go faster.
3. In `suggest` mode merges still wait for a person; moving the audit earlier only surfaces suggestions sooner.
   Only `auto` merges by itself.
4. Research is the expensive way to write a concept page (several agent sessions), and `research.auto.enabled` is
   off by default, so hot clusters only produce suggestions unless a person accepts them.
5. The incremental judge re-judges a pending pair when a pass writes to one of its entities again (as the nightly
   audit treats pending suggestions), one call per pair.
