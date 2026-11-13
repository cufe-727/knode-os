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

The order of the tests is the order of the table from the bottom up: timeline beats aggregate beats list beats multihop, since "how many companies that…" is a count first. The question's time window (`in 2025`, `March 2026`, `since 2024`, `between 2024 and 2025`, `2026Q2`, `2026年3月`, `2026年上半年`) is read by `questionRange` into ISO instants through the same parser `valid_range` uses.

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

`src/search/walk.ts` starts from the entities the question names and, for at most `retrieval.router.maxHops` hops (3), reads their live relations, keeps the five whose type, description or far end share the question's terms (heaviest first among equals; past the first hop only relations that match the question lead on), and moves to the far ends. For each relation kept it reads one passage where both ends are mentioned together: the sentence that states the hop.

`ask` then answers from a SAG search (design 04: chunk → entity → chunk expansion) plus those bridge passages, with the walked relations listed first among the facts ("Nimbus Freight acquired Borealis Logistics: … — raw/docs/deal.md") and the claims about every entity reached. Still one completion: the walk needs no model, because its scoring is the question's own terms.

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
