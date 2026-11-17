# 13 — The client contract: how other projects use knode-os, starting with rookie-trade

> **Record status (2026-11-17): Proposal — not built.** This is a decision record, not the description of the system. What the code does now is in [ARCHITECTURE.md](../ARCHITECTURE.md) §9, §10. No `contract/`, SDK, `known_at` or `available_at` exists. §0 still describes the four surfaces as they are, except "33 tools" and the token scope list. Schema v17 went to content languages (17).

> Status: **proposed** (2026‑10‑21).
> Builds on [05](05-agent-context-db.md) (time axes, worksets, trust tiers), [08](08-fragment-import.zh-CN.md)
> (rookie-trade's exports) and [12](12-remote-processing.md) (`/remote/v1` and its tokens). The contract's layout
> follows AgentMux's `contract/`.

## 0. Where things stand

rookie-trade is the first project meant to use knode-os from its own code and agents, rather than be fed into it by
hand. The intended loop: rookie-trade crawls posts and market data; knode-os turns the text into knowledge;
rookie-trade develops and tests strategies from that knowledge; results and feedback go back into the knowledge
base. Other projects on the Mac mini (AgentMux, GoalLoop, homebook) would use the same surface.

How the two connect today (knode-os at f9e084a, rookie-trade at its 2026‑10‑20 head; finance figures are read-only
aggregates taken on 2026‑10‑21):

| Link | State |
| --- | --- |
| Text | 32 entries in finance's `ingest.linkedFolders`, made by hand on 2026‑10‑17. Each is an author folder of rookie-trade's `data/exports/content-markdown/`; two of them hold only one platform of an author. 13,607 files are indexed, 3,818 of them weekly, from 32 of the 163 author folders. None is a Feishu chat, though 121 of the 163 folders are, and Feishu holds about 1.69 M of rookie-trade's 2.0 M entries. |
| Market data | Not connected; finance has no datasources. rookie-trade keeps it as Parquet, `data/market/<dataset>/<year>/<YYYYMMDD>.parquet` (Tushare, 2024‑01 → 2026‑10), plus US, ETF and options data. |
| Code | Neither repository calls the other. rookie-trade has no knode-os client, and knode-os is not registered as an MCP server in any Claude Code configuration. |
| Results | No results store. Strategy Lab computes reports on demand and caches them in process; research scripts leave JSON, CSV and Markdown under `data/research/` and `docs/research/<strategy>/outputs/`. |
| Knowledge → strategy | By hand: rules distilled from posts into `docs/sentiment-cycle/`, `docs/zeiwang-selection-rules.md` and the 舒九 wiki pages. No code reads the content or the knowledge base to produce signals. |

What knode-os offers another program:

| Surface | Meant for | Credentials | Covers |
| --- | --- | --- | --- |
| `/mcp` (this machine only) | coding agents | the data root's `.knode/mcp-token`, or a `kmw_` token `serve` mints in memory for the agents it launches | 33 tools: search, claims, resolve / plan / feedback, worksets, subscriptions, catalog and live SQL, writes (quarantined) |
| `/api` | the web UI and the app | a session cookie, or a `knu_` user token | nearly everything; unversioned and shaped by the UI |
| `/remote/v1` | remote workers and scripts | `knr_` tokens: hashed, scoped (`label`, `read`, `write`, `sql`), bound to workspaces, audited, rate-limited | leased work; documents and sync; search (`q`, `mode`, `k`, `as_of`); graph; claims (`subject`, `object`, `text`, `limit` ≤ 500); entities; catalog SQL (≤ 1,000 rows) |
| CLI | the administrator | none: it opens the data directory itself | everything; a wrong `--data` opens a fresh schema |

Five findings shape this design.

1. **Nothing can be read as of a past moment.** finance's 206,852 live claims entered the index between 2026‑10‑17
   and 2026‑10‑21 and describe 2010–2026. `as_of` is system time, so `as_of=2025-06-30` returns nothing: it pins a
   view, it cannot say what was knowable then. Nothing else fills the gap:
   - `search()` takes `as_of`, kinds and path prefixes, nothing about publication (`src/search/search.ts:203`).
   - A tier-1 claim's `observed_at` is its document's date, at day precision (`src/graph/llm-extract.ts:267`,
     `:330`). A weekly file is dated its Monday, and rookie-trade renders a post's later comments into the post's own
     period file, so one file holds text written days or weeks after its date.
   - Claim status, supersession, disputes and entity merges are folded from every source, later ones included.
     Generated pages (summaries, concept and research pages) were written from whatever was indexed when they ran.
2. **Remote writes are trusted.** `PUT …/document` syncs with the actor `remote:<token>` and records no writer
   (`src/remote/api.ts:325`). The quarantine rule matches actors starting with `agent`, `mcp` or `api`
   (`src/lineage/trust.ts:27`), so the document is trusted unless its own frontmatter lowers it. The same text written
   through `knode_write` is quarantined.
3. **Agents are handed the owner token.** `knode-os connect claude` registers knode-os in Claude Code's user scope
   with the data root's token (`src/cli.ts:1293`). That token opens whichever workspace a request names, for any
   existing account, and runs as `caller: 'owner'` (`src/server/mcp-http.ts:173`). An owner may promote sources and
   settle disputes, which is the review an agent's own writes wait for. No persistent token opens one workspace as
   an agent.
4. **Three adapters over one core, each written by hand.** `src/mcp/tools.ts`, `src/remote/api.ts` and
   `src/server/app.ts` each parse their own parameters. `/remote/v1` has fallen behind MCP: its claims take none of
   the time or trust filters, and it has no resolve, worksets or subscriptions.
5. **A DuckDB source sees one flat directory.** It makes one view per `.parquet`, `.csv` or `.tsv` file directly
   under `path` (`src/datasource/duckdb.ts:90`). rookie-trade's market data has a subdirectory per year (243 files
   for 2025 in `daily/` alone), so only its three top-level files (`stock_basic`, `trade_cal`, `ths_index`) would
   show up.

## 1. Decisions

1. **One contract, with an adapter per kind of caller.** knode-os gets a `contract/` directory like AgentMux's: an
   OpenAPI 3.1 document and JSON Schemas generated from the operation definitions, a golden test that fails on
   drift, and `CONTRACT.md` with the `contract_version`, stability tiers and change process. Each operation is
   defined once (zod input and output, a scope, a handler) and mounted both as a `/remote/v1` route and as an MCP
   tool.
2. **`/remote/v1` is the public HTTP API.** It already has the auth model a program needs and names the workspace
   in the path. `/api` stays the UI's own and stays out of the contract. There is no third HTTP API.
3. **A program is a token with a role and a trust tier.** The tier says whether what the token writes is evidence
   (a crawler's export: trusted) or opinion (an agent's or a strategy's conclusions: quarantined). Remote writes
   record their writer, as MCP writes do. No program token can promote a source or settle a dispute.
4. **`known_at` is a fourth time axis.** It restricts a read to what was available by an instant and recomputes
   whatever is folded from that. Availability belongs to the entry (a post, a comment, a message), not to the file,
   and the producer declares it.
5. **knode-os is the slow layer.** Prices and per-post signals stay in rookie-trade's stores. knode-os contributes
   identities, themes, rules, track records and the reasons behind them. It is never on an order path.
6. **Experiments are written back, not facts.** A strategy result enters knode-os as a quarantined
   `type: Experiment` source linked to what it tested. The numbers behind it stay in rookie-trade, readable as a
   datasource.
7. **The SDK is thin and lives beside the contract.** `sdk/python` (`knode-sdk`, imported as `knode_sdk`) wraps
   `/remote/v1` with httpx and typed models, is checked against the golden schemas, and is installed by rookie-trade
   through a uv path source, as `agentmux-sdk` already is.
8. **The CLI stays the administrator's.** Projects call the contract; they do not run `knode-os`.

## 2. The loop

```
 rookie-trade                                                       knode-os · finance
 ────────────                                                       ──────────────────
 crawlers ─▶ content_v3.entry ─▶ review (LLM) ─▶ rt export, kb target ── linked folder ──▶ raw/docs/content-markdown/…
             posted_at,           relevant, instruments,   entry index                      │ tier 0: producer claims
             captured_at          stance, claims           in frontmatter                   │ tier 1: extraction (fallback)
                                                                                            ▼
 data/market/**.parquet ◀──────── duckdb datasource rt-market (read-only, glob tables) ──── graph · claims · locators
                                                                                            │
 Strategy Lab, research ◀── knode_sdk: evidence, mentions, claims (known_at, as_of) ────────┤
 agents in the repo     ◀── MCP: resolve, search, read (agent token) ───────────────────────┘
   │
   ▼
 run registry ─▶ record_experiment ── /remote/v1, agent token ────▶ raw/docs/rookie-trade/experiments/…   (quarantined)
   └─▶ track records per author ───── /remote/v1, producer token ─▶ raw/docs/rookie-trade/track-records/…
```

- **Text goes in as files.** The linked folder stays the bulk path. The files are the record, every effect has
  lineage and an inverse, and a deleted file takes its knowledge with it. The export moves to version 2 (§6).
- **Numbers stay where they are.** Market data and the run registry are read in place, through datasources (§5).
- **Strategies read through the SDK, agents through MCP.** Both reach the same operations (§3, §8).
- **Results come back as sources**, each with its trust tier (§7).

## 3. The contract

### 3.1 Layout

```
contract/
  CONTRACT.md          contract_version, stability tiers, auth and roles, the four time axes, change process
  openapi.yaml         generated (OpenAPI 3.1)
  schemas/*.json       one golden JSON Schema per wire type, generated
src/contract/
  op.ts                defineOp(): id, method, path, scope, tier, input/output (zod), MCP name and text, handler
  ops/*.ts             documents, knowledge, evidence, worksets, subscriptions, sql, live, work
  remote.ts            mounts every op on /remote/v1
  mcp.ts               registers every op that has an MCP name
  emit.ts              writes openapi.yaml and schemas/ (pnpm contract:emit)
tests/contract.test.ts regenerates both in memory and compares them with contract/
sdk/python/            knode-sdk (§8.1)
```

### 3.2 One definition per operation

```ts
export const listClaims = defineOp({
  id: 'claims.list',
  method: 'GET',
  path: '/w/:owner/:workspace/claims',
  scope: 'read',
  tier: 'stable',
  input: ClaimsQuery,   // subject, object, types, statuses, claim_kinds, text, valid_at | valid_range, event_range,
                        // as_of, known_at, kinds, sources, trust, cursor, limit
  output: ClaimsPage,   // claims[], next_cursor, applied[]
  mcp: { name: 'knode_claims', description: '…' },
  handler: (ctx, input, caller) => queryClaims(ctx.store, claimQueryFrom(input, caller)),
});
```

- A handler gets the workspace's `AppContext`, the parsed input and a `Caller`
  (`{ via: 'token' | 'mcp', name, scopes, tier, agent }`). The adapters build the caller from a `knr_` token, the
  data root's token or a minted workspace token. The handler never sees the transport.
- zod 4's `z.toJSONSchema` gives the schemas, and MCP registration takes the input object's shape. The route adapter
  parses query strings and bodies with the same schema, so a 400 says the same thing on both surfaces.
- The migration moves code instead of rewriting it. First come the operations both surfaces already have (search,
  graph, claims, entities, documents, sync, catalog SQL), then the MCP-only ones as they gain routes. `/api` keeps
  its handlers and may call the same operations later. The leased-work routes (`work/*`, `labeling/*`) move last and
  keep their wire format, which belongs to the worker and is versioned by `work/config`.

### 3.3 Versioning and stability

- `contract_version` starts at `1.0` and is returned by `GET /remote/v1/health` and `/whoami`. A minor version only
  adds. A breaking change is a major version with a new prefix, `/remote/v2`, served beside v1 for a release.
- **stable**: health, whoami, documents, sync, search, graph, entities, claims, catalog SQL.
- **beta** (may change within a minor version; recorded in `CONTRACT.md`): `known_at`, evidence, mentions,
  resolve / plan / feedback, worksets, subscriptions, live datasource queries.
- **worker**: `work/*` and `labeling/*`, versioned by `work/config.version` as now ([12](12-remote-processing.md) §4.1).
- The SDK reads `contract_version` on first use and refuses a newer major version.

### 3.4 What `/remote/v1` gains

| Operation | Route | Scope | Today |
| --- | --- | --- | --- |
| health, whoami | `GET /health`, `GET /whoami` | — / any | exists; adds `contract_version` and the token's role and tier |
| documents | `GET documents`, `GET` / `PUT` / `DELETE document` | read / write | exists; `PUT` records its writer (§3.5) |
| batch write | `POST documents/batch` `{ documents: [{ path, content, if_sha? }] }` | write | new: many documents, one sync, optimistic `if_sha` |
| search | `GET search` | read | gains `kinds`, `sources`, `known_at` |
| claims | `GET claims` | read | gains every `knode_claims` filter, `known_at`, and keyset paging (`cursor`, `limit` ≤ 1,000) |
| evidence | `GET evidence` | read | new, beta: one row per piece of evidence behind claims, mentions or relations, with its `available_at` (§4.4) |
| mentions | `GET mentions?entity=` | read | new, beta: the entries whose chunks mention an entity, with their times and sources |
| entities, graph | `GET entities`, `GET graph` | read | gain `as_of` and `known_at` |
| catalog SQL | `GET sql/views`, `POST sql` | sql | exists; gains the view `v_entries` (the producer's entry index) |
| resolve, plan, feedback | `POST resolve`, `POST plan`, `POST feedback` | read | from MCP |
| worksets | `POST worksets`, `GET worksets`, `POST worksets/:id/commit` | read / write | from MCP |
| subscriptions | `POST subscriptions`, `GET subscriptions/:id/changes`, `DELETE subscriptions/:id` | read | from MCP and `/api` |
| live sources | `GET datasources`, `POST datasources/:id/query` | `live` (new) | from MCP; read-only by each source's own guard |

`live` is a scope of its own, separate from `sql`, because it reaches other systems. The catalog views belong to the
knowledge base; a datasource query reaches MySQL, Parquet files or an HTTP API.

### 3.5 Tokens: roles and trust tiers

`RemoteTokenRecord` (`src/remote/tokens.ts`) gains `role` and `tier`. A role is a preset of scopes and a default tier,
and both can still be set explicitly.

| Role | Scopes | What it writes lands as | `/mcp` |
| --- | --- | --- | --- |
| `producer` | read, write | trusted: evidence, like a crawler's export | no |
| `consumer` | read, sql, live | — | no |
| `agent` | read, write, sql, live, mcp | quarantined | yes, as `caller: 'agent'` |
| `worker` | label | — | no |

```bash
knode-os remote token create --name rookie-trade-kb    --role producer --workspace admin/finance
knode-os remote token create --name rookie-trade-agent --role agent    --workspace admin/finance
```

- **Remote writes record their writer.** Before syncing, `PUT document`, `documents/batch` and
  `worksets/:id/commit` call `recordOrigin`, with `remote:<name>` for a trusted token and `agent:remote/<name>` for
  a quarantined one. `tierForActor` and the writer ceiling in `applyDocScope` (`src/ingest/apply.ts:213`) do the
  rest: frontmatter can lower a producer's document, never raise an agent's.
- **`/mcp` accepts `knr_` tokens with the `mcp` scope.** The workspace comes from the token: its only workspace, or
  the one of its workspaces that the request names. Such a session always runs as `caller: 'agent'`. The data
  root's token stays for this machine's interactive clients.
- **Lineage names the token.** Every write's scope carries its writer, as the remote audit log already does.
- `knode-os connect claude --project <dir> --token-env KNODE_AGENT_TOKEN` writes a project `.mcp.json` instead of a
  user-scope entry that carries the root token (§8.2).

### 3.6 What stays outside

- **`/api`.** It answers the UI and changes with it.
- **Push.** Subscriptions stay polled and cursored on system time ([05](05-agent-context-db.md) §9.5): a consumer
  that was offline for a week still sees everything since. Signed webhooks like AgentMux's event subscriptions can
  come later.
- **Embedding the library.** Importing `knode-os` into another process would open the workspace's index beside
  `serve`. PGlite is single-process, and on Postgres it would bypass `serve`'s watchers, locks and sign-in.

## 4. Reading as of a decision time: `known_at`

### 4.1 Four axes

| Axis | Parameter | The question it answers |
| --- | --- | --- |
| system time | `as_of` | what had knode-os recorded by then |
| world time | `valid_at` / `valid_range` | when does the claim hold in the world |
| freshness | `freshness` | how old may a live read be |
| availability | `known_at` | what could a reader have seen by then |

`known_at = t` keeps only evidence whose `available_at ≤ t` and recomputes what is folded from it. It composes with
the other axes. A backtest pins `as_of` to a workset, so that the same reads return the same rows later, and moves
`known_at` along the test. The resolver (`src/store/resolver.ts`) gains `knownAt` beside `txTime`, and `applied`
echoes it like the other axes.

### 4.2 Availability belongs to entries

A file is the wrong unit: a weekly file spans seven days, and a post's file holds comments written later. The
producer declares an index of its entries, keyed by the anchors its exporter already writes:

```yaml
anchors:
  e-3f9a12bc: { id: "post/5348792061920444", posted_at: "2026-09-29T20:21:00+08:00", captured_at: "2026-09-29T20:36:02+08:00" }
  e-77c0d1e4: { id: "comment/998877", posted_at: "2026-10-02T09:13:00+08:00", captured_at: "2026-10-02T09:40:11+08:00", reply_to: "e-3f9a12bc" }
```

An entry's `available_at` is the first of:

1. its own `available_at`, when the producer gives one;
2. `captured_at`, when the entry was captured within a day of `posted_at`: it was live, and that is when the
   producer had it;
3. `posted_at` otherwise: a backfill, where nobody knows when it would have been seen.

For backfills rookie-trade writes `available_at` as `posted_at` plus that platform's base polling interval (§6.2), so
a backtest does not assume it saw a 14:30 post at 14:30.

Text without an index (another producer, a hand-written document) gets a conservative default: frontmatter
`available_at`, else the end of `date_end`, else the end of the document's date. It is never earlier than the last
moment the file could describe.

Everything derived takes its availability from what it is grounded in:

- A **chunk** takes the latest `available_at` of the anchors it covers. The chunker keeps merging short entries,
  which retrieval needs, and records the anchors and their offsets in `chunks.metadata`. Text before the first
  anchor takes the document's default.
- **Evidence** (a tier-1 entity, relation or claim grounded to a chunk, or a mention) takes its chunk's
  availability. A producer claim names its entry with `anchor:` in frontmatter `claims` and takes that entry's.
- `chunks` and `evidence` gain an indexed `available_at` column (schema v17; v16 became `citations`). It is filled when a document is
  applied, and `sync --reapply` fills it for documents already indexed.

### 4.3 What a `known_at` read recomputes

| Read | Under `known_at = t` |
| --- | --- |
| search, SAG | chunks with `available_at ≤ t`; a SAG walk does not bridge through an entity that had no evidence by `t` |
| claims | folded again from evidence with `available_at ≤ t`, on the path `foldAsOf` already takes for `as_of` (`src/store/claims.ts:203`), with an availability predicate beside the tx window. Status, evidence counts and disputes come out as they would have stood at `t` |
| supersession | a claim counts as superseded only when its successor was itself available by `t` |
| entities, relations, graph | those with evidence by `t`; degrees and weights from that evidence |
| generated pages (`view`), agent-written wiki pages | left out by default; asking for them adds a warning to `applied`, since they were written knowing everything indexed later |
| absences | left out: they record when knode-os looked, not when the world knew |
| live datasources | not filtered; playbooks and plans get `{known_at}` as a template parameter (`WHERE trade_date <= {known_at}`) |
| entity merges | kept: identity is treated as timeless (§4.5) |

### 4.4 Backtests read evidence, not folds

A fold answers one instant, and a backtest steps through hundreds. So a backtest reads the event stream once and
folds on its own side:

- `GET evidence` pages through evidence rows: the claim, mention or relation each one supports; subject and object;
  what the source asserted (statement, status); source path, anchor and entry id; `posted_at` and `available_at`;
  extractor and trust. It filters by entity, type, source and an `available_at` range.
- At each step the backtest uses only rows with `available_at ≤ t`. Lookahead is excluded by construction, without
  a query per step.
- The SDK's `snapshot()` writes those pages to Parquet with a manifest: `contract_version`, workspace, the
  workset's `as_of`, the filters, row counts and a SHA-256 per file. The run registry stores the manifest.
- The snapshot file is what a result cites. `as_of` makes claim and evidence reads repeatable, but chunk text is
  always the current version, so a later re-query is not a substitute.

`known_at` point reads remain for people and agents looking at one moment: "what did we know about 宁德时代 the
evening before its earnings call?"

### 4.5 What `known_at` cannot fix

- **The model's own knowledge.** A 2026 model reading a 2024 post knows how 2025 went, and that can colour its
  claims, their types and statuses. Count the periods before the extracting model's training cutoff as in-sample,
  and prefer the producer's extraction (§6.3), whose prompt forbids outside knowledge, to tier 1.
- **Corpus-wide statistics.** Tier-0 concepts and `playbooks/concepts/frequent.yaml` are learned over the whole
  corpus.
- **Identity.** Entity merges apply whenever they were decided: a company renamed in 2025 answers to its new name in
  2024 too.
- **Processing delay.** A backtest assumes knode-os had processed an entry the moment it was available. Live,
  tier-1 extraction can lag by hours; producer claims arrive with the export.
- **Edits.** An export file shows an entry's current text. What a reader saw at `t` lives only in rookie-trade's
  immutable raw archive.

## 5. Data that stays in rookie-trade

### 5.1 Market data as a datasource

`DataSourceTableConfig` gains `files`, a glob relative to the source's `path`. A table with `files` is one view over
every file the glob matches. Tables without it keep today's behaviour of one view per file.

```jsonc
{
  "id": "rt-market",
  "kind": "duckdb",
  "description": "rookie-trade market data (Tushare A-shares, daily)",
  "path": "/Users/ning/Projects/rookie-trade/data/market",
  "freshness": "1d",
  "tables": [
    { "name": "stock_basic", "entityColumns": [{ "column": "name", "entityType": "organization", "aliasColumns": ["ts_code", "symbol"], "sample": "all" }] },
    { "name": "daily",       "files": "daily/*/*.parquet", "entityColumns": [{ "column": "ts_code", "entityType": "organization", "sample": "all" }] },
    { "name": "daily_basic", "files": "daily_basic/*/*.parquet" },
    { "name": "adj_factor",  "files": "adj_factor/*/*.parquet" },
    { "name": "stk_limit",   "files": "stk_limit/*/*.parquet" },
    { "name": "trade_cal" }
  ]
}
```

- The glob is expanded when the DuckDB instance starts, so `allowed_paths` still names files, never a directory. The
  view reads `read_parquet([…], union_by_name = true)`.
- New trading days appear daily, so the expansion is redone on `datasource sync` and whenever a table's directories
  change (mtime), recreating the instance.
- `stock_basic` creates or finds each listed company by name, with its codes as aliases. A sampled `daily.ts_code`
  then resolves to the same company through those aliases (`resolveEntityIdByNameOrAlias`) and gets a locator, so
  the planner can write `daily` reads for 宁德时代 ([05](05-agent-context-db.md) §6).
- Linking samples 100 distinct values per column (`src/datasource/sync.ts:317`), which is too few for a table of
  every listed company. Entity columns therefore gain `sample`: a number, or `"all"` for a table under a size cap.
- What the columns mean goes in a capability note, `playbooks/capabilities/rt-market.md`: `trade_date` as `YYYYMMDD`,
  unadjusted prices times `adj_factor`, T+1, limit prices in `stk_limit`. rookie-trade knows the data, so the note is
  written and versioned there.

### 5.2 Instrument identity

Claims can be joined with prices only when an instrument is one entity. Two things feed it: the datasource above
binds codes, and the producer declares `entities` with aliases for every instrument an entry mentions
(`{ name: "宁德时代", type: organization, aliases: ["300750", "300750.SZ", "CATL"] }`). A post that says "CATL" and
one that says "300750" then land on the same entity.

### 5.3 The run registry

Before anything is written back, rookie-trade records its runs: one row per trial, not just the one kept.

| Field | Meaning |
| --- | --- |
| `run_id`, `study_id` | a study groups every trial of one hypothesis |
| `strategy`, `params`, `params_sha` | what ran |
| `code_commit` | rookie-trade's commit |
| `data_manifest` | `data/market/_manifest/v2.json` as of the run |
| `in_sample`, `out_of_sample` | the windows |
| `knowledge` | the snapshot manifest (§4.4), or none |
| `metrics` | the report's metrics block |
| `artifacts` | paths of the curves and trades |
| `preregistration` | the plan written before the test, when there is one (`docs/research/qqq-spy-regime/multisignal_research_plan.md` is one) |

Kept as Parquet under `data/research/runs/` and registered in knode-os as another DuckDB table, it lets an agent ask
how many trials a study took without a document per run.

## 6. The producer contract: rookie-trade's export, version 2

This replaces [08](08-fragment-import.zh-CN.md) §4–§5 where they differ. 08's renderer, `crawler/archive-markdown.mjs`,
has been replaced by `rt export markdown` (rookie-trade's `backend/src/rookie_trade/content_v3/export.py`).

### 6.1 Today

- One file per source per period. The period is a Shanghai day or an ISO week, whichever comes closer to 12,000
  characters. Only entries reviewed as relevant are rendered, plus the post of every exported comment; a post
  carries its comments whatever day they were written.
- Path: `<author>/<platform>/<slug>/<year>/<YYYY-MM-DD | YYYY-Www>.md`, where the slug is the source's name (up to 40
  characters) + `__` + `sha1(source_id)[:12]`.
- Frontmatter: `title`, `platform`, `source`, `period`, `date` (the period's start), `date_end` (weeks only),
  `entries` (a count).
- Each entry: `<a id="e-<sha1(entry_id)[:8]>"></a>` (`export.py:96`), then `## <time> · <author>`. The time is
  `HH:MM` in a day file and `MM-DD HH:MM` in a week file, in Shanghai time with no zone.
- Files carry no generation timestamp, so their hashes are stable.

### 6.2 Changes

1. **One export root for the knowledge base.** `rt export markdown` gains a `kb` target. It writes only sources
   marked `kb_export` (a new column on `data_sources`) into one directory, with today's relative layout. finance
   swaps its 32 links for one link of that root at the same destination, `raw/docs/content-markdown/`, so documents
   keep their keys. What enters the knowledge base becomes a rookie-trade setting.
2. **The entry index** (§4.2), as frontmatter `anchors`: one item per anchor, with the entry id, `posted_at` and
   `captured_at` from `content_v3.entry`, `posted_at_kind` when the platform gave no time, `reply_to` for comments,
   and `available_at` for backfills (`posted_at` plus the platform's base polling interval: 900 s, or 3,600 s for
   WeChat).
3. **Producer claims and instruments** from the review (§6.3), as frontmatter `claims` with `anchor`, and as
   `entities` with aliases.
4. `generated: { by: "rookie-trade/export@2" }` without `at`, which keeps hashes stable.

Headings stay as they are. People read them; the index is for machines.

### 6.3 Claims from the review

The relevance review already reads every entry, images included, against a JSON schema
(`content_v3/review/schema.json`: `decisions[{ id, relevant, reason, images[] }]`). It gains, for each relevant
entry:

```json
{ "instruments": [{ "code": "300750.SZ", "name": "宁德时代" }],
  "stance": "bullish | bearish | neutral | mixed | none",
  "claims": [{ "subject": "宁德时代", "type": "opinion", "statement": "…", "eventDate": "2026-09-29" }] }
```

- The claims are per entry and carry the entry's exact time, which a 12,000-character tier-1 segment cannot give.
- The prompt says to use only what the entry says, not what the model knows about later events (§4.5).
- Output tokens go up. Input tokens, the expensive part once images are included, do not. That makes a few Feishu
  chats affordable to include, and tier 1 becomes the fallback for what the review missed rather than the main path.

### 6.4 What re-indexing costs

A document's tier-1 result is replayed only when the whole file's SHA-256 is unchanged (`src/ingest/apply.ts:133`,
`replayableTier1` in `src/fs/sidecar.ts`). Adding `anchors` changes every file, so as things stand version 2 would
re-extract all 13,607 documents. knode-os therefore changes first. Tier 1 replays when the inputs its prompt reads
are unchanged: the body, the title and the document date. A frontmatter-only change then re-runs tier 0 alone.

## 7. Writing back

### 7.1 Experiment records

`knode_sdk.record_experiment()` writes one document per study, `raw/docs/rookie-trade/experiments/<study>.md`, with
the agent token, so the document lands quarantined. It is rewritten as trials accrue.

```yaml
---
type: "Experiment"
title: "情绪周期 · 退潮期空仓 · sentiment-cycle-exit"
date: "2026-10-21"
actor: "agent/rookie-trade"
generated: { by: "rookie-trade/strategy-lab@3c1e9a0" }
sources:
  - { id: "runs", resource: "rt-runs:runs?study_id=sentiment-cycle-exit", title: "run registry" }
  - { id: "plan", resource: "rookie-trade:docs/research/sentiment-cycle-exit/plan.md", title: "pre-registration" }
experiment:
  study: "sentiment-cycle-exit"
  trials: 14
  chosen: "7f3a2c"
  in_sample: ["2024-01-02", "2025-06-30"]
  out_of_sample: ["2025-07-01", "2026-10-17"]
  knowledge: { snapshot: "snap_01J…", as_of: "2026-10-21T02:00:00Z" }
  metrics: { sharpe: 1.12, cagr: 0.21, max_drawdown: -0.18, num_trades: 63 }
relations:
  tests: ["[[舒九的情绪周期理论]]"]
  trades: ["[[创业板指]]"]
claims:
  - subject: "舒九的情绪周期理论"
    type: "backtest_result"
    status: "suspected"
    statement: "退潮期空仓规则 2025-07..2026-10 样本外夏普 1.12，14 次试验中最好的一次"
    startDate: "2025-07-01"
    endDate: "2026-10-17"
---
Hypothesis, method, results, what failed, caveats.
```

- **Per study, not per run.** The record names the trial it reports and how many trials there were; every trial is
  in the registry. A result picked from 14 trials is weaker than one from a single trial, and the count travels with
  it.
- **Claims carry their test window.** Claims contradict each other only when their windows overlap
  ([05](05-agent-context-db.md) §9.3), so results for different windows coexist. A backtest that contradicts a
  trusted claim opens a dispute instead of overwriting it.
- **Quarantined until promoted.** Whoever reads the record promotes it, with `knode_trust` or the source's "adopt"
  in the UI.
- **Never a feature.** Reads that build signals exclude `raw/docs/rookie-trade/` through `sources`, or ask for
  `trust: trusted`, so no strategy is fed its own earlier conclusions.
- `tests` and `trades` are new predicates. rookie-trade ships them as `playbooks/ontology/research.yaml` (§9); until
  then the ontology folds them into `related_to`.

### 7.2 Author track records

rookie-trade has what it takes to score an author: the entries with their times and instruments, the review's
stance, and prices. For each author and window it measures what followed their calls (forward returns at fixed
horizons, hit rate, number of calls) and writes `raw/docs/rookie-trade/track-records/<author>.md`, with the method
versioned in `generated.by` (`rookie-trade/track-record@1`):

- claims of type `track_record` on the author's entity, one per window, with `startDate` / `endDate` set to the window;
- `available_at` set to the window's end, so a backtest at `t` sees only the windows that had closed by then;
- written with the producer token once the method has been reviewed. The first version goes through the agent token,
  so its records wait for a person.

This is the part of the loop that pays. The knowledge base learns how far to trust each source from outcomes, not
from what the sources say about themselves.

## 8. Clients

### 8.1 The Python SDK

```
sdk/python/
  pyproject.toml          knode-sdk; httpx only; pandas and pyarrow in the `frames` extra
  src/knode_sdk/
    client.py             KnodeClient: health, whoami, documents, search, claims, evidence, mentions,
                          entities, graph, sql, resolve, feedback, worksets, subscriptions, live
    models.py             dataclasses mirroring contract/schemas
    errors.py             KnodeError, ContractVersionError, Forbidden, NotFound, Conflict
    snapshot.py           paged evidence and mention reads → Parquet + manifest
    experiments.py        Experiment → the §7.1 document
  tests/test_contract_alignment.py    model fields against contract/schemas, like AgentMux's
```

In rookie-trade's `backend/pyproject.toml`:

```toml
[tool.uv.sources]
knode-sdk = { path = "../../knode-os/sdk/python", editable = true }
```

```python
from knode_sdk import KnodeClient

kb = KnodeClient("http://127.0.0.1:12000", token=os.environ["KNODE_TOKEN"], workspace="admin/finance")
ws = kb.checkout(note="sentiment-cycle-exit")
snap = kb.snapshot(
    kind="evidence", entities=universe, types=["opinion"],
    available=("2024-01-01", "2026-10-17"), as_of=ws.as_of,
    out="data/research/snapshots/",
)
for claim in kb.iter_claims(subject="宁德时代", known_at="2025-06-30T15:00:00+08:00", as_of=ws.as_of):
    ...
kb.record_experiment(study)
```

- Synchronous first, because Strategy Lab and the research scripts are. An async client can follow if something
  needs one.
- Errors map to the contract's statuses; a `409` from `if_sha` raises `Conflict`.
- rookie-trade wraps the SDK in an `rt kb` command group: `whoami`, `export`, `snapshot`, `experiment push <study>`,
  `track-records`.
- rookie-trade keeps working when knode-os is down. The SDK has timeouts, and nothing on an order path calls it.

### 8.2 MCP for agents working in rookie-trade

A project `.mcp.json`, committed, with the token taken from the environment:

```json
{
  "mcpServers": {
    "knode-os": {
      "type": "http",
      "url": "http://127.0.0.1:12000/mcp",
      "headers": { "Authorization": "Bearer ${KNODE_AGENT_TOKEN}" }
    }
  }
}
```

- The token is the `agent` one from §3.5, bound to `admin/finance`, so requests name no workspace. The session can
  read, search, resolve and write quarantined notes, but not promote them.
- Claude Code expands `${KNODE_AGENT_TOKEN}` from its own environment, not from rookie-trade's `.env`, so the
  variable belongs in the shell profile.
- Codex: `codex mcp add knode-os --url http://127.0.0.1:12000/mcp --bearer-token-env-var KNODE_AGENT_TOKEN`.
- The knode-os guide (`AGENTS.md`) arrives as the server's instructions, as it does now.

MCP is for agents and the SDK is for code. A tool call puts every row it returns into the model's context. A
backtest that needs 50,000 evidence rows should get them in a DataFrame, and an agent doing that analysis writes
Python against the SDK rather than calling tools in a loop.

### 8.3 The CLI

The CLI stays the administrator's tool: tokens, `connect`, datasources, sync, rebuild. It opens the data directory
itself, outside `serve`'s sign-in and locks, and a wrong `--data` silently opens a fresh schema. No project should
call it.

## 9. Configuring finance for trading research

- **`purpose.md`** is still the template. The wiki generator and the nightly dream read it, so it should say that the
  base serves A-share and US strategy research, who reads it, and what is out of scope.
- **Intents.** finance has one, `entity-overview`. Three would carry the loop:
  - `instrument-thesis`: identity, recent stance from tracked authors, the price reaction from `rt-market`, earlier
    experiments, open disputes;
  - `author-profile`: method pages, track records, active themes;
  - `strategy-review`: the rule's sources, its experiments, the claims that contradict it.
- **Ontology.** `playbooks/ontology/research.yaml` adds `tests` (experiment → concept) and `trades` (experiment →
  instrument), and the claim types `opinion`, `backtest_result` and `track_record`.
- **Capability notes** for `rt-market` (§5.1).

The administrator installs these. The API's write scope reaches only `raw/docs`, `wiki` and `playbooks/packs` (§11).

## 10. Phases

1. **Identity and trust.** Token roles and tiers; remote writes record their writer; `knr_` tokens on `/mcp` as
   agents; `connect --project`.
   *Done when* a document written with an agent token is quarantined and opens a dispute against a trusted claim,
   `knode_trust` refuses over that token, and a project `.mcp.json` with a token from the environment opens exactly
   its workspace. Tests: `remote-api.test.ts`, `mcp-http.test.ts`, `quarantine.test.ts`.
2. **The contract skeleton.** `src/contract/` with the operations `/remote/v1` already has, `contract/` emitted, the
   golden test and `contract_version`.
   *Done when* the existing remote API tests pass unchanged, and changing a field without `pnpm contract:emit` fails
   `contract.test.ts`.
3. **Tier-1 replay keyed on its inputs** (§6.4).
   *Done when* adding a frontmatter key to an extracted document re-runs tier 0 and keeps its tier-1 claims without a
   model call.
4. **`known_at`.** The entry index and claim anchors; `available_at` on chunks and evidence (schema v17); the
   resolver axis; search, claims, graph, evidence and mentions; generated pages left out.
   *Done when* a synthetic corpus passes: post A at t1 says X and post B at t3 contradicts it; at `known_at` t2, X is a
   fact with no dispute, and at t4 it is disputed; a Sunday post in a weekly file is invisible on that week's Monday;
   a comment in a post's file appears only after its own time.
5. **The contract grows.** Claim filters and paging, evidence, mentions, resolve / plan / feedback, worksets,
   subscriptions, `documents/batch`, live queries under the `live` scope; DuckDB `files` tables and entity-column
   `sample`.
6. **The SDK.** `sdk/python` with the alignment test, `snapshot()` and `record_experiment()`.
7. **rookie-trade.** Export version 2 with `kb_export`; the review's new fields; the run registry; experiment
   records; `.mcp.json`; `rt kb`. In finance: the datasource, capability notes, intents, ontology and purpose.
8. **Track records**, nightly, as the first loop that runs on its own.

Phases 1–3 come first whatever else is built. A study that only tests a hand-distilled rule against prices needs
phases 1, 2 and 6 and the run registry: knowledge shapes the rule but feeds no signal, so `known_at` can wait. Such a
study should still test on a window after the posts its rule came from. Phase 4 is required before any
knowledge-derived feature enters a backtest.

## 11. Known limits and open questions

- **The tier of track records.** They are measured by code, not asserted by an agent, but a wrong method would steer
  every pack that weighs them. They stay quarantined until the method has been reviewed once (§7.2). Trusted after
  that?
- **Who may write capability notes, intents and ontology packs.** They change what the planner does, and today only
  the administrator can install them, by hand. A `domain` scope limited to `playbooks/capabilities/` and
  `playbooks/ontology/` would let rookie-trade ship them; intents could stay manual.
- **Feishu.** 1.69 M entries in 126 chats. Which chats get `kb_export`, and are the review's claims enough without
  tier 1?
- **Purge versus citations.** `knode-os purge` erases disposed history, which can make an `as_of` cited by an
  experiment unreproducible. The snapshot file (§4.4) survives a purge; the purge could also warn when a workset
  still covers the range.
- **Several projects in one workspace.** rookie-trade writes under `raw/docs/rookie-trade/` and
  `raw/docs/content-markdown/`. A second project should take its own prefix, or its own workspace; there are no
  cross-workspace queries.
- **Off this machine.** `/mcp` answers this machine only. A project elsewhere uses `/remote/v1` over HTTPS with the
  same tokens and the SDK. Its agents would need `/mcp` over HTTPS, which this design does not propose.
- **Edits and retractions** (§4.5): the exact text at `t` needs rookie-trade's raw archive.
- **`/api` and the contract.** The UI could call the same operations and drop its own parsing. This design does not
  need it.

## 12. Where the changes go

| Area | Files |
| --- | --- |
| Contract | `contract/` (new); `src/contract/` (new: `op.ts`, `ops/*`, `remote.ts`, `mcp.ts`, `emit.ts`); `tests/contract.test.ts` (new); `package.json` (`contract:emit`) |
| Remote API | `src/remote/api.ts` (routes mounted from the operations; writers recorded; batch writes); `src/remote/tokens.ts` (`role`, `tier`, the scopes `mcp` and `live`) |
| MCP | `src/server/mcp-http.ts` (`knr_` tokens with `mcp`); `src/mcp/tools.ts` (registered from the operations as they move) |
| Trust | `src/lineage/trust.ts`; `src/fs/sidecar.ts` (`recordOrigin` from the remote routes) |
| `known_at` | `src/store/resolver.ts`; `src/store/migrations.ts` (v17: `available_at` on `chunks` and `evidence`, `v_entries`); `src/ingest/chunker.ts` and `src/lineage/writer.ts` (anchors, availability); `src/graph/frontmatter.ts` (`anchors`, claim `anchor`); `src/graph/llm-extract.ts`; `src/store/claims.ts`; `src/search/search.ts`, `src/search/sag.ts`; `src/graph/query.ts` |
| Tier-1 replay | `src/ingest/apply.ts`, `src/fs/sidecar.ts` (replay keyed on the prompt's inputs) |
| Datasources | `src/config.ts` (`files` on tables, `sample` on entity columns); `src/datasource/duckdb.ts` (glob tables, re-expansion); `src/datasource/sync.ts` (sample size) |
| CLI | `src/cli.ts` (`remote token create --role`, `connect --project --token-env`) |
| SDK | `sdk/python/` (new) |
| rookie-trade | `content_v3/export.py` (version 2, the `kb` target); `content_v3/review/schema.json` and `prompt.md`; a migration for `data_sources.kb_export`; the run registry and the `rt kb` commands; `.mcp.json`; `backend/pyproject.toml` (the `knode-sdk` path source) |
| finance workspace | `knode.config.json` (one linked folder, `rt-market`); `purpose.md`; `playbooks/intents/`, `playbooks/ontology/research.yaml`, `playbooks/capabilities/rt-market.md` |
| Tests | `tests/remote-api.test.ts`, `tests/mcp-http.test.ts`, `tests/quarantine.test.ts`, `tests/temporal-claims.test.ts`; new tests for `known_at` and DuckDB globs |
