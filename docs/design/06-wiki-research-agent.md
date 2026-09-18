# 06 — Wiki research agents and graph upgrades: ontology / entity resolution / time / recommendations / lint

> Status: **implemented** (2026‑09‑15). The third layer on top of
> [01 — document processing](01-doc-processing-graph-wiki.md) and
> [05 — Agent Context Database](05-agent-context-db.md): how the graph gets
> curated-grade, and how the wiki is written by external coding-agent CLIs so
> it keeps getting more accurate. Chinese original: [06-wiki-research-agent.zh-CN.md](06-wiki-research-agent.zh-CN.md).

## 0. Goals and decisions

Tier‑1 extraction already produced entities / relations / claims, but entity ids were plain `slugify(name)` with no
resolution; the relation vocabulary was a hard-coded list, unknown predicates silently became `related_to`, and edges had
no world time; claims carried only `startDate/endDate` with no document reference date or event time; wiki pages were
materialized views (stubs, source summaries, community pages) — nothing "deeply researched".

| Decision | Outcome |
| --- | --- |
| D1 runner | built into knode‑os: a persistent job queue inside `serve` launches the configured agent — the user's claude / codex / cursor CLI headlessly, or the **built‑in agent** (a LangChain `deepagents` loop in the `serve` process) on an OpenAI‑compatible connection, for machines with no CLI installed; an export‑bundle → run by hand → `reclaim` mode also exists. `research.agent` names one explicitly; there is no fallback to the default LLM provider (see 2026‑09‑18) |
| D1a how the agent reaches knode | **MCP first, hosted by `serve` over Streamable HTTP** (`POST /mcp`); `raw/docs`, `wiki`, `.sidecar` mounted read‑only; **every write goes through `knode_write`**. Not "the agent shells out to the knode‑os CLI" (reopens the index per call, unstructured output, shell permissions) |
| D2 page status | an agent‑written page is a **Source**: `actor: agent/<cli>` (or `agent/deep-agents`) → quarantined; its `aliases / relations / claims` enter the graph, disputes open where it contradicts trusted facts; a person promotes it |
| D3 entity resolution | deterministic at write time (NFKC / width / corporate‑suffix folding + exact name/alias key match); fuzzy candidates go to a nightly audit → `merge` suggestions → a person → reversible link |
| D4 relation ontology | configurable packs (`playbooks/ontology/*.yaml`) with built‑in `core` and `organization` |

Why MCP over HTTP rather than another stdio process: the default PGlite index is single‑process, so a `knode-os mcp` child
would fight the running `serve` for the workspace; all three CLIs speak Streamable HTTP; and only MCP gives the agent
`as_of/valid_at`, worksets, the `knode_resolve/feedback` learning loop, and trust / ACL enforcement.

## 1. Data flow

```
raw/docs ──sync──▶ Tier0 (frontmatter entities/relations/claims → concepts/wikilinks) ──▶ ScopeWriter ──▶ evidence ──fold──▶ entities(name_key, canonical_id) / relations(valid_from/to) / claims(event_at, observed_at, superseded_by)
                    └─ Tier1 LLM (ontology-driven prompt + known-entity injection + document date) ──┘
wiki/<type>/<slug>.md ◀── research runner ◀── research_jobs ◀── recommendations (suggestions kind=wiki) / `research ask` / by hand
   │ actor: agent/<cli>, relations:, claims:, sources:, research:
   └──sync──▶ Source (quarantined) ──▶ disputes ──▶ promote (UI / knode_trust)
serve: /api/* + /mcp (Streamable HTTP, per-workspace, bearer token) ◀── claude -p / codex exec / cursor-agent -p (isolated run workspace, read-only add-dir)
nightly tier 2: community pages + claim audit (supersession) + duplicate-entity audit + recommendation refresh + wiki lint
```

## 2. Ontology, typed and time‑bound relations (`src/graph/ontology.ts`)

- Packs under `playbooks/ontology/<pack>.yaml`, merged in `graph.ontologyPacks` order (default `["core","organization"]`);
  `initDataDir` seeds the built‑ins and never overwrites edits. Relation fields: `id / inverse / symmetric / hierarchical /
  temporal / domain / range / synonyms / inverseSynonyms / description / system`.
- `normalizePredicate()`: synonym → canonical id; an inverse reading (`parent_of`, `母公司`, `buys_from`) → canonical id
  **with the edge flipped**; symmetric predicates are stored once with ordered endpoints; unknown spellings → `related_to`
  with the original kept in evidence attrs `raw_type` and counted by `knode_graph_insights.unknownPredicates`.
- The tier‑1 prompt is generated from the ontology; relations gain `validFrom/validTo`.
- `relations.valid_from / valid_to` (migration v7), folded like claim windows; `knode_graph_search`'s `valid_at /
  valid_range` now filter edges too.
- Frontmatter `relations:` in list form (`{source?, target, type, from?, to?}`) or gbrain‑style map form
  (`supplies_to: ["[[Tesla]]"]`), for `raw/docs` and bundle pages (the page's own entity is the default source).
- Known trade‑off: `relationId = sha(source|type|target)`, so one edge stated for different periods folds into the union
  window — period‑specific facts belong in claims.

## 3. Entity resolution (`src/graph/normalize.ts` / `resolve.ts` / `merge.ts` / `dedupe.ts`)

- `nameKey()` yields `key` (letters and digits after NFKC) and `bare` (corporate suffix stripped). The fold maintains
  `entities.name_key` and `entity_alias_keys` (name + aliases, both forms), including the keys of entities merged into it.
- Write time (`ScopeWriter.entity()`): explicit `sameAs` → an existing row with the same slug (following `canonical_id`) →
  any key match with a compatible type → else a new slug. A redirected mention becomes an alias, evidence records
  `resolved_from`. A scope‑local key index covers the body before the fold publishes keys; declared frontmatter facts
  are applied before concept mining.
- Extraction‑time linking: the tier‑1 prompt lists known entities present in the text; the LLM answers with `sameAs`.
- Merges: `entity_links` + `entities.canonical_id`, written by a `merge` scope as an explicit effect (inverse
  `entity_link.remove`); `applyMerge / unmergeEntity` log ledger feedback that `rebuild` replays. Reads (graph search,
  claims, context packs, vfs, entity pages) redirect to the survivor; merged entities' stubs become redirects.
- Nightly audit: same bare key / shared alias key / short name is a prefix of a longer same‑typed name / embedding
  similarity (real embedders, cached in `entity_embeddings` by fold_sha) → `merge` suggestions, never re‑proposed once
  rejected. Surfaces: `knode-os entities merge|unmerge|merges|dedupe|resolve`, `POST /api/entities/*`.

## 4. Time on claims (`src/store/dates.ts` / `src/ingest/docdate.ts`)

- `documents.doc_date` from frontmatter (`date / published / as_of / generated.at …`) or a date in the path — never the
  mtime. Stored in the sidecar meta; search results carry `docDate`.
- `normalizeDateExpr()` turns `2026-08 / 2026Q2 / 2026年第二季度 / 2026年上半年 / FY2025 / 去年 / 上季度 / 去年同期 /
  2024年以来 / 截至 2026-06-30` into precision‑aware `[from, to]` spans; relative forms resolve against the document date.
- New claim columns `event_at`, `observed_at`, `superseded_by`; prompts and frontmatter distinguish `eventDate` from
  `startDate/endDate`. Supersession marks the older of two facts of the same subject and type; `knode_claims` hides them
  unless `include_superseded`, and `order=timeline` / `event_range` build chronologies.
- Entity stubs split into `## Facts (current)` and `## Timeline`.

## 5. The research runner (`src/research/`)

- **Templates are skills**: `playbooks/research/AGENTS.md` (shared protocol) plus one template per kind (`entity /
  concept / comparison / timeline / question / refresh`) declaring `output`, `maxTurns` and `requires`.
- **Jobs**: `research_jobs` (`queued → running → validating → done|failed|cancelled`), deduplicated per kind+target.
- **Run workspace** `<data>/.runs/<jobId>/`: `CLAUDE.md` = `AGENTS.md`, `brief.md` (target, output contract, allowed
  predicates, existing page with the human paragraphs to keep, a `knode_resolve` seed, previous rejection reasons),
  `.mcp.json` / `.cursor/mcp.json`, `transcript.jsonl`, `result.json`, `validation.json`, `rejected.md`, `existing.md`.
- **Launch recipes** (`launch.ts`) for claude / codex / cursor: read‑only, MCP attached, no write or shell tools.
- **Validation** (`validate.ts`): the page exists, YAML parses, `actor` / `research` stamped by the runner, required keys
  and sections, at least one verifiable source, predicates in the ontology (warning), parsable dates, wikilinks with
  pages (warning), **human‑written paragraphs preserved** (error), OKF conformance. A rejected draft is moved aside,
  the previous page restored, and the job retried once with the reasons in its brief.
- **Success**: `sync` of that one path (a quarantined Source; disputes open automatically), workset closed,
  `wiki/index.md#recent-research` refreshed, `wiki/log.md` appended.
- Classification fix: a page with an explicit `actor` is a Source even with a `generated` key; generated stubs at the
  output path are archived first.
- Surfaces: CLI `knode-os research …`, HTTP `/api/research/*`, MCP `knode_research`, the web **Wiki** tab.
  `research run` / `--now` host a temporary single‑context `/mcp` inside the CLI process.

## 5b. The team pipeline (`src/research/pipeline.ts`, `pipeline = "team"`, default)

`single` lets one agent session do everything; `team` splits the work into CLI sessions, **each phase served by one or more roles of the profile (see 5d)**, with state carried as files in the run directory:

| Phase | Default role | Sessions | Tool scope | Output |
| --- | --- | --- | --- | --- |
| plan | planner | 1 | read-only | `plan.json`: 3–6 section sub-tasks (questions, queries, entities) |
| research | researcher | one per section, `parallel` (default `research.researchers`) at a time; several research roles take turns | read-only (enforced by claude's `--allowedTools`; by prompt elsewhere) | `findings/<n>-<section>.md`: findings, candidate claims/relations, gaps |
| synthesize | synthesizer | 1 | write (`knode_write` / `knode_commit`) | the page |
| review | critic (several allowed; all run, issues merged) | one per role per round | read-only | JSON verdict `{pass, issues, summary}`, alongside the deterministic validator |
| revise | reviser | up to `rounds` (default `research.reviewRounds`) | write | the corrected page |

Disabling a role skips its phase: no planner → the outline is the template's required sections; no researcher → the synthesizer researches itself; no critic → validator only; no reviser → no revision. Every role may name its own CLI (connection id or provider), model, reasoning effort, tool scope (write pages / read files / web) and prompt file; the prompt defaults to `playbooks/research/phases/<phase>.md`, a prompt edited in Settings is written to `playbooks/research/roles/<id>.md`, and the harness prepends the `<!-- knode-phase: … -->` marker. `phases.json` records role, CLI, turns, cost and errors per session and lands in the job payload.

The third mode, `native`, runs one orchestrator session that writes the page and registers the roles marked `native` as the CLI's own sub-agents — claude through `--agents <json>` (description / prompt / tools / model, with the `Agent` tool allowed), codex through `agents.enabled=true` plus one `agents.<id>.config_file` TOML layer per role (`model` / `model_reasoning_effort` / `web_search` / `developer_instructions`, written to `agents/<id>.toml` in the run directory). cursor-agent has no sub-agent definitions and falls back to a single session. The orchestrator prompt is `playbooks/research/phases/orchestrate.md`; sub-agents never get `knode_write`.

## 5c. The three review layers (`review` config block)

| Layer | Config | Behaviour |
| --- | --- | --- |
| write-time resolution | `review.resolution: exact` (default) / `suffix` | `exact` merges a mention only when its spelling equals a known name or alias; `suffix` also merges names differing only by a corporate suffix. `entity_alias_keys.kind` tells exact from bare keys (migration v8) |
| LLM judge | `review.llmJudge: off / suggest (default) / auto`, `llmMinConfidence`, `autoMergeMinConfidence`, `maxJudgedPerRun` | the nightly audit shows each candidate pair (descriptions + excerpts) to the LLM; `suggest` annotates the suggestion; a confident "different" is recorded as rejected (actor `llm-judge`) and never re-proposed; `auto` calls `applyMerge` (reversible) above `autoMergeMinConfidence` |
| claim review | `review.claims: off / suggest (default)` | open disputes and `suspected` claims get a verdict (a / b / both / neither / unclear) and a recommended action, filed as `knowledge` suggestions |
| external verification | `review.external: off / verify (default) / research` | the master switch for web tools: `off` never; `verify` only for `verify` jobs (template `verify.md`, output `wiki/reviews/`), unless the profile or a role says `web: on`, which widens it to every job; `research` always, though a profile or role may still switch it off. claude keeps WebSearch/WebFetch, codex gets `web_search = live | cached` (freshness from the profile), cursor is told in the prompt; the page's `sameAs` becomes a merge suggestion, `notSameAs` a remembered rejection |

`knode-os review entities|claims`, `POST /api/review/claims` and `POST /api/entities/dedupe` run the passes on demand; the nightly tier 2 runs claim audit → duplicate audit (with the judge) → claim review → recommendations → lint.

## 5d. Research profiles (`src/research/profile.ts`, `playbooks/research/profiles/<name>.yaml`, `research.profile`)

A profile lifts *how* to research out of the harness: one YAML answers how hard to think, whether to go online, how hard a fact must be, when to stop, what the page looks like, and which sub-agents exist. `research.profile` selects it; a missing file falls back to the built-in `default`.

| Block | Keys | Effect |
| --- | --- | --- |
| `reasoning` | `effort: default / low / medium / high / xhigh / max` | reasoning effort of every session; a role may override it (`default` = leave the CLI's own setting) |
| `search` | `web: inherit / on / off`; `freshness: live / cached`; `maxRounds` | web access (only widened or narrowed within what `review.external` allows, see 5c), codex search freshness, search rounds per section (in the brief) |
| `verification` | `minSourcesPerClaim`; `preferPrimarySources`; `resolveConflicts: flag / prefer_primary / prefer_recent` | in the brief; with `minSourcesPerClaim ≥ 2` the validator requires each `fact` to carry its own `sources: [...]` (`suspected` only warns) |
| `stop` | `maxSections`; `marginalGain` | outline cap (enforced in code); "stop a section when a search round adds nothing new" (in the brief) |
| `output` | `citations`; `uncertainty`; `evidenceTable` | in the brief; `evidenceTable` makes `## 证据表` a required section (validator and outline) |
| `pipeline` | `'' / single / team / native` | empty = follow `research.pipeline` |
| `roles[]` | `id, title, phase, enabled, agent, model, effort, tools{write, files, web}, parallel, rounds, maxTurns, prompt, native, description` | the sub-agents (see 5b); empty `agent` = `research.agent`, empty `prompt` = `phases/<phase>.md`. The built-in agent supports `native` roles too — they become deepagents sub-agents |

Four built-ins (deleting one resets it): `default` (team; effort and web follow the CLI and review defaults), `quick` (single session, medium, cached, at most 4 sections), `thorough` (max, 5 parallel researchers, 2 review rounds, 2 sources per fact, evidence table), `native` (native sub-agents, high). The brief gains a "研究规范 (profile: …)" block that states these as rules the agent reads.

Per-CLI adapters live in `sessionArgs` (`src/research/launch.ts`; `research export` prints the same command lines):

| | claude | codex | cursor-agent |
| --- | --- | --- | --- |
| reasoning effort | `--effort <level>` | `-c model_reasoning_effort="…"` (`max` → `xhigh`) | bracket syntax on the model name, `model[effort=high]` (`xhigh`/`max` → `high`; impossible without a model) |
| web | `WebSearch` / `WebFetch` in `--allowedTools` or `--disallowedTools` | `-c web_search="live" | "cached" | "disabled"` (no longer `tools.web_search`) | prompt only |
| files | `Read` / `Grep` / `Glob` allowed or disallowed | read-only sandbox, always readable | `--add-dir`, always readable |
| native sub-agents | `--agents <json>`, `Agent` / `Task` allowed | `agents.enabled`, `agents.max_concurrent_threads_per_session`, `agents.default_subagent_reasoning_effort`, `agents.<id>.description`, `agents.<id>.config_file` | unsupported (single session) |

Entry points: the Settings page, section "03 · Deep research" — pick the CLI that runs jobs, concurrency and timeout, the profile; edit the profile's effort / web / verification / stop / output and every role's CLI, model, effort, tools and prompt (duplicate as a new profile, reset a built-in); `GET /api/research/profiles`, `GET/PUT/DELETE /api/research/profiles/:name` (PUT with `prompts: {roleId: text}` writes changed prompts to files, `activate: true` also selects it); the `research` block of `PUT /api/config` (agent / model / profile / pipeline / concurrency / rounds / timeout / auto); `knode-os research profiles` and `knode-os research profile <name> [--use]`.

## 6. Recommendations (`src/research/recommend.ts`)

Signals: mentions + retrieval heat, 30‑day demand from `receipts.entities`, degree, open disputes, expired / superseded
facts; page state (none, stub, research page older than the newest evidence → **refresh**); hot communities without a
concept page; recurring `receipts.query` clusters → question pages. Filed as `wiki` suggestions whose acceptance queues
the job; `research.auto` accepts the top few per day. Human‑written pages are never recommended for refresh.

## 7. wiki lint (`src/wiki/lint.ts`)

Zero LLM: orphans, broken wikilinks, stale / unreviewed research pages, expired `stale_after`, superseded statements
still in a page, pages in open disputes. Report page `wiki/lint/<date>.md`; nightly after tier 2; `knode-os wiki lint`,
`POST /api/wiki/lint`.

## 8. Config and migration

`database.kind` now defaults to `postgres` (`pglite` stays an explicit option; the test suite sets `KNODE_DATABASE_KIND=pglite`), and an unreachable server is a clear error rather than a silent fallback. `server.mcp`, `research { agent, model, profile, pipeline: single | team | native, maxTurns, timeoutMs, concurrency, runsDir, keepRuns, readDirs, researchers, reviewRounds, auto }` (profiles under `playbooks/research/profiles/`, built-ins default / quick / thorough / native), `graph { ontologyPacks }`, `review { resolution, llmJudge, llmMinConfidence, autoMergeMinConfidence, maxJudgedPerRun, claims, external }`. Migration `V7_WIKI_RESEARCH` adds the columns and tables above and `V8_REVIEW` adds `entity_alias_keys.kind`; `entity_embeddings` is created with the embedding dimension at open. The MCP bearer token lives in `<data>/.knode/mcp-token`; `knode-os connect <client>` registers the HTTP endpoint (`--stdio` for a standalone process).

## 9. Open items

1. Codex HTTP‑MCP auth uses `bearer_token_env_var` per its CLI help; workspace fields travel in the query string.
2. Whether cursor‑agent's `--add-dir` is read‑only and whether `--mode ask` blocks MCP writes is untested.
3. Concurrent applies on the Postgres backend may create transient duplicate entities (PGlite serializes transactions); the audit proposes the merge.
4. Server changes need `macos/scripts/package-app.sh` to repackage the macOS app. Initialization (kind = `init`), the chat entry and the later runner improvements are in [07 — Initialization and chat](07-init-and-chat.md).
5. Native sub-agent mode follows the official configuration references (claude `--agents` description / prompt / tools / model; codex `agents.*` and `developer_instructions` in the per-role layer) but has not been run against real CLIs; cursor-agent's `effort` has only been seen as `high`, so `xhigh` / `max` map to `high`.
6. `claude --effort` needs a recent CLI (older ones exit on the unknown flag), which is why the built-in `default` profile uses effort `default` (no flag); pick `thorough` or your own profile for `max`.
