# 30 — Answer routing, batched agent tools, and a rerank stage

Status: implemented on branch `claude/retrieval-routing-3d5c01` (2026-11-13). Not yet measured against the benchmark: no `eval run` was spent on it.

## Problem

The 2026-11-13 diagnosis of the corpus benchmark (`run-1x-ranking`, design 23) found that the knowledge base only ties an agent with grep. Part of it is retrieval:

- **The knode agent pays more to do the same work.** It called `knode_resolve` once and then read raw documents one per call: 8.1 calls and 49.6k weighted tokens a question on the reports pack, against grep's 3.7 and 30.5k. It had no way to ask for a set (every claim about X in 2025) in one call, because `knode_query` was not among its tools, and the brief told it to start with `knode_resolve` whatever the question.
- **`ask` cannot enumerate.** It does one search (k=8), a depth-2 graph search, ranks at most 24 facts and makes one completion. A list or a count is answered from whatever fits in that window: 0.52 on aggregate tasks, 0.29 on deep-hop ones, 0.24 below the grep agent overall.
- **Fusion has no second look.** Reciprocal-rank fusion orders candidates by where each channel put them, never by reading passage against question.
- **A hit can rest on a replaced claim.** A passage stating last quarter's figure ranks as well as the restatement, and nothing says the figure was replaced.

## 1. `ask` routes by the kind of question

`src/search/route.ts` classifies a question by wording, at no cost:

| Kind | Cue (English / Chinese) | Route |
| --- | --- | --- |
| lookup | none of the below | today's single-shot path, same cost |
| list | `isListQuestion` (which-plural, list, every, 哪些, 列出…) | enumerate claims |
| aggregate | how many / much / often, total, average, most, 多少, 几次, 一共, 排名… | enumerate claims, counts over the whole match |
| timeline | timeline, history of, in order, over time, 时间线, 按时间顺序, 演变… | enumerate claims oldest first, replaced ones included |
| multihop | a noun qualified by a clause ("the company that acquired X"), "of the … of", possessive chains, 的…的 chains, 母公司/创始人…的 | SAG search + relation walk |
| multihop (`rule:chain`) | a chain across clauses: one part asks for or describes something unnamed (谁, 哪个项目, 提出R-03的人, 一起事故, who, an engineer) and a later clause refers back to it (此人, 那个项目, 同一个客户, 新负责人, that person, they) | SAG search + relation walk |

The order of the tests is the order of the table from the bottom up: timeline beats aggregate beats list beats multihop, since "how many companies that…" is a count first. The chain rule is the exception: it comes after timeline and before the counts and lists, because what those would enumerate ("他今年修复过哪些事故") is the thing the question has yet to find. Added 2026-11-15: in the 10× reports benchmark every deep-hop and nonlexical-hop question (184) had reached `lookup`, and the chain rule moves those and no other question of the pack (1,896 questions) to the walk. The question's time window (`in 2025`, `March 2026`, `since 2024`, `between 2024 and 2025`, `2026Q2`, `2026年3月`, `2026年上半年`) is read by `questionRange` into ISO instants through the same parser `valid_range` uses.

`retrieval.router.classifier: "model"` adds one small call to the Judge stage's model, only for a question the rules called a lookup for want of any cue; the rules' answer stands if that call fails. Default `rules`: no model call.

A caller can force a route: `ask(…, { route: 'lookup' | 'list' | … })`. `AskResult.route` says which route ran, why (`rule:aggregate`, `model`, `caller`, `fallback:rule:list`), and what it did (claims matched and listed, relations walked); `knode_ask` returns it.

## 2. Lists, counts and timelines: enumerated claims

`src/search/enumerate.ts` matches, in SQL:

- claims whose subject **or** object is an entity the question names (and the entities merged into it, `namedEntities`);
- of the claim types the question names in words (`typesInQuestion`: `revenue`, `product_launch` for "product launch"; generic types such as `event` never count), retried without types if that leaves nothing;
- dated inside the question's window, the date being the claim's effective date (when the store has one, §5), else `event_at`, else `valid_from`, else its document's `doc_date`;
- current claims only, except for a timeline, which lists replaced ones too, marked `replaced later`.

Counts are computed over the whole match, up to 5 000 claims (`SCAN_CAP`; past that the prompt says "at least"): total, distinct documents, by month, by claim type, by subject. The claims themselves are listed up to `retrieval.router.enumerateLimit` (150), each with every live source behind it.

The prompt then holds:

- a short hybrid search (k ≤ 4 instead of 8, no graph-search chunks) and the excerpts a list question already got (lines of the named entities' other documents, `src/search/excerpts.ts`);
- the relevance-ranked facts a list question already got (`factsForQuestion` with `list`: relations, neighbours, variants) — the best third first, then every enumerated claim, then the rest; for a timeline, one chronology of both;
- a `# Counts` section (only the total for a plain list);
- one added system rule: enumerated facts are the whole match, so list every relevant item, merging duplicates, count distinct events, and do not quote a replaced fact as current.

When nothing is enumerated — the question names no entity and no claim type, or nothing matches — `ask` falls back to the lookup path, which still treats a list question as before.

Cost: the same single completion, one embedding, two SQL queries over the match (rows and counts) and one for sources. The completion's output allowance rises from 1 500 to 3 000 tokens on this route, since a complete list is longer.

## 3. Multi-hop: resolve → relations → read

`src/search/walk.ts` starts from the entities the question names and, for at most `retrieval.router.maxHops` hops (4; 3 before 2026-11-15, and a workspace whose config holds 3 keeps it), reads relations of every entity on the frontier, scores them, and moves to the far ends of the ones it keeps.

- **What it reads.** Two sets per entity: the heaviest 150, and the 150 whose descriptions hold the most of the question's terms (as LIKE patterns, the heaviest among equals). A hub's heavy relations then cannot hide the light one the question asks about, and a hub cannot crowd out the one relation a person has.
- **How a relation scores.**
  - **Terms.** The question's terms that the relation's type, description and far end hold. The near end's own name is left out of the description, and the named entities' spellings are left out of the question (事业部 of 第七事业部 would match every sibling group). Each predicate the question uses is widened to the spellings that mean the same in general:
    - 修复 / 修好 / 处理好 / 处理 / 解决 / fixed
    - 负责 / 名下 / 盯着 / 跟进 / owner
    - 接手 / 接管 / took over
    - 提出 / 预警 / raised / flagged
    - 风险 / 隐患 / risk
    - 事故 / 故障 / 宕机 / incident / outage
    - 上线 / 投产 / go-live
    - 发布 / released
    - 调到 / 调入 / 转岗 / transferred
    - 升级 / escalated
    - 客户 / customer
    - 成员 / member

    Until 2026-11-16 they also held a benchmark's vocabulary: 升级 = 投诉, 发布 = 上线 = 交付, 提示 / 上报 = 提出, 加入 = 调入. Each term weighs by how few of the hop's candidates hold it. A branch may use a term only as often as the question does: 升级 twice in "修复过一起…升级的事故…另一个组升级过事故", once in "升级的那起事故".
  - **Anchors.** A far end within two relations of another entity the question names than the one its branch started from scores like a term. "（第七事业部）华鼎零售升级的那起P1事故" then prefers the customer's incident whose group belongs to the seventh division over its heavier incidents elsewhere. Each named entity weighs by how few candidates it anchors.
  - **Meaning and type.** See §3.1.
- **What leads on.** A relation is kept only when it holds a term, is anchored, or (first hop) leads to one of a named entity's few siblings the question describes (§3.1). The first hop is held to this too: a question the walk cannot help gets nothing from it. Before 2026-11-16 the first hop kept the heaviest relations whatever they were: "宁德时代的人均产值是多少，它在行业里排第几" got five `competes_with` relations as facts.
- **How many it keeps.** Every branch takes its best step (branches ranked by their path's score), and the five best of the rest join it, so a hop holds at most ten.
- **The passage that states a hop.** The chunk the relation was read from: relations record it since v20, and all 2,014 relations of the 10× index do.
  - Else a passage of its source document (the one it was read from, or else the first its evidence names) that mentions both ends, or either.
  - Only a relation with no recorded source falls back to a chunk that merely mentions both ends. That passage is flagged (`trace.coMention`) and begins "(mentions A and B; not the source of "A rel B")". On a finance knowledge base two big names are named together daily, and a market recap three weeks before an acquisition is no statement of it.
  - From 2026-11-16 to its recheck the passage was the earliest co-mention within 45 days before the relation's source.
  - One bounded read per step, with no document dates.
- **Time.** The walk has a budget (1,500 ms by default, `budgetMs`). Past it no further hop or ordering starts, and the walk returns what it has with `spent` = { budgetMs, ms, before }. `ask` puts that in `route.walked.spent` and in a computed fact saying where the walk stopped and that what lies past it was not looked for. The first hop always runs.
  - On the reviewer's synthetic finance-sized store (113k entities; a hub with 6,594 relations and 23,520 mentions), same session, the walk takes:

    | | main 7a299bf | b8243cf | this |
    |---|---|---|---|
    | one hub | 908 ms | 192 ms | 57 ms |
    | two hubs | 1,182 ms | 673 ms | 121 ms |
    | six hubs | 1,304 ms | 568 ms | 128 ms |
    | one hub, ordered | 1,010 ms | 257 ms | 132 ms |
    | a small entity | 612 ms | 165 ms | 64 ms |
- **Chain order.** The passages come chain by chain: the best-scored step (scores add up along a branch) with the steps that led to it, from the first hop down, then the next best.
- **What the walk does not read.** The question's time window that routing reads (`questionRange`) does not constrain the walk. Only the ordering step (§3.1) reads a period, from the ordinal's own clause.

`ask` (`multihopAnswer`) answers from a search plus those bridge passages.
- **The search.** SAG when it has the question's embedding; otherwise (the embedder down, or keyword asked for) the caller's mode, whose hybrid search falls back to the keyword and graph channels.
- **What else it runs.** What the lookup route would have run: the depth-2 graph search, the excerpts of a list question, and the set computed from the claims. The set comes under the Ask session's switch (`opts.computed` or `retrieval.router.computedSets`, off by default) and with the same `now` and time budget (design 34).
  - On a chain (`isChainQuestion`) the set is computed only after the walk, over the entities the walk reached beyond those the question names, and kept only when its scope is one of them. Otherwise there is no set.
  - "平台组的INC-001是谁修复的？此人还修复过哪些事故？" got "Computed from the claims: 6 distinct event matching 修复", the group's six incidents, though the person fixed two.
  - A question routed to the walk that is not a chain computes as the lookup route does.
- **Context order.** The top eight contexts are the search's first four and the walk's first four. The rest of each follow, and then the graph search's chunks, up to twelve.
- **Facts.** The walk's computed ordering lines come first (§3.1), then the walked relations as the sources' facts ("Nimbus Freight acquired Borealis Logistics: … — raw/docs/deal.md"), then the claims about every entity reached.

Still one completion: the walk needs no model.

A first measurement (2026-11-15, the copy of the run's 10× index): deep-hop hit@8 0.22 → 0.72, complete chains 1 → 10 of 18; nonlexical-hop 0 → 5 complete chains, but hit@8 stayed at 0.06. From the division alone the walk could not tell which group or which incident was meant.

### 3.1 Non-lexical hops (added 2026-11-15, revised 2026-11-16)

A non-lexical question names only the division and describes the rest: "第一事业部管基础设施的那个组今年第二起最严重一档的故障，是谁处理好的？此人曾预警过一个隐患，眼下是谁在盯着那个隐患？". The reports never say 基础设施, 收款 or 拉新, so no term matches the group. "第二起" is an ordering over dated events, not a relation. What is built, all in the walk (`src/search/walk.ts`, `src/search/walk-order.ts`):

- **An entity described, not named (by meaning).** `ask` passes the question's embedding and model to the walk (one line in `multihopAnswer`).
  - Among the relations of one type from one entity (a division's three `part_of` groups), a far end gains one point per standard deviation that its entity embedding (name, type, aliases, description) lies above its siblings' mean cosine to the question.
  - It gains at most two points, under what a term held by few relations weighs (up to ~5). Uncapped, the nearest of 150 siblings gained about 12.
  - It gains nothing when its cosine is below 0.3, so of two siblings both far from the question neither gains.
  - A named entity's siblings, at most five, of which the question describes one this way are all walked on the first hop, the described one first; later hops (an ordering, a fix) may yet tell them apart.
  - Vectors of another model than the question's are not read. With no vector, a described entity is not found, and the walk adds nothing for it.
  - On the benchmark the nearest group is the described one in 13 of 17 divisions, with small margins: a preference, not a filter.
- **Relations are not matched by meaning.** Relation wording is matched by the general predicate families of §3 only. Matching it by meaning, through the question's cosine to the claims that join the same two entities (70% of relations have one), was tried and dropped: deep-hop chains 11 → 9. The ontology's relation-type labels and synonyms (属于, 加入, 任职…) in the scored text gave no gain either.
- **An ordering step.** `ordinalInQuestion` reads "第N起/个/次…", "最近/最新…", "最早/首…", "上一起/前一次" and "the first … / the latest / the one before". From the ordinal's own clause only, it also reads:
  - a period: "今年 / this year", "本月 / this month", or a year written there ("周岚2024年加入清算组，清算组今年第一起事故" orders this year's);
  - "最严重 / most severe";
  - a named level (P1, SEV2).

  The first hop at which one entity leads to two or more of the noun the ordinal is about (the first predicate family after it: 故障 → 事故) is ordered, over all of that entity's relations, read again in full up to 2000. More than that and no pick is made: the note says the set was too large. Each branch keeps the one the question names and drops the others it ordered.
  - **Dates:** a candidate is dated by the event asked about: the claims and relations that state it (the spellings of the ordinal's noun), the latest of them for "the latest", the earliest for "the first". A product released in 2019 and again in 2026 was last released in 2026. When nothing states the event, it is dated by first sight (marked so): the earliest date its claims state, else its relations' starts, else the date of the earliest document that mentions it.
  - **Levels:** a candidate's level is the one its earliest claim states, dating an undated claim by its document. The reports contradict themselves: "本周新增P2事故INC-004-T1" in the week, "级别为P1" in the month's summary, so the week wins.
  - **Periods:** a relative period is read against the present: the day the question says it is asked as of ("截至2025年5月21日", "as of 2025-05-21"), else the now its caller gives (`ask`'s `now`, the option design 34 added for computed sets), else the clock's.
    - A knowledge base behind the clock is not read as current: when its "今年" holds nothing, the note says so and gives its latest source, for example "0 candidates are dated in 2027 (this year: the caller's now, 2027-03-01); the knowledge base has no source dated in 2027 (its latest: 2026-…)".
    - An evaluation of a past corpus passes its own now; the 10× reports are measured with now = 2025-12-31. `src/eval` does not yet pass one to `ask`.
    - From 2026-11-16 to its recheck the present was the knowledge base's latest source; before that, the latest year the candidates themselves were dated in.
  - **Missing dates:** a candidate with no date is left out of the order and counted in the note. When fewer remain than the position asks for, nothing is picked, and the walk goes on as if the question had not ordered.
  - **What the answer is told:** every branch's pick, or why there was none, with the order made ("in order: INC-001-T1 (2025-02-03), …"). It goes to the answer as a computed fact, apart from the sources' facts ("Ordered by the walk from the dates the sources state (no source states this order): 第二起 — 第一事业部平台组: INC-003-T1 — the 2nd of 4 P1 dated in 2025 …"), and in `route.walked.ordering`. The relation's own fact no longer carries the pick.
- **The kind of thing the question ends at.** The last clause, split at sentence ends and commas but not at a dash, may name an entity type: 项目 → project; 组 / 团队 → organization; 事故 / 故障 / 事件 → event. The words come from the ontology's type labels plus these nouns. 组 counts only as a word (那个组, 另一个组), not inside 组合, 组件 or 投资组合. A far end of that type then holds the cue like a term: "此人名下的那个项目" reaches 司命系统 rather than the heavier incident the person "负责修复". A person is never cued, because nearly every chain asks 谁. Cues from every clause pull early hops toward later clauses (deep-hop 10 → 6 chains).

**Measured 2026-11-16, after the review and its recheck.** Set-up:
- **The index:** a fresh no-model rebuild of the 10× workspace from its stored extractions (`src/bench/replay-build.ts`). All 2,014 relations record their source chunk and document.
- **Its vectors:** the run's own bge-m3 vectors: chunks from the run's vector cache by content, and 718 of 823 entities and 16,865 of 16,874 claims from the run's index by name and statement.
- **The run:** `ask()` with no model, the cached question vectors and now = 2025-12-31, ~18 questions per type.
- **The measures:**
  - hit@8 is a gold document among the first eight contexts;
  - gold-in-contexts is gold recall over all contexts;
  - a chain is complete when every bridge entity (customer codes left out) is named in the relations and claims among the facts. The walk's ordering lines, which list candidates by name, are not counted.

| type | hit@8 | gold in contexts | bridges named | chains complete |
|---|---|---|---|---|
| deep-hop, main 7a299bf | 0.89 | 0.31 | 0.86 | 11 / 18 |
| deep-hop, after the review (b8243cf) | 0.83 | 0.31 | 0.87 | 12 / 18 |
| deep-hop, after the recheck | 0.72 | 0.29 | 0.87 | 12 / 18 |
| nonlexical-hop, main 7a299bf | 0.67 | 0.34 | 0.94 | 16 / 18 |
| nonlexical-hop, after the review (b8243cf) | 0.61 | 0.29 | 0.93 | 15 / 18 |
| nonlexical-hop, after the recheck | 0.56 | 0.29 | 0.93 | 15 / 18 |

Against its base (the computed-sets branch, 79793bf) the recheck's changes leave every other type's contexts, facts and route byte-identical.
- **hit@8 after the recheck.** Its fall is the price of showing the relation's own passage, in three questions (h5r-C0, d3-h5r-C4, nh-proj-INC-001-T1). Each has a gold weekly report that names both ends of a hop but is not the source recorded for the relation the walk took. "INC-001-T1列于平台组事故记录" was read from the monthly pmo-02; the gold is the week-5 report, which lists the incident under the group's own heading. Every relation in this index has a recorded source, so this is not missing sources.
- **After the review.** The two deep-hop questions lost (d8-h5, d10-h5) had their gold report among the top eight only as an old co-mention. The nonlexical chain lost (d9-nh-risk-INC-021-D9T3) has no "raised" relation for R-106 in the index; it completed only while 上报 matched another relation in the beam's spare slots.
- **Cost on the 10× index.** `ask` takes 41–44 statements per question on main, 55–63 now. It also runs the lookup route's graph search, excerpts and (when switched on) claim set.

Where the 9 incomplete chains stop:
- **Extraction (6).**
  - No fix relation INC-007-D2T1—林婷 or INC-001-D6T1—任杰.
  - No "raised" relation for 方艳—R-45 or 尹婷—R-106: the extracted relations only say who follows them.
  - No customer shared by INC-003-D3T1 and INC-012-D3T2, or by INC-003-D10T1 and INC-012-D10T2.
- **The walk (3).** A customer's second incident among its ~40 is not reached (h5r-C0, d3-h5r-C0, d10-h5r-C0). The anchor to the division competes with the meaning bonus among the customer's many incidents.

## 4. Fusion: optional rerank, current state

### Rerank

`retrieval.rerank` (off by default):

```json
"retrieval": {
  "rerank": {
    "enabled": true,
    "url": "http://127.0.0.1:<port>",
    "style": "tei",
    "model": "",
    "apiKey": "",
    "candidates": 30,
    "maxChars": 2000,
    "timeoutMs": 8000
  }
}
```

`src/search/rerank.ts` sends the first `candidates` fused hits (title and the first `maxChars` characters of each) to `POST {url}/rerank` and reorders them by the scores; the rest keep their fused order behind them. Two request styles, either answer shape:

- `tei` (Hugging Face text-embeddings-inference, e.g. `BAAI/bge-reranker-v2-m3`): `{query, texts, truncate}` → `[{index, score}]`;
- `openai` (the Jina / Cohere shape vLLM, Infinity and llama.cpp serve): `{model, query, documents, top_n}` → `{results: [{index, relevance_score}]}`.

A failed call (no server, timeout, wrong shape) leaves the fused order and is reported in `searchExplained`'s `channels.rerank.error`; the stage can only reorder. In SAG mode the walk's internal direct search is not reranked; its final results are. knode-os never starts the server: no new always-on service. Hits carry `signals.rerank`.

The setting is read where a caller passes it: `ask`, `knode_search`, and the benchmark's `knode-ask` / `knode-sag` retrieval. The web UI's search routes (`src/server/app.ts`) do not pass it yet.

### Current state

A passage is what a document said; a claim read off it may since have been replaced (`claims.superseded_by`, today set by wiki refinement for finance, being generalised by the claim-state work). Demoting the passage would hide history a question may ask for, so instead `searchExplained` attaches to each returned hit `current: [{was, now}]` — the superseded claim and the claim at the end of its chain, with date and source (`src/search/current.ts`; one query over the returned chunks, one per chain link, at most six). `knode_search` returns it, and `ask` lists the current claim among its facts as "… (replaces: …)". `current: false` skips it (the benchmark's retrieval-only systems do, since they score documents).

## 5. Typed claim columns

The claim-state work adds typed values to claims (suggested: `attribute`, `value_num`, `value_text`, `unit`, an effective date). `enumerate.ts` looks them up in `information_schema` once per store under the names in `CLAIM_TYPED_COLUMNS` and uses whichever exist: the effective date in the window test and the counts, and `attribute`, `value`, `unit` on each enumerated claim. Settling on other names is a change to that map; the catalog guide's `v_claims` line (`src/mcp/catalog-guide.ts`) should gain the columns once the view has them.

## 6. Agent tools

### Routing the agent

The MCP preamble (`src/mcp/instructions.ts`) and the benchmark brief (`knodeAgentBrief` in `src/eval/systems/knode.ts`) now route by question:

- lists, counts, filters, time ranges → `knode_claims` or `knode_query source="catalog"`, one call for the whole set;
- "who or what is X" → `knode_resolve`, then the entity's wiki page;
- passages → `knode_search` (`mode=sag` across a relation);
- exact strings, names, numbers → `knode_grep` with `context`;
- reading → several documents per `knode_read` call.

`knode_query` joins `KNODE_AGENT_TOOLS`. An agent cannot guess the catalog's schema, so the `knode_query` description and the brief carry `catalogGuide()`: the columns of `v_entities`, `v_claims`, `v_relations`, `v_evidence`, `v_mentions`, `v_documents` and three worked queries (claims about an entity in a year, documents per organization, sources of claims matching a word). A test runs each example against a fixture. The brief no longer inherits the grep baseline's "search and read the files with shell commands", which did not apply; it keeps that brief's opening and its budget of about 20 calls.

### Batched reads

`knode_read` takes `paths`: up to 20 entries, each a path or `{path, section?, offset?, limit?, outline?}`, sharing one budget of `max_chars` characters (default 60 000, at most 200 000). The budget is water-filled: every text shorter than an even share is read whole, the long ones split the rest, and a cut one ends with where to read on (`{"path": …, "offset": n}`). A path that cannot be read gets an `(error: …)` under its header instead of failing the call. The single-`path` form returns exactly what it did.

### Grep with context

`knode_grep` takes `paths` (several subtrees or files), `context` (0–20 lines around each match) and `max_per_file`. With `context` the answer is text grouped by file, as `grep -n -C` prints it (`12: match`, `13- context`, `--` between groups), at most 60 000 characters, files past that named. Without them it returns the JSON list it always did.

### Research and remote sessions

Research sessions (`src/research/launch.ts`) and remote sessions (`src/remote/session-mcp.ts`) register the same tools through `registerKnodeTools`, so the new parameters reach them unchanged: the remote session's guard looks only at `knode_write` and `knode_commit` arguments. Research sessions already had `knode_query`.

## Not done

- No benchmark run: the effect on the reports pack's calls and tokens and on `knode-ask`'s aggregate and deep-hop scores is unmeasured.
- The rerank stage was tested against a fake endpoint only; no bge-reranker was run.
- The web UI's search does not pass `retrieval.rerank`, and the settings UI does not show `retrieval.rerank` or `retrieval.router`.
- Multi-hop classification is by pattern; a question whose hop is implicit ("Where was the author of X born?" has no clause) stays a lookup unless `classifier: "model"`.
