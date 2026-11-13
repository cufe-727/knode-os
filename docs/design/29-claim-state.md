# 29 — Claim state: current values with history, supersession in every domain, a judge that pays only for doubt

> Status: **implemented** on branch `claude/claim-state-model-62617a` (2026‑11‑13), not merged or deployed.
> Code: `src/graph/claim-state.ts` (reading a claim as attribute + value), `src/graph/claim-state-store.ts` (backfill,
> per-subject keys, supersession), `src/graph/entity-context.ts` (renames and namesakes), `src/store/temporal.ts`
> (the fold's effective date), `src/graph/claim-dedupe.ts` (the judge pre-filter), `src/wiki/pages.ts` (the entity
> page), `src/graph/llm-extract.ts` + `src/graph/tier1.ts` (prompt and batching), schema v19 in
> `src/store/migrations.ts`. Tests: `tests/claim-state.test.ts`.

## 0. What was measured

The 2026‑11‑13 diagnosis of the corpus benchmark (`run-1x-ranking`) found the wiki accumulating claims instead of
compiling them. On the reports pack (weekly and monthly status reports of three teams):

- **Dates.** 57 of 1,111 fact lines on entity pages carried a date, 0 of 60 on the life pack. Of 51 comparable dated
  claims, 39 carried another date than their report's — a claim from the 2025‑09‑22 report dated 2025‑03‑03.
- **No state.** The page for 风控引擎 listed 46 lines of "完成度为N%" under "Facts (current)". Supersession only ran
  for finance types (`CLAIM_TYPES.supersedes`) with a stated `valid_from`, so a report's progress, headcount or owner
  never replaced the previous week's.
- **Judge waste.** The duplicate-claim audit (kb-judge) cost 358 calls and 4.28M of the build's 7.20M weighted tokens
  for one merged claim: successive values of one series were judged as candidate duplicates.
- **Entities.** Two people named 陈伟 (支付组, 平台组) were one entity (114 claims from 93 documents); Atlas, renamed
  Orion, stayed two pages; refine reported `mergeCandidates: 0`.
- **Extraction.** About 20k weighted tokens per call for a 1,200-character report; the life pack's 168 chats became
  171 claims.

### Why the dates were wrong

The model's dates were mostly right: reading the run's tier‑1 sidecars, 2,166 of 2,340 stated dates fall in the
month of their document. The fold made them wrong. A claim's id is its subject plus its statement, so "支付组在岗人数为
7人" said in week 5 and week 38 is one claim, and the fold took `valid_from = MIN` and `observed_at = MIN` over its
evidence while the page named the *earliest-written* source (`primary_scope_id`, by ingestion order). The week‑38
line was shown with week 5's date and some third report as its source. A duplicate merge (kb-judge) did the same to
the whole group. Week numbers ("第35周", `2025-W35`) were not parsed at all, so plans dated by week had no date.

## 1. The model

A claim keeps its statement and gains its **state** (schema v19, additive, columns on `claims`):

| column | |
|---|---|
| `attribute` | the key of the measure or state the claim gives a value of (`进度`, `在岗人数`, `负责人`, `计划上线`, `营业收入`) — null for a claim that is no measure |
| `value_num` / `value_text`, `unit` | the value: a number with its unit (`%`, `人`, `亿元`), or a text (a person, a stage, a planned week `2025-W35`) |
| `effective_at` | the date the claim speaks of |
| `date_source` | `stated` (the source dates it: event date, else start of its window) or `document` (its document's date) |
| `effective_scope_id` | the scope of the supporter that gave `effective_at`, so a line's date and its source agree |
| `correction` | the claim corrects an earlier report |
| `state_v` | the reader version the row was read with (NULL: not yet) |

**Effective date.** Each supporter (evidence row) has its own date — the date it states, else its document's — and
the claim's is the newest of them. A value repeated in a later report is dated by that report, and the page names
that report. `valid_from`/`valid_to`/`observed_at` keep their old fold (MIN, window union) for what reads them.

**Reading the attribute** (`claim-state.ts`). The extractor is asked for `attribute`, `value`, `unit` and `corrects`
with each claim. Where it gives none (sidecars from before, frontmatter, a model that left them out) the statement
is read without a model call: the first number with a unit (or after a link word: 为, 是, 达到, `is`, `reached`) that
is not part of a date, ticket or code (`2025年`, `第35周`, `T2-1420`, `R-05`); the attribute is the clause before
it, minus the subject's name (and "项目"/"系统" after it), date and period words (`本周`, `7月月报中`, `2026Q2`,
`去年同期`), hedges (`可能`, `初步估计`) and function words. "由X负责", "计划于…第N周上线" and "<负责人|状态|阶段>为X"
give text values. A key that is not a short name (a clause, a digit, an aspect particle) gives no attribute: the
claim stays an ordinary fact. On the reports pack's 2,768 sidecar claims this reads 847 (计划上线 216, 进度 202,
在岗人数 171, 负责人 114, 支付成功率 48, 服务可用性 48, 周活跃用户 48).

**Keys.** A global synonym table maps spellings to one key per language (完成度 / 完成率 / 进度 → 进度; 在岗 / 在岗人员 /
人数 → 在岗人数; `completion` → `progress`). Refine then unifies each subject's remaining near-synonyms without a model
call (`unifyAttributeKeys`): two keys of one subject and one unit join when one contains the other (周活跃用户 /
周活跃用户数) or their bigrams mostly agree (Dice ≥ 0.67); the most used names the group. The mapping lives in
`claim_attribute_keys (subject_id, attribute, canonical, reason)`; `v_claims`, supersession, the duplicate audit and
the page read the canonical key through it, so the fold never has to know it.

**Where it is computed.** The fold computes the state of every claim it folds (it reads the subject's name for the
statement reader). Rows folded before v19 are read lazily by refine (`backfillClaimState`, 50,000 a run, only the
state columns, no refold). Nothing in the migration rewrites a row: every column is added without a default or with
a constant one, the one new index is partial, and `v_claims` falls back to `COALESCE(event_at, valid_from,
observed_at)` and a derived `date_source` for rows not yet read.

`v_claims` appends, after its old columns: `attribute` (canonical), `value_num`, `value_text`, `unit`,
`effective_at`, `date_source`, `correction`, `effective_source_path`.

## 2. Supersession

`markSupersededClaims` (refine's claim audit) now runs two rules:

1. **By attribute, in every domain** (`supersedeByAttribute`). A series is the live claims of one canonical subject,
   one canonical attribute, one object and one kind (facts and forecasts apart — a plan is superseded by a later
   plan, never by the result), status fact or suspected. Ordered by effective day, each claim is superseded by the
   first claim of the next later day — unless its own stated window still covers that day. Claims of one day with
   different values supersede none of each other: a disagreement stays visible. A **correction** (`correction`:
   the model's `corrects`, or 更正 / 勘误 / 有误 / 应为 / "corrected" in the statement) supersedes the newest claim of
   its series up to its own date whose value differs from its own — the report it corrects — whatever the order says.
   Marks are recomputed per series each run and written in one batched statement.
2. **The old rule** for claims with no attribute: facts of a `supersedes` type ordered by `valid_from`, as before.

So finance keeps its behaviour where no attribute is read, and gains it where one is (a stock's price, a holding's
share, a quarter's revenue — the latest period is current, the older ones history). The one finance test whose
numbers moved (`tests/temporal-claims.test.ts`) now also supersedes the year-ago quarter's revenue by this quarter's.

## 3. The page

`entity_stub` (version 6):

- **Current state**: per attribute (forecasts marked "plan / forecast"), the current value with its date (`2025-06-09`,
  or `as of 2025-06-09` when only the document dates it), status if not plain fact, "(corrected)", and the source that
  dated it; then one line of history: `history: 71% (2025-06-02), 68% (2025-05-26), …; 12 earlier`.
- **Facts (current)** and **Views and forecasts**: the claims with no attribute, not superseded, each with its date.
- **Timeline**: what the sources date themselves (`date_source = stated`), by effective date; a measure's values are
  its history above, not timeline entries.
- An entity that others were merged into (a rename, a duplicate) lists their claims too.

## 4. The judge pre-filter

Before a candidate pair reaches the judge (`claim-dedupe.ts`), two rules settle it without a call:

- **Series** (`seriesRelation`): same canonical subject, attribute, object and kind — other effective days →
  `different_time`; one day and the same value (numbers at the coarser precision, texts folded) → `same`, merged like
  an identical pair. One day with two values is a real question and goes to the judge.
- **Reports apart** (`reportedApart`): two claims only their documents date, on different days, neither naming a
  period (`2025年`, `Q3` …), whose figures differ — "陈伟迁移历史数据第7批" / "…第2批" — are two weeks' work:
  `different_time`.

Both verdicts are remembered like the judge's (`claim_pair_verdicts`, model `rule`). `auditDuplicateClaims(…,
{ stateRules: false })` reproduces the audit without them, for measurement. On the test fixture (12 weekly reports of
one team and 8 of another, `tests/claim-state.test.ts`): **9 judge calls / 105 pairs before, 0 / 0 after**.

## 5. Entities

Run by refine before the duplicate audit (`resolveEntityContext`), deterministic, each decision with its reason:

- **Rename → merge.** A live fact whose statement reads as a rename — `X…更名为/改名为 Y`, `Y（原X）`, `Y, formerly X`,
  `renamed to`, `now known as` — where both names are live entities of compatible types: the old merges into the new
  (`applyMerge`, actor `entity-context`, reason `更名：「statement」（source）`; reversible with `entities unmerge`).
  Skipped when a person undid such a merge or rejected the suggestion themselves.
- **Alias list → suggestion only.** An entity whose alias list names another live entity of the same specific type is
  filed as a merge suggestion with that reason, outside the audit's 50-a-run cap; an extraction can file 创业板 under
  A股, so aliases alone never merge.
- **Namesakes → split.** For a person with 6–600 documents, documents join when their co-mentioned people, teams,
  projects and products mostly agree (Jaccard ≥ 0.3). It is two people only when all hold: two clusters cover ≥ 90%
  of the documents, the smaller ≥ 3 documents and ≥ 15%; the clusters' contexts barely meet (Jaccard < 0.25); each
  has an anchor — an organization or project in ≥ 60% of its documents and ≤ 5% of the other's; and their date ranges
  overlap by ≥ 30% of the shorter, so a person who moved teams (one context before, another after) is not split. The
  smaller cluster becomes `陈伟（平台组）` (id `陈伟平台组`): a row in `entity_namesakes` (anchors of both sides, the
  documents, the reason), its documents' tier‑1 extractions re-applied from their sidecars (no model call; a document
  without a whole sidecar is left as it is), and the pair recorded as a decided (rejected) merge so the duplicate audit
  never proposes it. From then on `applyExtraction` resolves the name to the person whose anchors the document's own
  entities name (`namesakeChoice`), else the original.

## 6. Extraction

- **Prompt.** The ontology is listed one short line per type (no domain → range, at most three examples), the claim
  types with at most three examples, and the rules tightened; it adds `attribute`/`value`/`unit`/`corrects`, week
  dates, "only dates the text states or implies; null when it simply holds as of the document date", and that plans,
  appointments, health, moods, money, preferences and relationships in chats and diaries are information. The
  instruction block for a 1,200-character report went from 7,621 to 6,166 characters while asking for more.
- **Batching.** Up to 8 single-segment documents under 4,000 characters go in one call (`buildBatchExtractRequest`),
  each under its own header and date, answered as `{"documents":[{"doc":1,…}]}`; each keeps its own sidecar result, a
  document the reply leaves out (or every document, when the call fails or the model answers one document only) is
  read on its own in the same pass, a document that failed before is retried alone, and a plugin that shapes requests
  still sees one document a request.
  Reimplemented from the unmerged `claude/knowledge-base-optimization-a84c37` (3b5f536). On the fixture's 21 short
  reports: 3 calls instead of 21, and under a fifth of the characters (the test asserts < 20%). With a CLI model's
  ~14k-token preamble per call, the preamble alone falls by 7× on such a pack.

## 7. Not done

- The labeling scheduler `serve` runs (src/labeling) still extracts one document a call; batching is in
  `runTier1Pass` (used by `extract`, the document pass, eval builds).
- No model-backed measurement: the call and token reductions above are on fixtures; the reports and life packs were not
  rebuilt.
- A rename absorbed at write time (the new name extracted with the old as alias, resolved onto the old entity) keeps the
  old name as the entity's name; only two separate entities are merged.
- No summary pages on either benchmark pack is configuration, not a fault: every report (~1,300 characters) and chat
  is under `extraction.summaryMinChars` (1,500 by default). Lowering it for such packs is the eval runner's choice;
  the entity pages now carry the state either way.
- The Postgres migration test was skipped here (no server configured for tests); the migration is plain additive DDL.
