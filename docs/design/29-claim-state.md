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

### 2.1 When it runs: refine, and the end of every document pass (2026‑11‑15)

Both rules ran in refine alone, once a night over every claim. Between two refines each report added left its value
current beside the earlier ones: on the 10× separation benchmark a team's weekly metric had five current values after
four update batches, and an agent asked for the latest value had five to pick from.

A document pass (`runDocumentPass`, src/ingest/background.ts) now ends its claim step with `supersedeForClaims`
(src/wiki/refine.ts) for the claims it wrote: their subjects, with the entities merged into them, get their attribute
keys unified again (`refreshAttributeKeys`, for those subjects) and both rules run over their series; marks whose
superseder is gone are cleared within them. No model call. It reads the attributed claims of the subjects touched,
not of the workspace: on the 10× index the four update batches' 1,757 claims touched 251 subjects and changed 524
marks in 0.57 s, and refine's run over every claim then found nothing left to change. Run twice for the same claims
it changes nothing (`tests/claim-state.test.ts`).

**No setting, on purpose.** Refine has none either: supersession runs whenever refine runs, and the only switch is
the nightly schedule (`dream.schedule`), which turns off the whole pass — the audits, the judge, the reviews — and is
turned off for their cost, not to keep old values current. The step after a pass does not follow that schedule: a
workspace whose nightly pass is off is the one where a value would otherwise stay stale until somebody turns it
back on. It runs where extraction runs (a pass that writes no claim does not run it), and what it writes is derived
state that refine recomputes whole: `claims.superseded_by` and `claim_attribute_keys`, never a claim, its evidence or
its text.

**What changes for an existing workspace** (the release note):

- From its first document pass after the update that writes a claim, the subjects of that pass's claims have one
  current value per attribute; their older values become history (`superseded_by` set), as refine would have marked
  them at night. A workspace whose nightly pass is off — where nothing has been marked since it was turned off —
  catches up subject by subject, as documents about each subject arrive; subjects no new document speaks of keep
  their marks until refine runs.
- Readers that hide superseded claims (`knode_claims` and `v_claims … WHERE superseded_by IS NULL`, the entity page's
  "Current state", `SearchResult.current`) show the new value alone sooner: after the pass, not after the night.
- Entity pages, timelines and summary pages of those subjects are regenerated when their marks change (their input
  hash holds `superseded_by`), so a pass that marks claims rewrites those pages at the next sync.
- Not covered: a document removed by sync. When the current claim goes with its document, the older claims stay
  marked superseded until refine clears the marks. Refine's entity rules (renames, namesakes, §5) still run only
  in refine, so a series split across a renamed entity is joined at night.

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
  `renamed to`, `now known as` — merges the old name into the new (`applyMerge`, actor `entity-context`, reason
  `更名：「statement」（source）`; reversible with `entities unmerge`) when all of this holds:
  - **The statement names the old name where the renamed thing stands**: at the head of the marker's own clause
    (`万业企业后更名为先导基电`), after a reporting verb (`文中称Clawdbot现已更名为…`), a possessive
    (`阿里巴巴的通义千问已经改名为千问`), or 将/把/由 (`将Sales Cloud更名为…` renames Sales Cloud, not whoever did it), or in
    a "formerly" form (`Orion（原Atlas）`, `原项目名Atlas，自本周起改名为Orion`). Between the name and the marker only a
    date or an adverb may stand (`自2025-02-05所在周起`, `于2019年`, `已`, `后来`, `正式`, `was`). A clause that names
    nothing — `…，并于2017年更名为X`, `将其更名为X`, `该子公司于2024年更名为X`, `标的随后更名为X` — gives no merge; a name
    that only occurs earlier in the sentence is never taken.
  - **Each of the two spellings is the own name of one live, unmerged entity**, as written, with the noun that says
    what it is taken off (`Atlas项目`), or with a corporate form taken off either side (`隆基股份` names 隆基). An alias
    does not count: 华融国际信托 already lists 兴宝国际信托, and a parent may list a subsidiary's name. The new name is
    read whole (`Oracle AI Database`, not `Oracle`).
  - **Same specific type** (neither `concept` nor `other`), **and neither is a generic word or a weak spelling**: the
    stop list's words, a few the rule adds (上市公司, 子公司, 标的, 品牌, 指数…), a two-letter Latin spelling; for the
    old name also a corpus-frequent term.
  - **The claim is filed under one of the two**, as its subject or its object.
  - **The rename happened**: `拟更名为`, `计划更名为`, `将改名为`, `建议将…更名为`, `尚未更名为`, `will be renamed to`
    merge nothing: until it happens the old name is the name, and the statement that it happened merges then.
  - Nobody refused it: a person undid such a merge or rejected the suggestion themselves.

  The first version took, when the statement gave no old name, the longest live entity name written anywhere before
  the marker. On a copy of finance (2026‑11‑13, 110,309 entities, 142 such claims) that made 39 merges: 发展 (12,753
  mentions) into 乐聚机器人, 公司 into Megaspeed, 国际, 上市公司, 手机, 公告 and 阳光 into one company each, and 大族激光,
  赛力斯 and 东芝 into what a subsidiary or a brand of theirs was renamed to. Under the rule above the same claims
  give 8: six of the 39 (隆基 → 隆基绿能, Clawdbot → OpenClaw, 通义千问 → 千问, 竞价打板承接模式 → 竞价抢筹盘口, 万业企业 →
  先导基电, 花王股份 → 顺景科技) and two the old reading of the new name missed (阿里影业 → 大麦娱乐, Incitec Pivot →
  Dyno Nobel). It gives up seven that named the right pair for a reason the rule no longer accepts: three planned
  (龙净环保, 青松股份, 巴里克黄金), one whose new name is only an alias (海联讯 → 海联), one whose old name is written
  with its owner (阿里通义 → Qwen), and two that were right by accident (甲骨文 → Oracle from a statement about its
  database, 洲际交易所 → ICE from one about an index). `tests/rename-rule.test.ts` holds the statements.
- **Alias list → suggestion only.** An entity whose alias list names another live entity of the same specific type is
  filed as a merge suggestion with that reason; an extraction can file 创业板 under A股, so aliases alone never merge.
  A weak alias (two Latin letters, a short number, a stop word) proposes nothing, as in the duplicate audit. The rest
  are ranked — pairs that list each other first, then the pair whose less-mentioned side is mentioned most — and a
  run files 50 (`ALIAS_SUGGESTIONS_PER_RUN`), beside the audit's own 50: unbounded, the first run at finance size
  would have filed 5,873 beside 2,940 already pending. Finance holds 9,084 such pairs, 5,672 not yet filed (1,067
  listing each other), so the queue grows by 50 a night at most and the pairs a person is likeliest to accept come
  first. Not ranked out: a pair whose surviving name is itself a generic entity (航天发展 → 发展).
- **Namesakes → split.** For a person with 6–600 documents, documents join when their co-mentioned people, teams,
  projects and products mostly agree (Jaccard ≥ 0.3). It is two people only when all hold: two clusters cover ≥ 90%
  of the documents, the smaller ≥ 3 documents and ≥ 15%; the clusters' contexts barely meet (Jaccard < 0.25); each
  has an anchor — an organization or project in ≥ 60% of its documents and ≤ 5% of the other's; and their date ranges
  overlap by ≥ 30% of the shorter, so a person who moved teams (one context before, another after) is not split. The
  smaller cluster becomes `陈伟（平台组）` (id `陈伟平台组`): a row in `entity_namesakes` (anchors of both sides, the
  documents, the reason), its documents' tier‑1 extractions re-applied from their sidecars (no model call; a document
  without a whole sidecar is left as it is), and the pair recorded as a decided (rejected) merge so the duplicate audit
  never proposes it. From then on resolution lands the name on the person the document means (below), else the
  original. Since 2026-11-15 the rule also needs at least half of each cluster's documents dated, both clusters
  mostly in one language, and documents that are not one cluster's first and then the other's (`sequentialShare`
  < 0.7): once documents had dates, the range test alone split 13 people on the 10× benchmark who had changed teams
  and were named months later in their old team's incident reviews.
- **Same name, different thing (2026-11-15, `src/graph/identity.ts`).** On the 10× benchmark (ten divisions with the
  same team structure) write-time resolution, which merges on slug or alias-key equality, made 9 entities of 90
  settings and one of every person name two teams share: B-cubed precision 0.60 by the suite's score, 0.125 over the
  settings' mentions. What an extraction records for a mention tells them apart — a *code* among its spellings
  (`D7T1-C1`; one token of Latin letters and digits, leading zeros dropped), its *owner* (the target of a
  hierarchical relation stated for it) and the *anchors* of its document (the organizations and projects it names).
  - *Nothing is parted when a document is written.* One document cannot tell ten divisions' settings from kinds
    listed as aliases: on finance (27,398 extractions) 1,848 names have two or more owners and 325 carry two codes
    of one shape, nearly all of them one thing (`DRAM` with DDR4 and DDR5, `00700.HK` and `700.HK`). A first
    version parted at write time; a review reproduced a second `DRAM` from three notes of one maker and one of
    another, and one `DRAM` from the same notes in the other order. A name is parted only by refine, which sees all
    of its documents, so the outcome does not depend on the order they arrive in.
  - *`review.identity`.* `"name"` (the default): refine does what it did before — people only, documents dated.
    `"context"`, which a workspace turns on, adds what follows.
  - *What a workspace on the default sees after upgrading.* Nothing changes when it opens, and no entity is parted
    by a code. A raw document that is new, changed or indexed again gets a date from a dateline at its top when
    frontmatter and path give none; documents already indexed are re-dated on the next sync pass (*Re-dating* below). As documents gain dates that way, refine
    may split a person name whose reports fall into two teams at the same time — it logs `entities: X split —
    reason`, the second person appears as `X（team）`, and `knode-os entities merge <X（team）> <X>` puts them back
    for good. A name already parted (by an earlier split) keeps resolving to its entities, in mentions and in the
    links a document's text makes to it.
  - *Coded split* (`splitCoded`, `"context"` only, types `component` and `other`: an instance, not a category). A
    code is written once or twice, where the thing is introduced, so the documents that carry a code seed a group
    and a document without one joins the group it is most like (Jaccard ≥ 0.3 with one of its documents, and with
    no other group's as much). An entity is parted when two or more codes that differ as identifiers of one kind do
    each have a group of ≥ 2 documents with an anchor of its own — in ≥ 60% of its documents, ≤ 5% of the other
    groups', and in no document that carries another of the codes — and the roofs account for ≥ 80% of the entity's
    documents. Each becomes `name（roof · code）` — `日志保留天数（七部平台组 · D7T1-C2）` — and its documents are
    re-applied from the sidecars, their tier-0 links re-made. When every document goes with a code, the one with the
    most documents keeps the entity, on record as a row whose `id` is its `base_id`: later runs never move it, so
    the entity keeps its id, its claim ids, its page and a person's corrections.
  - *One roof under two names.* Co-mentions are read as the entities they were merged into, and two entities the
    duplicate audit has a pending pair for (三星 / Samsung Electronics: the judge called them the same below its
    merge threshold, or nobody has judged yet) count as one roof in both splits, which refine runs after the audit.
    Where the audit has not paired them, nothing says they are one.
  - *People* (`"context"` only): a document with no date is dated by the median of the dates its claims state, and
    the two contexts are compared over the entities in ≥ 20% of each cluster's documents (two teams that each name
    a customer once are still two contexts).
  - *Following* (`namesakeFor`, always on): a mention that lands on a parted name goes to the entity labelled with
    its code; else the one the split gave its document to; else the base entity if it carries the code the base is
    named by; else, among entities whose code does not differ from one it carries, the one whose anchors name its
    owner, then the one whose anchors its document names most (more than the base entity's, and no other as many);
    else the base entity. Right after the code comes a spelling that, among the name's entities, only one parted
    entity carries: that alias means that entity. Roofs are compared as the live entities their names stand for (an alias, a merged
    spelling), not as strings. Tier-0 links follow the same way.
  - *What a person sees, and undoing it.* A split logs `entities: X split — reason`, writes `entity_namesakes`
    (reason, documents) and a rejected merge suggestion for the pair; the parted entity appears as `X（roof · code）`
    or `X（team）` with the mentions, relations and claims of its documents, which leave X. `knode-os entities merge
    <parted> <X>` undoes it and stays undone: later mentions resolve to X and refine does not part it again.
  - *Measured* (`knode-os eval resolution`, sidecars only, no model): see the numbers in the branch's hand-over
    note. `--scan` on finance, agent-atlas, lifelong-library and default finds nothing to part under either setting.
- **Document dates** (`src/ingest/docdate.ts`). Frontmatter, then the path, then — raw documents only — a dateline:
  a line among the first eight that is a date and nothing else (an optional label, a full date, an optional second
  date, an optional weekday or short byline), not a list item, heading, quote or table row; a dotted date only
  behind a label or in a range; never later than the day of indexing; of a range the end, when the range is a
  report's own period (≤ 31 days) — or, while that period is still running, the day of indexing — and nothing when
  it is longer or starts in the future. The date may be in digits or with the month by name, and may carry a time
  of day. A bare date (no label, range, weekday, time or byline) counts only on the first or second line.
- **Re-dating** (`src/ingest/redate.ts`). A doc scope records the date rules it was checked under (`dateRules`,
  `DOC_DATE_RULES`: 2 since datelines). A sync pass reads the date of a document checked under older rules the way
  applying reads it; when it reads otherwise than `doc_date`, the document is re-dated in place, in one transaction:
  `doc_date`, and the dates of the evidence of its frontmatter and of its stored tier-1 extraction — relative dates
  read again from the stored words, `observed_at`, a claim that states none dated by the document — matched to the
  words by statement (a claim) or by type, description and endpoints (a relation; one whose words state no date
  keeps none); then the fold and the pages of the rows that changed. No entity is resolved again, no scope is
  replaced, no id changes and nothing anyone decided moves; a claim that is now a weekly reading is moved to its
  week's id by the claim re-key (`rekeyClaims`). A document whose date reads the same is only marked. When a stored
  extraction cannot be read again, or its words do not account for every row, nothing changes: the document is
  held for these rules (`dateHeld`), said once, and read again under the next rules or when it is applied again.
  *A re-date corrects the record; it does not version it.* The evidence rows are updated where they are, so an
  as-of read for a time before the re-date returns the new dates too. What is kept is a ledger line per document
  (`ev: "redate"`: old date, new date, rule number) and the sidecar's `meta.docDate`, which an attic replay dates
  the document by.

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

## 8. At finance size (2026‑11‑13, branch `claude/tier2-heap-bounds-fc4505`)

The steps above ran for the first time at finance size (1,105,684 representative claims, 110,309 live entities) on a
copy of the schema in a throwaway Postgres, a step a process, no model (the judge and the embedder stubbed). They were
measured because the service had died at its 4,144 MB heap limit at 03:25 that morning, on the build before this one.

**The crash.** `auditDuplicateClaims` read every representative claim into one array, at night and in the review after
extraction alike, and kept it until the judge answered. A review waiting on its judge held 1 GB; the nightly audit,
3.4 GB alone, started beside it. On the copy, under the same limit, that overlap dies after 53 s at 4,075 MB; with the
audit reading a batch of subjects at a time (`CLAIMS_PER_BATCH`) it runs through at 401 MB.

Peak heap is the largest `heapUsed` sampled every 50 ms; in brackets what a full collection left. Times are with two
or three runs sharing the machine.

| step | before | after |
|---|---|---|
| review after extraction: claim audit, 300 claims in focus | 20 s, 1,576 MB (984): 1,105,684 rows in one query | 8 s, 281 MB (125): 147,834 rows in 8 |
| review after extraction: entity audit, 300 entities in focus | 21 s, 563 MB (437) | unchanged |
| entity context: renames, alias suggestions, namesakes | 466 s, 417 MB (102); 20.2 million rows | 570 s, 74 MB (53); 3.2 million rows |
| entity duplicate audit | 30 s, 577 MB (447) | unchanged |
| claim-state backfill, 50,000 claims | 4 s, 98 MB | unchanged |
| attribute keys | under 0.1 s; 3.6 s and 121 MB once every claim is read (175,095 keys) | unchanged |
| duplicate-claim audit | 3,009 s, 3,704 MB (3,359) | 3,046 s, 479 MB (418) |
| claim audit with supersession | 9 s, 911 MB; 12 s, 906 MB once every claim is read | 5 s, 40 MB; 13 s, 162 MB (76) |
| of that, supersession by attribute once every claim is read (202,890 claims) | 8 s, 199 MB (183) | 9 s, 162 MB (55) |
| hot topics, navigation, recommendations | 2 s, 16 s, 10 s at most; 113 MB at most | unchanged |
| views (no model), wiki lint | 28 s, 62 MB; 26 s, 316 MB (259) | unchanged |

The two audits give the same results: 2,186,638 candidate pairs against 2,186,644, the same 156 merges, 111,584 rule
verdicts against 111,587 (the difference is pairs with a claim the same run had merged away), the same 70,302 claim
audit findings. The claim review and the model-written views were not run.

What the measurement showed and this branch does not change:

- **Renames.** As measured, the first night merges 39 entities on finance and at least 20 of them look wrong: where a
  statement names no old name, "the longest live name before the marker" picks 发展 (12,753 mentions, into 乐聚机器人),
  公司 (into 银河航天 and Megaspeed), 国际, 上市公司, 手机, and a parent for its renamed subsidiary or product (大族激光
  into 大族聚维, 赛力斯 into 赛豆, 东芝 into 铠侠). The alias rule files 5,873 merge suggestions that night (2,940 pending
  before). Both changed after this measurement, on `claude/rename-rule-safety-499894`: §5 has the rule as it is now
  and what it gives on the same claims (8 merges, 50 suggestions a run), from a dry run that read the live schema
  through a read-only `psql` and wrote nothing; the build deployed on 2026‑11‑13 (`e5bf3d7`) still has the first rule.
- **Namesakes** cost eight minutes a night (one query for each of 1,619 names) and split none.
- **The duplicate-claim audit takes 50 minutes**, nearly all in Postgres: 2.1 billion vector comparisons a night, a
  third of them within A股's 27,041 claims, every claim against its whole subject again. 1.5 million pairs wait for
  the judge at 1,200 a night.
- The backfill needs 23 nights at 50,000 claims; after it 202,886 claims carry an attribute and 43,881 are superseded.
- The entity audit reads every entity in each review (0.45 GB for a moment); the wiki lint holds the event loop for
  4 to 15 s, the views for 2 to 4 s.

## 9. The 10× fixes after review (2026‑11‑16, branch `claude/kb-stale-facts-review`)

The 10× benchmark fixes merged in main 7a299bf were reviewed against real
finance text and several of their rules were fitted to the weekly reports.
What the rules are now:

- **Series identity.** A series is one attribute of one thing: subject, the
  attribute's canonical key, the object, kind. The object is left out only
  where it is not a thing the attribute belongs to: it is the value itself
  (负责人 = 廖欣 with 廖欣 as object), or a person named on a 状态 / 阶段 line
  (who handles it). The duplicate audit settles two claims as `same` by rule
  only toward one object (`seriesObject`, `seriesRelation`).
- **Key unification.** Keys of one unit and the same qualifiers (环比 / 同比 /
  变化, 初始, 计划 / 目标 / 指引, 平均, 累计, 峰值 / 最高, 最低) join as claim
  state always joined them — one contains the other, or their bigrams mostly
  agree (归母净利润 / 净利润, 销售毛利率 / 毛利率, 市盈率TTM / 市盈率) — and also
  through a synonym group, a pure wording difference, or by both naming the
  subject (its name without a split's suffix, a tail of it, its code, the
  aliases of an entity named by a code; 配置值 / 取值 only for a subject that
  carries a code). Never across a qualifier, and never by a shared head word
  alone (零售价格 / 批发价格). The canonical key is chosen by rule: the synonym
  head, else the subject's name, else the shortest key that no other member
  only extends by a neutral word (指数, not 指). On 484 finance subjects the
  original rule put 296 pairs of keys together, this one 246: the 51 pairs no
  longer together all cross a qualifier.
- **Owner and state claims with no object** are read for what they are about
  ("云业务由张三负责" → 云业务), so two businesses' owners are two series.
- **Identifiers.** Only identifiers of one numbered series (letters, a
  separator, a counter: INC-001-T1, R-07, GPT-4) with another counter or two
  different tails are kept apart (INC-006 and INC-006-T1 are not); codes that
  run letters into digits (H100, CU2501, FY24) and a prefix in front
  (vivoX100, SHFE.CU2501) are not. A series identifier resolves by itself
  alone, and an entity named by one is reached only by an identifier it
  answers to. Refine merges an entity named only by a code into the one
  entity that answers to it (the split part labelled with it, else the single
  carrier of the code as an alias), in either identity mode.
- **Back-references** (`src/graph/backrefs.ts`) are off unless
  `review.backReferences` lists periodic-report folders (`periodic`) or asks to
  `detect` series; only claims that state a fix take part, only an
  identified, unfixed event of the previous report is linked, and the run is
  incremental; only the person the sentence gives as the fixer is linked. A
  link is a child scope of the scope carrying the fix claim: disposed with
  that document, with its trust and acl, its document and passage as the
  relation's source; an incremental run also disposes it when the earlier
  report it was resolved from changes or goes, and the step turned off
  disposes every link.
- **Bounds.** Refine keeps keys and supersession by attribute current in
  slices of 200,000 keyed claims (cursor in meta 'claim_state_pass') and reads
  5,000 code-named entities a run for the code merge (cursor in meta
  'code_merge_pass'). Scaled from the 10× build (17,222 claims: keys 64 ms,
  supersession by attribute ~210 ms, name splits + code merge 1.9 s), a whole
  run on finance would be roughly 6 s + 20 s + a minute; a slice is a few
  seconds and a pass takes about six refines. Not measured on finance.

10× benchmark, fresh no-model rebuild + refine's model-free steps
(`review.identity: "context"`; link step with the reports folder marked, or
with `detect`, same result): settings whose current value is the script's
56 of 90 (65 with the head-word rule, which the review showed joins different
measures on real text), risk state 119 of 120, risk owner 120 of 120,
incidents with an entity of their own 210 of 210, fix claims crediting
another person 0, id-less fixes linked 74 of 75 with 0 wrong links, stated
renames one entity 25 of 25, series with more than one current value 66 of
1,060 (all with an undated monthly-summary value).

### What an existing workspace sees, without anyone asking

**At its next ingest** (a document added, changed or removed):
- Mentions in the documents applied are resolved by the identifier rules
  above. Entities already written are not touched: an incident merged into
  another before the upgrade stays merged until its documents are applied
  again (a re-extraction or `sync --reapply`).
- Supersession and attribute keys are refreshed for the subjects the pass
  touched (`supersedeForClaims`), with the new series identity and keys.
- A removed or replaced document takes its back-reference links with it.
- No back-reference link is made: the step runs in refine only, and only if
  the workspace set `review.backReferences`.

**At its next refine** (the nightly pass, or `knode-os refine`):
- For the next slice of subjects (200,000 keyed claims, after a cursor), the
  attribute keys are rewritten by the rule above and supersession by attribute
  is marked again. Stored keys move through the mapping; no claim is read
  again and `CLAIM_STATE_VERSION` is unchanged. Keys that crossed a qualifier
  fall apart (环比涨幅 / 同比涨幅); owners and states toward different
  objects, or about different things, become current side by side; owners and
  states read under 跟进人 / 风险状态 / 处理状态 join their 负责人 / 状态
  series. Other subjects follow in later refines.
- For the next 5,000 code-named entities, one named only by a code merges into
  the one entity that answers to that code, if there is exactly one
  (reversible, logged with its reason; not made again after a person undoes
  it). In a workspace on `"name"` this is new.
- Entities split by the prefix rule of 7a299bf (x100 beside vivox100) do not
  exist in a live workspace: that rule was never deployed, and under the
  deployed rules both arrival orders end as one entity. Nothing rejoins them.
- The back-reference step does nothing unless `review.backReferences` is set.
  With it set, its first run reads every document (no cursor yet), later runs
  only what was applied since.
