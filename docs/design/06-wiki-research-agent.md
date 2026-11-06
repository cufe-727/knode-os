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
| D3 entity resolution | deterministic at write time (NFKC / width / corporate‑suffix folding + exact name/alias key match); fuzzy candidates go to an audit → `merge` suggestions → a person → reversible link. Since 2026‑09‑30 the audit runs **right after every extraction pass** on the entities that pass wrote, with the nightly run as the backstop ([09](09-ingest-stage-rework.md)) |
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
   └──sync──▶ Source (quarantined) ──▶ disputes ──▶ promote (UI / knode_trust from this machine's own clients)
serve: /api/* + /mcp (Streamable HTTP, per-workspace, bearer token) ◀── claude -p / codex exec / cursor-agent -p (isolated run workspace, read-only add-dir)
after each extraction pass: duplicate audit of the entities it wrote + document summaries (09)
nightly tier 2: claim audit (supersession) + full duplicate-entity audit + claim review + recommendation refresh + wiki lint (community pages retired: hot clusters are research suggestions now, see 09)
```

## 2. Ontology, typed and time‑bound relations (`src/graph/ontology.ts`)

- Packs under `playbooks/ontology/<pack>.yaml`, merged in `graph.ontologyPacks` order (default `["core","organization"]`);
  `initDataDir` seeds the built‑ins and never overwrites edits. Relation fields: `id / inverse / symmetric / hierarchical /
  temporal / domain / range / synonyms / inverseSynonyms / description / system`. Entity types carry `label / description /
  examples`, and the tier‑1 prompt lists each type on its own line with them; a later pack may restate a type to sharpen
  its description without moving it (the declaration order breaks the fold's ties between types).
- A third built‑in, `finance` (opt‑in, 2026‑10‑23), is the vocabulary of a stock‑market corpus: entity types `market`,
  `index`, `security` (an instrument that is not a company or a fund — a listed company stays `organization` with its
  tickers as aliases), `fund`, `sector`, `theme`, `indicator`, `currency`, `commodity`, `policy`; relations `listed_on`,
  `constituent_of`, `belongs_to_sector`, `tracks`, `issued_by`, `manages_fund`, `benefits_from` / `harmed_by` (利好 / 利空
  read inverse), `holds_position_in`, `recommends` / `bearish_on`, `predicts`. There is no channel type: a platform or
  media account is an `organization`, a blogger a `person`. A generic market move (大跌) is a `price_move` claim, not an
  `event` entity.
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
  any key match with a compatible type (an entity one of the spellings names before one that only carries it as an
  alias, then the most mentioned) → else a new slug. A redirected mention becomes an alias, evidence records
  `resolved_from`. A scope‑local key index covers the body before the fold publishes keys; declared frontmatter facts
  are applied before concept mining.
- A spelling that is one typed entity's name and another entity's alias belongs to the entity it names (since
  2026‑10‑30): in the tier‑0 link index (`buildLinkIndex`), so in the views' mention marking and in the known entities
  the tier‑1 prompt offers, and in `[[link]]` resolution (`entitiesNamed`). A document's declared author (`source:`)
  links to the entity the name names, not to every entity carrying it. Before, the most mentioned candidate took every
  key, and the wrong aliases extraction merges leave (HBM on 芯片, 机器人 on 科技, 晶圆厂 on 半导体) handed a smaller
  entity's link surface to the hub, and the prompt named the hub for that spelling. On the finance graph that moved
  5,789 of 61,944 link keys and changed the tier‑0 links of 19,247 of 23,264 documents.
- A typed entity's full name keeps its span against a shorter spelling inside it, however rarely the entity is
  mentioned (since 2026‑10‑30): an entity past the link index's candidate limit (the 10,000 most mentioned) is listed
  for its own name when that name is a spelling the index links or holds one (`namedPastLimit`). 凤凰传媒 links itself,
  not 凤凰航运 through 凤凰; 净利率 itself, not 利率; 华强科技 itself, not the hub 科技. Every span this adds covers one
  that linked before. A name that holds no listed spelling stays tier‑1's, as do the aliases of entities past the
  limit, and a corpus‑frequent name is held to the alias rule. Before, such a span linked the shorter spelling's entity
  unless this one was among the most mentioned when the document was planned, so a relink, which moves mention
  counts, could make a document applied after it link worse. On the finance graph: 31,938 names past the limit listed
  (3,029 before), 59,831 → 88,663 keys, and 12,974 of 23,334 documents change their tier‑0 links. Listing every name
  past the limit instead linked words tier‑1 had typed once (差不多了, 天来, 一道) in over a hundred documents each.
- Extraction‑time linking: the tier‑1 prompt lists known entities present in the text; the LLM answers with `sameAs`.
- Merges: `entity_links` + `entities.canonical_id`, written by a `merge` scope as an explicit effect (inverse
  `entity_link.remove`); `applyMerge / unmergeEntity` log ledger feedback that `rebuild` replays. Reads (graph search,
  claims, context packs, vfs, entity pages) redirect to the survivor; merged entities' stubs become redirects.
- Duplicate audit (after each extraction pass over the entities it wrote, nightly in full — [09](09-ingest-stage-rework.md) §3): same bare key / shared alias key / short name is a prefix of a longer same‑typed name / embedding
  similarity (real embedders, cached in `entity_embeddings` by fold_sha) → `merge` suggestions, never re‑proposed once
  rejected. Surfaces: `knode-os entities merge|unmerge|merges|dedupe|resolve`, `POST /api/entities/*`.
- Corrections by hand (`src/graph/corrections.ts`, since 2026‑10‑30): `playbooks/entities/corrections.yaml`, keyed by
  entity id, gives one entity a `type` and `notAliases`, spellings it does not answer to. The fold applies them over the
  evidence. The type replaces the fold's pick, the most‑read typed reading ([05](05-agent-context-db.md) §4.3), which
  extraction can get wrong most of the time: 人工智能 was read as a `product` 2,247 times and as a `theme` 1,090. A refused spelling, with or without a corporate suffix, leaves the alias list and the lookup keys, including
  keys a merged member brings. Resolution (`sameAs`, a key match, a member's key) and the writer's scope‑local key
  index never put it on that entity again. Evidence is untouched, so removing an entry restores what the extractors
  said, and a rebuild keeps the file. `knode-os entities correct <entity> --type … --not-alias … [--clear]` writes an
  entry, logs `entity.correct` feedback and refolds the entity; `entities corrections` lists them. A document applied
  before a correction keeps the redirect it made until it is applied again (`sync --reapply --only <paths>`, tier‑1
  replayed from the sidecar). Found in finance on 2026‑10‑30: extraction merges had filed 创业板 under A股, HBM under 芯片
  and deepseek under 模型. Later mentions resolved through those aliases and carried them onto the wrong entity in 312
  documents.

## 4. Time on claims (`src/store/dates.ts` / `src/ingest/docdate.ts`)

- `documents.doc_date` from frontmatter (`date / published / as_of / generated.at …`) or a date in the path — never the
  mtime. Stored in the sidecar meta; search results carry `docDate`.
- `normalizeDateExpr()` turns `2026-08 / 2026Q2 / 2026年第二季度 / 2026年上半年 / FY2025 / 去年 / 上季度 / 去年同期 /
  2024年以来 / 截至 2026-06-30` into precision‑aware `[from, to]` spans; relative forms resolve against the document date.
- New claim columns `event_at`, `observed_at`, `superseded_by`; prompts and frontmatter distinguish `eventDate` from
  `startDate/endDate`. Supersession marks the older of two facts of the same subject, type and object; `knode_claims` hides them
  unless `include_superseded`, and `order=timeline` / `event_range` build chronologies.
- Claims carry a closed `type` and a `kind` (2026‑10‑23). `type` is one of `CLAIM_TYPES` (`src/graph/store.ts`): `price_move`,
  `technical`, `earnings`, `guidance`, `fundamentals`, `valuation`, `fund_flow`, `holding`, `management`, `recommendation`,
  `outlook`, `macro`, `policy`, `event`, `risk`, `method`, `other` (plus the system `absence`); the prompt lists them with one
  line each, and any other spelling — the old free labels, Chinese names, near misses — maps through synonyms on parse, on
  sidecar replay and in the writer, unknown → `other`; a filter (`knode_claims.types`, a template slot's `claimTypes`) spelled
  with an old label is mapped too, an unknown one matches nothing. `kind` (migration v14, `claims.kind`) is `fact` / `opinion` / `prediction` /
  `rumor`, beside `status`, which keeps saying how firmly the source asserts; the statement is written without its
  attribution ("宁德时代估值偏高", not "作者认为…") and the kind carries it. Supersession runs over the measure‑like types
  only (`CLAIM_TYPES.supersedes`: earnings, guidance, valuation, price_move, technical, fund_flow, macro, holding,
  recommendation, outlook — a later `management` or `event` fact replaces nothing), by subject, type and object; it,
  the stale‑fact audit, source disputes and the nightly review consider `kind = fact` only; the duplicate‑claim judge sees the kind and a pair of
  different kinds never merges on its own; entity stubs list "Views and forecasts" apart from "Facts (current)";
  `knode_claims` / `GET /api/claims` / `knode-os claims` filter by `claim_kinds` / `claim_kind` / `--kind`. Entity
  descriptions are asked context‑free (what the thing is, not what the document says about it).
- Entity stubs split into `## Facts (current)` and `## Timeline`.

## 5. The research runner (`src/research/`)

- **Templates are skills**: `playbooks/research/AGENTS.md` (shared protocol) plus one template per kind (`entity /
  concept / comparison / timeline / question / refresh`) declaring `output`, `maxTurns` and `requires`.
- **Jobs**: `research_jobs` (`queued → running → validating → done|failed|cancelled`), deduplicated per kind+target.
- **Run workspace** `<data>/.runs/<jobId>/`: `CLAUDE.md` = `AGENTS.md`, `brief.md` (target, output contract, allowed
  predicates, existing page with the human paragraphs to keep, a `knode_resolve` seed, previous rejection reasons),
  `.mcp.json` / `.cursor/mcp.json`, `transcript.jsonl`, `result.json`, `validation.json`, `rejected.md`, `existing.md`.
- **Launch recipes** (`launch.ts`) for claude / codex / cursor / opencode: read‑only, MCP attached, no write or shell tools.
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
| revise | reviser | up to `rounds` (default `research.reviewRounds`); the count lives on the reviser, and a critic's own `rounds` is the older spelling, read only while no reviser sets one (`revisionRounds`, 2026‑10‑03) | write | the corrected page |

Disabling a role skips its phase: no planner → the outline is the template's required sections; no researcher → the synthesizer researches itself; no critic → validator only; no reviser → no revision. Every role may name its own CLI (connection id or provider), model, reasoning effort, tool scope (write pages / read files / web) and prompt file; the prompt defaults to `playbooks/research/phases/<phase>.md`, a prompt edited in Settings is written to `playbooks/research/roles/<id>.md`, and the harness prepends the `<!-- knode-phase: … -->` marker. `phases.json` records role, CLI, turns, cost and errors per session and lands in the job payload.

The third mode, `native`, runs one orchestrator session that writes the page and registers the roles marked `native` as the CLI's own sub-agents — claude through `--agents <json>` (description / prompt / tools / model, with the `Agent` tool allowed), codex through `agents.enabled=true` plus one `agents.<id>.config_file` TOML layer per role (`model` / `model_reasoning_effort` / `web_search` / `developer_instructions`, written to `agents/<id>.toml` in the run directory). cursor-agent has no sub-agent definitions and falls back to a single session. The orchestrator prompt is `playbooks/research/phases/orchestrate.md`; sub-agents never get `knode_write`.

## 5c. The three review layers (`review` config block)

| Layer | Config | Behaviour |
| --- | --- | --- |
| write-time resolution | `review.resolution: exact` (default) / `suffix` | `exact` merges a mention only when its spelling equals a known name or alias; `suffix` also merges names differing only by a corporate suffix. `entity_alias_keys.kind` tells exact from bare keys (migration v8) |
| LLM judge | `review.llmJudge: off / suggest (default) / auto`, `llmMinConfidence`, `autoMergeMinConfidence`, `maxJudgedPerRun` | the audit (incremental after each extraction pass, full at night) shows each candidate pair (descriptions + excerpts) to the LLM; `suggest` annotates the suggestion; a confident "different" is recorded as rejected (actor `llm-judge`) and never re-proposed; `auto` calls `applyMerge` (reversible) above `autoMergeMinConfidence` |
| claim review | `review.claims: off / suggest (default)` | open disputes and `suspected` claims get a verdict (a / b / both / neither / unclear) and a recommended action, filed as `knowledge` suggestions |
| external verification | `review.external: off / verify (default) / research` | the master switch for web tools: `off` never; `verify` only for `verify` jobs (template `verify.md`, output `wiki/reviews/`), unless the profile or a role says `web: on`, which widens it to every job; `research` always, though a profile or role may still switch it off. claude keeps WebSearch/WebFetch, codex gets `web_search = live | cached` (freshness from the profile), cursor is told in the prompt; the page's `sameAs` becomes a merge suggestion, `notSameAs` a remembered rejection. It caps Ask too (an agent's `tools.web`), and is the "Web access" picker on the Research tab's runner card (since 2026‑10‑03; the config file only before) |

`knode-os review entities|claims`, `POST /api/review/claims` and `POST /api/entities/dedupe` run the passes on demand; every extraction pass first runs an incremental duplicate audit over the entities it wrote, and the nightly tier 2 runs claim audit → full duplicate audit (with the judge) → claim review → recommendations → lint. The judge is the Judge stage's route (`extraction.judgeLlm`, 09).

## 5d. Research profiles (`src/research/profile.ts`, `playbooks/research/profiles/<name>.yaml`, `research.profile`)

A profile lifts *how* to research out of the harness: one YAML answers how hard to think, whether to go online, how hard a fact must be, when to stop, what the page looks like, and which sub-agents exist. `research.profile` selects it; a missing file falls back to the built-in `default`.

| Block | Keys | Effect |
| --- | --- | --- |
| `reasoning` | `effort: default / low / medium / high / xhigh / max / ultra`; `speed: default / fast` | reasoning effort and speed of every session; a role may override them (`default` = leave the CLI's own setting). `ultra` is the rung codex lists above `max` (deepest reasoning, delegates on its own); `fast` is the priority tier the codex catalog calls "Fast" (quicker, at higher usage), which the other two CLIs ignore |
| `search` | `web: inherit / on / off`; `freshness: live / cached`; `maxRounds` | web access (only widened or narrowed within what `review.external` allows, see 5c), codex search freshness, search rounds per section (in the brief) |
| `verification` | `minSourcesPerClaim`; `preferPrimarySources`; `resolveConflicts: flag / prefer_primary / prefer_recent` | in the brief; with `minSourcesPerClaim ≥ 2` the validator requires each `fact` to carry its own `sources: [...]` (`suspected` only warns) |
| `stop` | `maxSections`; `marginalGain` | outline cap (enforced in code); "stop a section when a search round adds nothing new" (in the brief) |
| `output` | `citations`; `uncertainty`; `evidenceTable` | in the brief; `evidenceTable` makes `## 证据表` a required section (validator and outline) |
| `pipeline` | `'' / single / team / native` | empty = follow `research.pipeline`. Since 2026‑10‑03 Settings edits the pipeline on the profile only: the picker shows what runs and writes an explicit value once changed |
| `roles[]` | `id, title, phase, enabled, agent, model, effort, speed, tools{write, files, web}, parallel, rounds, maxTurns, prompt, native, description` | the sub-agents (see 5b); empty `agent` = `research.agent`, empty `prompt` = `phases/<phase>.md`. The built-in agent supports `native` roles too — they become deepagents sub-agents |

Four built-ins (deleting one resets it): `default` (team; effort and web follow the CLI and review defaults), `quick` (single session, medium, cached, at most 4 sections), `thorough` (max, 5 parallel researchers, 2 review rounds, 2 sources per fact, evidence table), `native` (native sub-agents, high). The brief gains a "研究规范 (profile: …)" block that states these as rules the agent reads.

Per-CLI adapters live in `sessionArgs` (`src/research/launch.ts`; `research export` prints the same command lines). The effort and speed adapters (`effortFor`, `speedFor`, `cursorModel`) sit in `src/llm/cli.ts`, so a one-shot completion on an LLM connection — which carries its own `effort` and `speed` — asks for them the same way a research session does:

| | claude | codex | cursor-agent | opencode |
| --- | --- | --- | --- | --- |
| reasoning effort | `--effort <level>` (`ultra` → `max`) | `-c model_reasoning_effort="…"` | bracket syntax on the model name, `model[effort=high]` (`xhigh`/`max`/`ultra` → `high`; impossible without a model) | the model's `options.reasoningEffort` (`xhigh`/`max`/`ultra` → `high`) |
| speed | none (nothing passed) | `-c service_tier="fast"`; a sub-agent layer writes `service_tier = "fast"`. codex warns and drops a tier the model does not advertise | none (Fast is a separate `-fast` model in its list) | none |
| web | `WebSearch` / `WebFetch` in `--allowedTools` or `--disallowedTools` | `-c web_search="live" | "cached" | "disabled"` (no longer `tools.web_search`) | prompt only | `webfetch` / `websearch` permission (websearch exists only on OpenCode's own provider or with Exa) |
| files | `Read` / `Grep` / `Glob` allowed or disallowed | read-only sandbox, always readable | `--add-dir`, always readable | `read` / `grep` / `glob` / `list` permission, `external_directory` allowing the read roots only |
| turn cap | `--max-turns` | none | none | `agent.build.steps` |
| page-writing tools | a read-only role's `--allowedTools` leaves out `knode_write` | none (every MCP tool visible; prompt only) | none (`--approve-mcps`; prompt only) | `knode-os_*` denied, the read set allowed by name |
| native sub-agents | `--agents <json>`, `Agent` / `Task` allowed | `agents.enabled`, `agents.max_concurrent_threads_per_session`, `agents.default_subagent_reasoning_effort`, `agents.<id>.description`, `agents.<id>.config_file` | unsupported (single session) | `agent.<id>` with `mode: subagent`, its own prompt, model, effort and permissions; `task` allowed for those ids only |
| start-up downloads | none | the person's `~/.codex/config.toml` applies, but `-c features.plugins=false -c features.apps=false -c analytics.enabled=false` (2026‑11‑06: with them a one-word session downloaded 11–15 MB, without ↓43 KB), and `-c model_catalog_json=<copy>` of Codex's model catalog for the agent's model, else the one config.toml names (src/llm/codex-catalog.ts, docs/design/18 D9) | none | `OPENCODE_DISABLE_AUTOUPDATE` / `_MODELS_FETCH` / `_LSP_DOWNLOAD`, `autoupdate: false` (below) |

**OpenCode** (`opencode-cli`, `src/llm/opencode.ts`, added 2026‑11‑06) is the one CLI without a login of its own: it is a loop, and the model it loops on is one of `connections`. Its agent file names that connection — `executor: opencode-cli`, `connection: <id>` (`''` / `default` = the default LLM's, which must be a model endpoint), `model` empty = the connection's — and `llmTargets` binds the endpoint, key and protocol into its one-shot row (`bindAgentEndpoints`), so a pipeline stage, research and Ask all run on it. Every OpenCode process gets one generated config in `OPENCODE_CONFIG_CONTENT`, the layer above the person's own OpenCode files and any `opencode.json` up the tree: a single provider `knode` (`@ai-sdk/openai` for a `responses` connection or `auto` on api.openai.com, `@ai-sdk/openai-compatible` otherwise — Anthropic's OpenAI-compatible endpoint included; both packages ship inside OpenCode), `enabled_providers: ["knode"]`, the key as `{env:KNODE_OPENCODE_API_KEY}` with the resolved key only in the process environment (never argv, never a file), knode's MCP endpoint with `Bearer {env:KNODE_MCP_TOKEN}`, `oauth: false` and a 300 s request timeout (OpenCode's default is 5 s), `snapshot: false`, `autoupdate: false`, and permissions that start from `"*": "deny"` — no shell or edit tool ever, then knode's tools and the rows above. A permission that would ask is rejected in `opencode run`, so a denied tool fails the call rather than hanging. The process also gets `OPENCODE_DISABLE_AUTOUPDATE` / `_MODELS_FETCH` / `_LSP_DOWNLOAD` / `_CLAUDE_CODE` / `_EXTERNAL_SKILLS`; a one-shot call adds `_PROJECT_CONFIG` and denies every tool (but `read` on the images' folders), while a session keeps project instructions so the run workspace's `AGENTS.md` is read. It runs `opencode run --format json --model knode/<model> --title knode <label>` with the prompt on stdin; the reader (`readOpencodeStream`) keeps the text after the last `tool_use`, counts `step_finish` events as turns and adds their cache and reasoning tokens back into usage; Ask reads its `tool_use` events as activity. A quota is the key's, so a pause is shared with the built-in agent on that endpoint (`agentKey`). `research export` writes `opencode-knode.json` and the commands to run it by hand.

Every place the macOS settings take a model — a stage, an agent, the research runner, a role — is one model field (2026‑09‑30): clicking the field drops down what the provider or CLI lists, and typing filters it — ids that start with the text first, then ids with a part that does (`sol` finds `gpt-6.1-sol`) — with ↑/↓ to move, ↩ to pick and ⎋ to close and keep the text. The list's first row, "Default · …", empties the field and says what empty runs. Where the model runs on a CLI, an effort chip sits at the field's end ("⚡ High"); it opens a slider whose stops are that model's `supported_reasoning_levels` from `codex debug models` (with their descriptions and `default_reasoning_level`), and Fast comes from `additional_speed_tiers` and `service_tiers`; a CLI with nothing per model offers what `effortFor` can pass on. A greyed chip shows the fallback that actually applies: a stage follows its agent, a role its profile, the runner's chip is the profile's `reasoning`, then `~/.codex/config.toml`'s `model_reasoning_effort` / `service_tier` (the model list's `defaults`), then the model's own default. An API endpoint takes no effort, so its field has no chip.

Entry points: the Settings page. The "Providers & Agents" tab carries two tables: the **models** — embedding and LLM endpoints; `connections` holds model endpoints only — then the **agents**, one file each under `playbooks/agents/<name>.yaml`. An agent has one of two runtimes. `executor` = `claude-cli` | `codex-cli` | `cursor-cli` runs that coding-agent CLI with its own `cliPath` (empty = found on PATH), `model` and `effort`; anything else runs the in‑process LangChain `deepagents` loop on a model — `default` follows the default LLM, a connection id pins one — and is not runnable while what it follows is a CLI agent, rather than quietly running that CLI under its name. On top of either: `effort` / `speed`, and `tools.web` for Ask. Until 2026‑09‑30 an agent also carried `tools.write` / `tools.files`, `maxTurns`, `timeoutMs`, `prompt` and `description`; only Ask read the first four and nothing read the last, so they went — Ask runs every agent with the same turn cap, timeout and tools, takes its instructions from the workspace's chat protocol, and loading a workspace strips those keys from agent files. One template ships: `deep-agent` (deepagents, following the default LLM). Until 2026‑09‑29 a second one, `deep-research`, shipped beside it and differed only in its name and a `kind` that ordered the pickers — a research run takes effort, tools and prompts from its profile and a stage calls an agent one-shot, so the two always ran alike — so it went: `loadConfig` deletes a `deep-research.yaml` still as it was seeded and points the `research.agent`, `chat.agent`, pipeline routes and profile roles that named it at `deep-agent`; an edited one stays as an ordinary agent. `kind` went with it and is dropped from agent files on load. A CLI is an agent, not a model endpoint: until 2026‑09‑28 the CLIs were rows in `connections`, which made "cursor" the default *LLM* and let the deep agent run Cursor. `loadConfig` moves any CLI row into an agent file under its own id — so every route, `llmUse`, `research.agent` and role that named it keeps resolving — writes the config back once, and moves a CLI default to the first model endpoint that has a model (a workspace with none keeps the CLI). A pipeline stage names exactly what it runs on (`routeTargets`): a model, called directly, or an agent, run once through its own loop — a CLI agent as that CLI, a deepagents agent as the deepagents loop on its model (its own, else its endpoint's: `loop: 'deepagents'`, `completeViaDeepagents`), with its sub-agents and a read-only view of its scratch files but no knowledge-base tools. The stage picker groups them under LLM and Agent. Until 2026‑09‑30 a stage called a deepagents agent's model directly, so one with no model of its own was only its endpoint under another name, the picker left it out, and `pinRoutes` moved a stage on it to that endpoint. A stage no longer follows the default: its picker used to offer "Default LLM provider · X" beside X's own row — two entries for one endpoint that only came apart when the default moved — so on 2026‑09‑29 `pinRoutes` began writing an inheriting route (`''` / `'default'`) down as the default it ran on, on load and on every save, and moving the default now moves no stage. The default itself can still be a CLI agent (`llmTargets`), but not a deepagents agent, which may follow it. Ask reads `effort` / `speed` and `tools.web` from the agent it runs (see 07 §4.1); a research run takes its settings from the profile. `GET /api/agents`, `GET/PUT/DELETE /api/agents/:name`; deleting a built‑in resets it, deleting any other clears a `research.agent` / `chat.agent` that named it, moves a stage on it to the default by name, and lets a default that was it fall back. The "Research" tab reads in three layers (slimmed 2026‑10‑03): the **runner** — the agent that runs jobs and its model (the effort chip beside it is saved with the profile), the profile, parallel jobs, the per-session timeout, the workspace's web switch (`review.external`), auto-accept and the follow-ups after an initialization; the **profile** — the pipeline, web access, search freshness, the section cap, sources per fact and the evidence table, which are enforced or checked, and a folded "Research rules" group (search rounds per section, conflicting sources, primary sources, stop on no new facts, citations, suspected claims — written into the brief, never checked); the **sub-agents** — each role's model and effort, web tools, turns per session, the researcher's parallel sessions, the reviser's revision rounds, tools and prompt (duplicate as a new profile, reset a built-in). What the agent's runtime cannot carry is greyed out with the reason (table above: cursor has no turn cap, tool scope or web switch, codex no turn cap or tool scope, the built-in agent no web or files, and only codex picks search freshness). `research.pipeline` / `maxTurns` / `researchers` / `reviewRounds` are no longer on screen; they are only what a profile, template or role that sets none falls back to; `GET /api/research/profiles`, `GET/PUT/DELETE /api/research/profiles/:name` (PUT with `prompts: {roleId: text}` writes changed prompts to files, `activate: true` also selects it); the `research` block of `PUT /api/config` (agent / model / profile / pipeline / concurrency / rounds / timeout / auto) and `review.external`; `knode-os research profiles` and `knode-os research profile <name> [--use]`.

## 6. Recommendations (`src/research/recommend.ts`)

Signals: mentions + retrieval heat, 30‑day demand from `receipts.entities`, degree, open disputes, expired / superseded
facts; page state (none, stub, research page older than the newest evidence → **refresh**); hot communities without a
concept page; recurring `receipts.query` clusters → question pages. Filed as `wiki` suggestions whose acceptance queues
the job; `research.auto` accepts the top few per day. Human‑written pages are never recommended for refresh.

## 7. wiki lint (`src/wiki/lint.ts`)

Zero LLM: orphans, broken wikilinks, stale / unreviewed research pages, expired `stale_after`, superseded statements
still in a page, pages in open disputes. Report page `wiki/lint/<date>.md`; nightly after tier 2; `knode-os wiki lint`,
`POST /api/wiki/lint`.

Since 2026‑10‑25 a link is broken only when its name has neither a page nor an entity the graph knows from more than
links to it (`entitiesNamed` in `src/graph/resolve.ts`: a name or alias key, a merged entity as its survivor; the
concept a link to an unwritten page leaves does not count, or every link would be its own target). A link to an entity
whose page has another name counts as a link to that page. A link to an entity with no page is no finding: the report
counts those apart (`entityLinks`) and lists the entities linked from the most pages, the pages most worth writing. In
the web and Mac viewers the same link opens the entity panel: `GET /api/link/resolve` answers `{ entity }` when no note
does. Orphans count ordinary Markdown links as well as wikilinks (`index.md` links `overview.md` that way).

## 8. Config and migration

`database.kind` now defaults to `postgres` (`pglite` stays an explicit option; the test suite sets `KNODE_DATABASE_KIND=pglite`), and an unreachable server is a clear error rather than a silent fallback. `server.mcp`, `research { agent, model, profile, pipeline: single | team | native, maxTurns, timeoutMs, concurrency, runsDir, keepRuns, readDirs, researchers, reviewRounds, auto }` (profiles under `playbooks/research/profiles/`, built-ins default / quick / thorough / native), `graph { ontologyPacks }`, `review { resolution, llmJudge, llmMinConfidence, autoMergeMinConfidence, maxJudgedPerRun, claims, external }`. Migration `V7_WIKI_RESEARCH` adds the columns and tables above and `V8_REVIEW` adds `entity_alias_keys.kind`; `entity_embeddings` is created with the embedding dimension at open. The MCP bearer token lives in `<data>/.knode/mcp-token` and is this machine's own clients' (with sign-in on, the workspace it names must be an account's own, or a team the account has been given); `knode-os connect <client>` registers the HTTP endpoint (`--stdio` for a standalone process). The agents `serve` launches — research jobs, Ask turns — get a token minted for their workspace instead, held in memory: it opens that workspace and no other, and it may not promote a source or settle a dispute (`knode_trust` to trusted, `knode_disputes` resolve), which is the review the agent's own writes wait for.

## 9. Open items

1. Codex HTTP‑MCP auth uses `bearer_token_env_var` per its CLI help; workspace fields travel in the query string.
2. Whether cursor‑agent's `--add-dir` is read‑only and whether `--mode ask` blocks MCP writes is untested.
3. Concurrent applies on the Postgres backend may create transient duplicate entities (PGlite serializes transactions); the audit proposes the merge.
4. Server changes need `macos/scripts/package-app.sh` to repackage the macOS app. Initialization (kind = `init`), the chat entry and the later runner improvements are in [07 — Initialization and chat](07-init-and-chat.md).
5. Native sub-agent mode follows the official configuration references (claude `--agents` description / prompt / tools / model; codex `agents.*` and `developer_instructions` in the per-role layer) but has not been run against real CLIs; cursor-agent's `effort` has only been seen as `high`, so `xhigh` / `max` map to `high`.
6. `claude --effort` needs a recent CLI (older ones exit on the unknown flag), which is why the built-in `default` profile uses effort `default` (no flag); pick `thorough` or your own profile for `max`.
7. ~~An agent definition's runtime fields only reach Ask.~~ Settled on 2026‑09‑30 by removing the ones only Ask read (`tools.write` / `tools.files`, `maxTurns`, `timeoutMs`, `prompt`): an agent now carries only what its callers all read, and Ask runs every agent with the same turn cap, timeout and tools.
8. The OpenCode recipe was written against OpenCode 1.19.4's source (`run.ts`, the v1 config schema, the permission evaluator, `getUsage`), tested against a fake `opencode`, and on 2026‑11‑06 run against the real 1.19.4 (`npm i -g opencode-ai@1.19.4`) on both of the finance workspace's connections: one-shot calls on Anthropic's OpenAI-compatible endpoint (Chat Completions) and on OpenAI (Responses), and sessions through knode's MCP endpoint in which knode's tools worked, a read under a read root worked, a read outside them was refused by `external_directory`, no shell tool existed, a read-only session had no `knode_write`, a writer did, and a native role ran as a sub-agent through `task` with the read set only, while `general` and `explore` stayed out of reach. Two things that run showed: `opencode run` prints only the main session's events, so a sub-agent's tokens and steps are not in a session's usage or turns; and Anthropic's OpenAI-compatible endpoint caches nothing, so each step sends OpenCode's ~19k tokens of instructions and tool definitions at the full input price (OpenAI cached about three quarters of a session's input). The web Settings editor lists OpenCode agents with their connection; the macOS app does not know them yet and shows one as an unconfigured deepagents agent (saving it there keeps its `connection`).
