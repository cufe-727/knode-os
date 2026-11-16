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
| multihop (`rule:chain`) | a chain across clauses: one part asks for, describes or labels something unnamed (谁, 哪个项目, 提出R-03的人, 一起事故, …记作甲, who, an engineer) and a later clause refers back to it (此人, 那个项目, 同一个客户, 新负责人, 甲, that person; a bare 他 / it / they only after a clause that opens with the question word) | SAG search + relation walk |

The order of the tests is the order of the table from the bottom up: timeline beats aggregate beats list beats multihop, since "how many companies that…" is a count first. The chain rule is the exception: it comes after timeline and before the counts and lists, because what those would enumerate ("他今年修复过哪些事故") is the thing the question has yet to find. A question that is both a count or list and a chain goes where the cue stands: a count or list before the back-reference is what finds the thing ("哪家公司今年营收最高，它的净利润…", "List all incidents in 2025. Who fixed them?"), so it keeps the count or list route; one after it is asked of the thing found, so the walk takes it. Plural back-references (它们, they after a list), pronouns for a named entity, word fragments (的人均, 的人工智能) and a storytelling 一个 are not chains (review of 2026-11-16). Added 2026-11-15: in the 10× reports benchmark every deep-hop and nonlexical-hop question (184) had reached `lookup`, and the chain rule moves those and no other question of the pack (1,896 questions) to the walk. The question's time window (`in 2025`, `March 2026`, `since 2024`, `between 2024 and 2025`, `2026Q2`, `2026年3月`, `2026年上半年`) is read by `questionRange` into ISO instants through the same parser `valid_range` uses.

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

`src/search/walk.ts` starts from the entities the question names and, for at most `retrieval.router.maxHops` hops (4; 3 before 2026-11-15, and a workspace whose config holds 3 keeps it), reads the live relations of every entity on the frontier (the heaviest 150 of each, so a hub cannot crowd out the one relation a person has), scores them, and moves to the far ends of the ones it keeps. A relation scores by
- the question's terms that its type, description and far end hold. The near end's own name is left out of the description, the spellings of the named entities are left out of the question (事业部 of 第七事业部 would match every sibling group), and each predicate the question uses is widened to its other spellings (处理好 / 修复 / fixed, 名下 / 盯着 / 负责, 投产 / 上线, 预警 / 提出, 隐患 / 风险, 故障 / 事故, 调到 / 调入, 接手, 升级 / 投诉: verbs and relation nouns, no domain words). Each term weighs by how few of the hop's candidates hold it, and a branch may use a term only as often as the question does: 升级 twice in "修复过一起…升级的事故…另一个组升级过事故", once in "升级的那起事故", so an escalation does not lead to the customer's next escalation unless the question asks for it.
- its far end lying within two relations of another entity the question names than the one its branch started from. "（第七事业部）华鼎零售升级的那起P1事故" then prefers the customer's incident whose group belongs to the seventh division over its heavier incidents in other divisions. Each named entity weighs as a term does, by how few candidates it anchors.

Every branch takes its best step and the five best of the rest join it (five on the first hop), so a hop holds at most ten. Past the first hop only a relation that holds a term or is anchored leads on. For each relation kept the walk reads one passage where both ends are mentioned together: the sentence that states the hop. The passages are ordered by chain: the best-scored step (scores add up along a branch) with the steps that led to it, from the first hop down, then the next best.

`ask` then answers from a SAG search (design 04: chunk → entity → chunk expansion) plus those bridge passages. The top eight are the search's first four and the walk's first four, then the rest of each up to twelve: a chain's later hops are rarely what a search of the whole question finds. The walked relations are listed first among the facts ("Nimbus Freight acquired Borealis Logistics: … — raw/docs/deal.md"), with the claims about every entity reached. Still one completion: the walk needs no model, because its scoring is the question's own terms and the graph around the named entities.

A first measurement (2026-11-15, the copy of the run's 10× index): deep-hop hit@8 0.22 → 0.72, complete chains 1 → 10 of 18; nonlexical-hop 0 → 5 complete chains, but hit@8 stayed at 0.06. From the division alone the walk could not tell which group or which incident was meant.

### 3.1 Non-lexical hops (added 2026-11-15)

A non-lexical question names only the division and describes the rest: "第一事业部管基础设施的那个组今年第二起最严重一档的故障，是谁处理好的？此人曾预警过一个隐患，眼下是谁在盯着那个隐患？". The reports never say 基础设施, 收款 or 拉新, so no term matches the group. "第二起" is an ordering over dated events, not a relation. Four additions answer it, all in the walk (`src/search/walk.ts`, `src/search/walk-order.ts`):

- **An entity described, not named.** `ask` passes the question's embedding and model (`multihopAnswer`, one line). Among the relations of one type from one entity (a division's three `part_of` groups), a far end whose entity embedding (name, type, aliases, description) lies above its siblings' mean cosine to the question gains one point per standard deviation. On the benchmark the nearest group is the described one in 13 of 17 divisions, with small margins, so this is a preference, not a filter. It also orders the chains, so the described group's chain gives the first passages.
- **An ordering step.** `ordinalInQuestion` reads "第N起/个/次…", "最近/最新…", "最早/首…", "上一起/前一次" and "the first … / the latest / the one before". It also reads the period around it ("今年 / this year", "本月 / this month", an explicit year), "最严重 / most severe" and a named level (P1, SEV2). The first hop at which one entity leads to two or more of the noun the ordinal is about (the first predicate family after it: 故障 → 事故) is ordered. Each such branch keeps the one the question names and drops the others it ordered; the step carries the note ("[picked as the 2nd of 4 P1 dated in 2025, by date (2025-04-28)]"), and so does its fact.
  - **Dates:** a candidate's date is the earliest its own claims state, else the earliest start of its relations, else the date of the earliest document that mentions it. A document's date is its own, or the earliest its claims state.
  - **Levels:** a candidate's level is the one its earliest claim states, dating an undated claim by its document. The reports contradict themselves: "本周新增P2事故INC-004-T1" in the week, "级别为P1" in the month's summary, so the week wins.
  - **Periods:** "今年" is the latest year the candidates are dated in; the relative words are not read against today.
  - **Missing dates:** a candidate with no date is left out of the order and counted in the note. When fewer remain than the position asks for, nothing is picked: the note says "not ordered: 第三起 asks for the 3rd, 2 P1 candidates are dated in 2025 (1 have no date)", and the walk goes on as if the question had not ordered.
- **The kind of thing the question ends at.** The last clause, split at sentence ends and commas but not at a dash, may name an entity type: 项目 → project; 组 / 团队 → organization; 事故 / 故障 / 事件 → event. The words come from the ontology's type labels plus these nouns. A far end of that type then holds the cue like a term. "此人名下的那个项目" then reaches 司命系统 rather than the heavier incident the person "负责修复". A person is never cued, because nearly every chain asks 谁. Cues from every clause were measured and pull early hops toward later clauses (deep-hop 10 → 6 chains).
- **The passage that states a hop:** of the chunks mentioning both ends, the one in the earliest dated document, the relation's own document first among equals. That is the report of the week it happened, not a monthly summary restating it. The relation's own document alone (v20 relation sources) did worse: it is often the summary.

Tried and dropped, measured on the same copy:
- The ontology's relation-type labels and synonyms (属于, 加入, 任职…) added to the scored text: no gain, one deep-hop question worse. Most relations here are `related_to`.
- Matching the relation's wording by meaning, through the best cosine of the question to the claims that join the same two entities (70% of relations have one): deep-hop complete chains 11 → 9.
- The predicate families (处理好 / 修复 …) stay the wording match.

**Measured 2026-11-15.** Set-up: a fresh no-model rebuild of the 10× workspace from its stored extractions (`src/bench/replay-build.ts` on main 7f44c8f), given the run's own bge-m3 vectors: chunks from the run's vector cache by content, and 704 of 806 entities and 16,865 of 16,874 claims from the run's index by name and statement. Then `ask()` with no model and the cached question vectors, ~18 questions per type. hit@8 is a gold document among the first eight contexts; gold-in-contexts is gold recall over all contexts; a chain is complete when every bridge entity (customer codes left out) is named in the facts.

| type | hit@8 | gold in contexts | bridges named | chains complete |
|---|---|---|---|---|
| deep-hop, main | 0.78 | 0.28 | 0.77 | 10 / 18 |
| deep-hop, this change | **0.89** | **0.32** | **0.84** | **11 / 18** |
| nonlexical-hop, main | 0.11 | 0.08 | 0.37 | 5 / 18 |
| nonlexical-hop, this change | **0.56** | **0.27** | **0.81** | **12 / 18** |

All 196 questions of the other eleven types have byte-identical contexts, facts and route. The walk alone (same process, median of 3 runs) takes ~155 ms and 13–16 statements per question, against ~20 ms and 6–7 on main. Most of the increase is the passage choice (the co-mention read and the document dates) and the meaning read per hop. The whole `ask` measured 250–285 ms against 133–185 ms, but under a machine load that also moved the unchanged types from 188 to 272 ms.

Where the 13 incomplete chains stop:
- **Extraction (8 chains).** No fix relation INC-007-D2T1—林婷, 陈平—INC-003-D3T1, INC-001-D6T1—任杰. No "raised" relation for 方艳—R-45, 汤婷—R-58 or 尹婷—R-106: the reports' extracted relations only say who follows them. No customer shared by INC-003-D4T1 and INC-012-D4T2, or by INC-003-D10T1 and INC-012-D10T2.
- **Entity resolution (3 chains).** Incident codes of different divisions are merged: INC-017-D6T3 into INC-017-D7T3, INC-010-D10T2 into the concept 退款卡单. 九部增长组's incident list holds INC-015-D7T3 and INC-017-D7T3, so its "second P1" is the wrong one.
- **The walk (2 chains).** The customer's second incident among its ~40 is missed in h5r-C0 and d3-h5r-C0. h5r-C0 was complete on main: there the meaning preference among the customer's many incidents outweighs the division anchor. Capping it at one point measured the same in total.

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
