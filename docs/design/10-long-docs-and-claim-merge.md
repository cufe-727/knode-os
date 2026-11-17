# 10 — Extracting long documents in segments, merging duplicate claims

> **Record status (2026-11-17): Built.** This is a decision record, not the description of the system. What the code does now is in [ARCHITECTURE.md](../ARCHITECTURE.md) §4, §5.2. Stale here: `batchSize` as calls per pass (CLI pass only); limit 5 (closed by 14). Design 29 adds the rule pre-filter and attribute-based supersession.

> Status: **implemented** (2026‑10‑03; the five items in §9 went as proposed). This changes two things in
> [09 — Reworking the ingest stages](09-ingest-stage-rework.md): the Extract stage (one call per document, reading only
> the first 12,000 characters) and what the Judge stage reviews (duplicate claims as well as duplicate entities).
>

## 0. Where things stand

Numbers from the finance workspace (2026‑10‑01, read-only queries against the local Postgres and the document sidecars):

| Item | Value |
| --- | --- |
| `raw/docs` documents | 21, **every one** longer than 12,000 characters; shortest 20 k, longest 368 k, 5.13 M in total |
| What extraction read | The first 12,000 characters of each, 252 k in total — about **4.9 %** |
| Per-document extraction | All 21 hit every cap: 15 entities, 15–20 relations, 10 claims |
| Claims | 210 (= 21 × 10) over 141 subjects and **68** types; **0** have a second piece of evidence |
| Time per extraction call | Median about 45 s (mostly 27–63 s; the 2026‑09‑15 run on cursor-cli grok fast, concurrency 1. Extraction runs on codex now, so this will differ) |

The documents are monthly archives of a Zhishi Xingqiu (知识星球) group: 240–580 second-level headings per full month (one per post or
comment thread), every post with its own timestamp. Post bodies often use `#` as a bullet, so first-level headings
mean little.

That gives three problems:

1. **Coverage.** 95 % of the content never reaches the graph; each document's claims come from the first day or two of
   its month. `LLM_EXTRACT_INPUT_CHARS` (`src/constants.ts`) is the only reason.
2. **Cost of a change.** Extractions are cached by the whole document's content hash, so any edit re-extracts the whole
   document. Today the truncation hides that cost; once extraction reads everything, every change pays for the full
   text, and a document that keeps growing — this month's archive — pays again on every append.
3. **Duplicate claims.** A claim's id is a hash of subject + normalized statement (`claimId`, `src/graph/store.ts`), so
   a different wording is a different claim. The same fact ("Zhongji Innolight's 2025 net profit attributable to
   shareholders: RMB 9.8–11.8 bn") is restated across posts, brokers and months, and reading full documents multiplies
   that. Neither existing check catches it:
   - The nightly claim audit (`auditClaims`, `src/wiki/refine.ts`) only compares token overlap ≥ 60 % inside a
     "same subject + same type" group. The type is whatever label the model chose (68 of them for 210 claims, with
     earnings and financials used interchangeably), so most duplicates never share a group — and a hit only files a
     "please reconcile" suggestion; nothing merges.
   - Source-conflict detection (`detectDisputes`, `src/lineage/trust.ts`) treats any "same subject and type,
     overlapping time, different statement" as a contradiction — so a quarantined source **paraphrasing** a trusted
     claim opens a dispute.

## 1. Decisions

| Decision | Outcome |
| --- | --- |
| D1 Segments | Documents longer than `extraction.segmentChars` (default 12,000) are extracted per segment, one call each; shorter ones are still one call. Cuts fall on headings, rules and blank lines, chosen by the content at the cut rather than by accumulated length |
| D2 Segment cache | Each segment's result is kept in the sidecar under the segment's text hash: an edit re-extracts only the segments it changed, and stopping half way loses no paid-for segment |
| D3 Document subject | The first segment runs first and also answers "what is this document mainly about" (may be null); the other segments run in parallel with that answer. Generic references such as 公司 / 本公司 / "the company" never become entities |
| D4 Written once | When every segment is done, the results are merged within the document (same-named entities become one, identical claims collapse) and written as one tier1 scope; the sidecar still holds the document-level result, so a rebuild costs nothing |
| D5 Queue by calls | `batchSize` becomes "model calls per pass" (extraction counts segments, summaries count documents); long documents continue over several passes, and passes run back to back while there is a backlog. No cap on segments or tokens |
| D6 A claim merge is a link | The entity-merge mechanism again: `claims.canonical_id` + `claim_links`, owned by a `claim-merge` scope, undone by `unmerge`; evidence is never rewritten |
| D7 One judgement, five outcomes | Candidate pairs go to the Judge model: same / contains / conflict / different_time / unrelated. same and contains merge; conflict files a knowledge suggestion and replaces the nightly 60 % overlap check; verdicts are remembered, never re-judged |
| D8 Automatic merging | New `review.claimMerge` (off / suggest / auto), **default auto**: it merges on its own only pairs that are identical after normalization, or judged same with confidence ≥ 0.9 and passing the number and time checks |
| D9 Backfill | Existing truncated extractions count as incomplete and are re-queued; on finance that is about 570 calls after install |

D5, D8 and D9, the entity-merge mode and the order of work were settled on 2026‑10‑03 — see §9.

## 2. The flow

```
background document pass runDocumentPass (per pass: at most batchSize extraction calls, at most batchSize summaries)
   ③ Extract: pending segments in document-priority order ── a segment-cache hit costs no call
        per document: first segment (also answers the subject) ─▶ the rest in parallel (concurrency)
        documents whose segments are all done: merge within the document ─▶ one tier1 scope ─▶ note the entities and claims written
      └▶ incremental entity resolution (09 §3, unchanged)
      └▶ incremental claim merge (new): only claims written this pass ─▶ same-subject candidates ─▶ deterministic checks ─▶ Judge model (batched)
            ─▶ merge (reversible) / suggestion / conflict suggestion / remembered verdict
   ④ Summarize (unchanged)
   backlog left ─▶ start the next pass right away; poll every intervalMinutes only once the queue is empty

nightly: full entity resolution → full claim-merge backstop (re-anchoring included) → claim audit (overlap check removed) → claim review → rest unchanged
```

## 3. Segmented extraction

### 3.1 Cutting

The input is the same Markdown as today, from `loadSourceText`.

- **A document no longer than `segmentChars` is one segment**, read and cached as today; the new caps and the two new
  rules (§3.2) apply to every document.
- A longer one is first cut into *blocks* by line: headings (any level), `---` rules and blank lines are block
  boundaries. A `#` used as a bullet does no harm; it only adds a candidate cut.
- Blocks are packed from the start. Once the current segment holds four tenths of `segmentChars`, a cut is made before
  the next heading or rule whose first line hashes to a hit (about 1 in 12); at `segmentChars` the cut is forced at the
  nearest block boundary. A single oversized block is split by paragraph, then by sentence.
- Segments **do not overlap**. Each carries its heading path (the nearest first- and second-level headings).

**Why the content picks the cuts.** If segments were filled to a length and cut, one character changed near the top
would move every later cut and re-extract dozens of segments. When the cut depends on the content around it, an
insertion changes only its own segment (now and then the next one too), and an append changes only the last.

**The parameters were measured** (finance, 5.13 M characters, a 12,000 limit, six random insertions per document):

| Rule | Segments | Average size | Segments re-extracted after one insertion (mean / max) |
| --- | --- | --- | --- |
| past four tenths, 1-in-12 hits (adopted) | 571 | 9,000 | 1.6 / 6 |
| past seven tenths, 1-in-2 hits (the first idea) | 560 | 9,200 | 2.8 / 21 |
| filled up to the limit | 444 | 11,600 | 5.2 / 21 |

The minimum must stay low: when segments always end shortly after seven tenths, the length decides the cuts again and
one insertion shifts the twenty-odd segments after it. The price is about a third more segments than filling up (9,000
characters on average) for edits that re-extract one or two; shorter segments also hit the per-call caps less often.

### 3.2 One call per segment

The system prompt stays today's extraction prompt (ontology vocabulary, claim rules); the user message starts with a
segment header:

```
Document: <title> (<path>) · part 3 of 26 · section: <heading path>
Document date: 2025-08-01
Main subject of this document: CATL (organization)   ← only when the first segment named one
Known entities: …                                     ← see below
```

- **The first segment** also returns `subject`: the entity the document is mainly about, or null when it covers many
  things (an archive, a weekly digest) — then the line is left out. The other segments wait for it, then run in parallel.
- **Known entities**: `knownEntitiesIn` runs over **this segment's** text (up to 30), plus entities from this
  document's finished segments that appear in this segment, so one document keeps one spelling per thing.
- Two new rules, for single-segment documents too:
  - Generic references — 公司 / 本公司 / 该公司 / "the company" — never become entities: attribute them to the entity the
    context names, or leave them out.
  - Resolve relative dates against a time the passage itself states (a post's timestamp, a dated heading) before
    falling back to the document date. Every archived post has a timestamp; the document date is only a month.
- **Caps per segment**: 25 entities, 30 relations, 25 claims (today 15 / 20 / 10 per document, and all 21 hit them),
  with `maxTokens` raised from 8,000 to 12,000. The caps guard against truncated output — truncated JSON fails to
  parse and wastes the whole call — they are not a budget. In the live run, dense archive segments filled all 25 (§8).

### 3.3 Merging within a document

Once every segment is done, and before anything is written, the results become one document-level result by
deterministic rules:

- **Entities**: same name key, alias key (`entityKeys`, `src/graph/normalize.ts`) or `sameAs`, with compatible types,
  become one. The name is the most frequent spelling (earliest on a tie), aliases are unioned, the description is the
  first non-empty one, the type goes by majority.
- **Relations**: endpoints map onto the merged entities, then relations are deduplicated on (source, predicate,
  target); the first occurrence wins, with a missing description or window filled from later ones.
- **Claims**: subjects map onto the merged entities, then claims are deduplicated on (subject, normalized statement);
  each remembers its segment.
- **Grounding**: a claim is grounded to the best-overlapping chunk **within its segment** (today: anywhere in the
  document); an entity gets up to 4 mention chunks in each segment it was extracted from (today: the first 8 matches
  in the document), so a long document's mentions spread over the whole text instead of piling up at the top.

### 3.4 Cache, resume and failure

The document sidecar's `tier1.json` gains two fields; the existing ones stay:

```jsonc
{
  "status": "done",                    // new value 'partial': segments still pending
  "entities": [], "relations": [], "claims": [],   // the merged document-level result; sync replay keeps reading these
  "model": "…", "contentSha": "…", "extractedAt": "…",
  "segmenter": 1,                      // new: version of the cutting rules
  "segments": [                        // new: one per segment (a document read in one call has one)
    { "i": 0, "sha": "…", "start": 0, "end": 11234, "heading": "…", "status": "done",
      "subject": "CATL", "entities": [], "relations": [], "claims": [], "model": "…", "extractedAt": "…" }
  ]
}
```

- Each segment is written to the sidecar as soon as it finishes. If the app quits or the pass stops, the next one
  continues; nothing paid for is redone.
- A changed document is cut again; a segment whose `sha` appears among the old `segments` is reused (wherever it now
  sits), the rest are extracted, then merged and written. Writing still replaces the whole tier1 scope, so evidence
  from deleted segments is withdrawn with it.
- A segment that fails three times is skipped: the rest are written and the sidecar records the failed segments and
  the error. The next content change retries them; `knode-os extract --retry-failed` re-queues them by hand.
- **Replay** (`replayableTier1`): status done, matching `contentSha`, and either the current `segmenter` or a document
  no longer than the old single call read (12,000 characters, `LEGACY_EXTRACT_CHARS`). Old sidecars carry no
  `segmenter`, so long documents are re-queued — that is D9's
  backfill. Their old evidence stays live until the new result is written, so the graph never goes blank.

### 3.5 The queue and the size of a pass

- `extraction_queue` still holds documents with document priorities; two new columns, `segments_total` and
  `segments_done`, feed the UI.
- A pass takes pending segments in document-priority order until it has `batchSize` calls. A document whose first
  segment is not done gets that segment first, and the rest of the pass's calls are reserved for its other segments:
  once the first is in, they run in parallel in the same pass, so one document is finished before the next starts.
  `concurrency` is how many of these calls run at once, across documents.
- A pass is therefore bounded (8 calls; at the measured 2 minutes a call and concurrency 1, about 16 minutes): a newly
  arrived hot document does not wait for a 368 k-character archive to finish, and the initialization catch-up limit
  (`research.init.extractionMaxMs`, checked between passes) means something again.
- Serve's timer: when a pass ends with a backlog and made progress, the next pass starts right away; only an empty
  queue (or a pass that moved nothing) falls back to polling every `intervalMinutes`. Otherwise every pass would end by
  idling until the next tick.
- Summaries stay at most `batchSize` documents per pass.

## 4. Merging duplicate claims

### 4.1 What counts as the same claim

Only claims of the same subject (the canonical entity after merges) are compared. A pair is one of five things:

| Relation | Meaning | Outcome |
| --- | --- | --- |
| same | Same fact, same period, same numbers; only the wording differs | Merge; the clearer, fuller wording represents the group |
| contains | One states everything the other does and more (A gives revenue and net profit, B only the same net profit) | Merge (the link is recorded as `contains`); the fuller one represents the group |
| conflict | Same fact, same period, numbers or conclusion disagree | No merge; a "contradicting claims" knowledge suggestion |
| different_time | Same measure, different period (25Q2 vs 25Q3; 2024 actuals vs a 2025 forecast) | No merge; supersession (`markSupersededClaims`) already handles it |
| unrelated | Anything else, including partial overlaps where each has a fact the other lacks | Nothing |

`absent` claims (empty lookups) never take part.

### 4.2 Candidates

Scope: per pass, the claims written in that pass (`applyExtraction` also returns `claimIds`); nightly, every
representative claim. Each is compared only with representative claims of the **same canonical subject** (subjects
expanded through entity merges), plus one swapped group (A's subject is B's object and A's object is B's subject).
Three signals:

1. **Identical after normalization**: on top of `claimId`'s normalization, drop punctuation and unify full/half width
   and digit forms. Such a pair is same with confidence 1, no model call. Today "…grew 20 %." and "…grew 20%" are two
   claims.
2. **Embedding similarity** ≥ 0.85 (to be calibrated) over "subject: statement", the 5 nearest within the subject.
3. **Shared key numbers**: numbers with units (亿, 万, %, pct, ×, yuan, dollars…) overlap and the periods match.
   Restated financial facts keep their numbers more faithfully than their words, so a shared figure lowers the cosine
   bar from 0.85 to **0.70** (`numberThreshold`, calibrated on bge-m3 like the 0.85). It does not replace the bar, and
   the pair's own cosine counts even when it is not among the 5 nearest. Numbers are compared at the coarser of the two
   precisions: 36.19亿 and 36.2亿, 0.45% and 0.5%, 14.9% and 15% agree.

   At first a shared number made a candidate even when the vectors disagreed. A read-only backtest of finance's 28,974
   judged pairs (2026-10-19) showed what that cost. 15,831 of them (55%) came from a shared number alone, and 140 of
   those verdicts merged, suggested or flagged anything (0.9%). Almost all of the 140 sat just under the similarity bar:

   | Pairs only a shared number brought up | Pairs | Verdicts that merged, suggested or flagged anything |
   | --- | --- | --- |
   | cosine under 0.70 | 8,527 | 3 (0.04%) |
   | 0.70–0.75 | 3,281 | 22 (0.7%) |
   | 0.75–0.80 | 2,378 | 35 (1.5%) |
   | 0.80–0.85 | 1,645 | 80 (4.9%) |
   | *For comparison: similarity 0.85–0.90* | 9,088 | 483 (5.3%) |

   The 0.70 floor drops 29% of all judging and 3 of the 1,628 useful verdicts. Requiring the similarity signal instead
   (drop these pairs) would have lost all 140, among them 46 of the 208 contradictions. Requiring more shared numbers
   does not separate them: as the audit counts them, the rate was 0.9%, 1.1% and 0.7% for 1, 2 and 3 or more.

With the local hash embedder (meaningless distances) signal 2 is skipped, today's token overlap ≥ 0.6 stands in, and a
shared number alone still makes a candidate. With real vectors, a claim whose embedding failed (the embedding pool's
daily quota, say) brings up no number pairs until a later run has embedded it; they are not judged on the number
alone. On finance on 2026-10-19, 159 k of the 191 k claims that have a same-subject neighbour had no vector yet (the
nightly embedding stopped at the pool's quota), and that held for 181,460 of the 182,476 number pairs waiting for the
judge.

Vectors live in a new table, `claim_embeddings` (`claim_id`, `model`, `embedding halfvec(dim)`), created with the
vector width and dropped on a width change, like `entity_embeddings`. A claim's statement is part of its id and never
changes, so each claim is embedded once; a new embedding model re-embeds lazily by the `model` column. A subject holds
few claims, so filtering on `subject_id` and comparing exactly is enough — no HNSW, which could not push that equality
filter down anyway.

### 4.3 Deterministic checks before the judge

| Check | Result |
| --- | --- |
| Both carry an event time or validity window and they do not overlap at the stated precision | different_time, no model call |
| Both statements carry period markers (year, quarter, month — "2025 年四季度" and "25Q4" normalized first) and they differ | different_time, no model call; markers that cannot be normalized count as compatible |
| Both carry key numbers for the same period and the numbers differ (beyond rounding) | To the model; **never** merged automatically |
| Negation differs (未, 没有, 尚未, 否认, 不会, 不是, not… on one side only; a bare 不 does not count — 不及预期 is not a negation) | To the model; never merged automatically |
| One is fact, the other disputed | To the model; never merged automatically |
| The pair already has a verdict | Skipped |

Verdicts go into a new table, `claim_pair_verdicts` (`pair_id` = hash of the two sorted ids, relation, confidence,
reason, model, time) — not into `suggestions`: there are an order of magnitude more claims than entities, and
`suggestions` is for what a person should look at.

### 4.4 The judge

- On the Judge route (`ctx.llm`), **batched**: up to 12 pairs per call, regardless of subject. Entity resolution makes
  one call per pair today; at claim volume that would mean more judge calls than extraction calls.
- **At most `review.claimMergeMaxJudgedPerRun` pairs a run** (default 1,200, i.e. 100 calls), the most promising first:
  pairs the similarity signal brought up before pairs that only share a number; pairs that none of §4.3's checks keep
  from merging before the rest; then the higher similarity (for pairs that only share a number, the higher cosine), the
  more shared key numbers, the newer claim. The others get
  no verdict, so a later run proposes them again; the nightly run compares every claim. Identical and different-period
  pairs are settled by §4.3 without a model and never wait. Without the cap a backlog holds up the rest of tier 2:
  finance's two largest nightly runs judged 7,531 and 9,252 pairs and took about four hours each (some 20 s a call). In
  this order, the first 1,200 of finance's 28,974 judged pairs (2026-10-19) hold 681 of the 1,628 verdicts that merged,
  suggested or flagged anything; in the order they were judged, 141. Pairs that only shared numbers were 55% of the
  judged pairs and 0.9% of them produced anything. §4.2's cosine floor now leaves out 54% of them. Ranking the rest by
  cosine puts 41 of their 137 useful verdicts in the first 500 such pairs; ranking by shared numbers and age put 14 there.
- Per pair: the subject; both statements with type, status, event time / validity / document date and source path; a
  300-character excerpt of each grounding chunk.
- Rules: same only when one entails the other (same facts, same period, same numbers); figures that agree after
  rounding are the same figure, and only a difference beyond rounding is a conflict; differing periods are
  different_time; low confidence when unsure. Each pair returns `{relation, keep: "a" | "b", confidence, reason}`, the
  reason in the claims' language. The rounding rule came from the live run: two restatements of one Hikvision quarter
  (0.45% / 0.5%, 36.19亿 / 36.2亿, 15% / 14.9%) were judged a contradiction under "different numbers are never the same" (§8).

### 4.5 What each mode does (`review.claimMerge`)

| Verdict | auto | suggest | off |
| --- | --- | --- | --- |
| Identical after normalization | Merge | Merge | Nothing |
| same / contains, confidence ≥ `claimMergeMinConfidence` (0.9), every §4.3 check passed | Merge | Suggestion | Nothing |
| same / contains, confidence ≥ `llmMinConfidence` (0.6) but short of the row above | Suggestion | Suggestion | Nothing |
| conflict, confidence ≥ 0.6 | "Contradicting claims" knowledge suggestion | Same | Nothing |
| different_time, unrelated, low confidence | Verdict remembered | Verdict remembered | Nothing |

Identical-after-normalization merges even under suggest: it is the same kind of thing as `claimId`'s deduplication
today, one normalization step further. A merge suggestion has `kind` `claim-merge`: accepting merges, rejecting records
the pair as unrelated.

### 4.6 How a merge is represented

Exactly like entity merges (`src/graph/merge.ts`):

- A new column `claims.canonical_id` and a new table `claim_links` (`id`, `claim_id`, `canonical_id`, `kind`
  (`same_as` / `contains`), `scope_id`, `actor`, `reason`, `confidence`, `created_at`, `tx_to`).
- Each merge is a `claim-merge` scope (key = the merged claim's id) written through a new writer effect, `linkClaim`,
  whose inverse is `claim_link.remove`; `knode-os claim unmerge <id>` disposes of the scope. The ledger records
  `claim.merge` / `claim.unmerge` feedback so `rebuild` replays it.
- **Representative**: a side that already has members stays the representative (its id stays stable once cited);
  otherwise the judge's `keep` (the more informative claim), failing that more evidence, then earlier. Groups are flat:
  merging into a merged claim lands on its representative, and a representative merged into another group brings its
  members along — and takes them back when unmerged.
- **Fold**: the representative folds over its own evidence ∪ its members' (reusing `foldClaimEvidence`), so
  `evidence_count` is the number of sources and status, validity and first source combine exactly as for identical
  claims today; a member's evidence change refolds the representative. Member rows keep their own fold, so an
  unmerge restores them at once.
- **Reads**: every read of current claims adds `canonical_id IS NULL` — the `v_claims` view, `knode_claims`
  (`src/store/claims.ts`), knode_ask's known facts (`src/search/ask.ts`), graph queries, entity pages and timelines,
  recommendations and the survey, lint, the compiler's absence and subscribe — about 30 SQL statements. Claim records
  gain `sources` (every source path in the group), so an answer can say "3 sources".
- **A representative that loses its own source** (its document deleted) while members remain stays alive on their
  evidence; the nightly backstop promotes the member with the most evidence and re-links the group.
- **Other mechanisms**:
  - Entity merges: candidates use canonical subjects. Duplicate claims hanging off two duplicate entities are compared
    only once those entities merge.
  - Supersession: computed among representatives only.
  - `detectDisputes`: two claims in one group are no longer a contradiction, so paraphrases stop opening disputes.
  - Nightly claim audit: unless `claimMerge` is off, the "similar statements from several sources" check goes (§4.4's
    conflict replaces it; with merging off it stays, as the only near-duplicate hint); the expired-fact and
    fact-vs-disputed checks stay, over representatives only.
  - Claim review (`reviewClaims`) is unchanged.

### 4.7 When it runs

- **Every pass**: after incremental entity resolution (so `auto` entity merges land first),
  `auditDuplicateClaims(ctx, { focus: claims written this pass })`, then summaries.
- **Nightly**: `refineWiki` becomes full entity resolution → full claim merge (backstop for pairs of old claims,
  subjects merged since, a changed embedding model, plus re-anchoring) → claim audit → claim review → the rest unchanged.

## 5. Config, API and migration

```jsonc
"extraction": {
  "segmentChars": 12000,   // new: upper bound of a segment (characters); documents within it are still one call
  "batchSize": 8,          // now the most model calls per pass: extraction counts segments, summaries documents
  "concurrency": 1, "intervalMinutes": 5, "claims": true
},
"review": {
  "claimMerge": "auto",             // new: off / suggest / auto
  "claimMergeMinConfidence": 0.9,   // new: confidence floor for automatic merges
  "claimMergeMaxJudgedPerRun": 1200 // pairs judged per run, most promising first (§4.4); the rest wait for a later run
}
```

- **Database migration**: `claims.canonical_id`, `claim_links`, `claim_pair_verdicts`,
  `extraction_queue.segments_total / segments_done`; `v_claims` appends `canonical_id` and shows representatives only;
  `claim_embeddings` joins `embeddingsDdl` (`src/store/db.ts`).
- **Config migration**: none needed. The new keys have defaults and `batchSize` keeps its value.
- **`PUT /api/config`**: accepts `review.claimMerge`; `segmentChars`, `claimMergeMinConfidence` and
  `claimMergeMaxJudgedPerRun` are file-only.
- **CLI**: `knode-os extract` reports calls and segments left, and `--retry-failed` first re-queues documents with
  failed segments; new `knode-os claim merge <claim> <into>`, `claim unmerge <claim>`, `claim merges`, `claim dedupe`
  (singular, because `claims` is already the query command).
- **API**: `GET /api/claims/merges`, `POST /api/claims/merge`, `POST /api/claims/unmerge` (shaped like the entity-merge
  endpoints); `GET /api/stats` adds `extraction_segments` (calls the queue still needs); every claim from
  `GET /api/claims` carries `sources`.

## 6. UI

- **Extract**: "Documents per pass" becomes "Calls per pass", with a note that documents longer than `segmentChars`
  are read in segments; queue progress under the form, e.g. "Queue: 3 documents, 142 calls left".
- **Judge**: after duplicate-entity review and claim review, a third control: "Duplicate claims: off / suggest only /
  merge when confident".
- **Suggestions**: a new "merge duplicate claims" kind; "contradicting claims" stays a knowledge suggestion.
- Claims on entity pages and timelines show their source count.

## 7. Cost (finance estimate)

- **Backfill**: finance cuts into **571 segments, so 571 calls** (21 today). Measured on codex (gpt-6.1-sol): 113–144 s a
  segment, about 2 minutes on average — roughly 20 hours at concurrency 1 and 7 hours at 3 ("Parallel calls" on the
  Extract stage). At an estimated 8,000 tokens a call including output, about 4.6 M tokens. It is paid once; afterwards
  only new and changed segments cost anything.
- **Claims**: from 210 to around ten thousand before merging (24–25 per segment in the live run, §8). The merge rate
  gets measured after the backfill.
- **Embeddings**: one request per new claim.
- **Judge calls**: 12 pairs per call, at most `claimMergeMaxJudgedPerRun` (1,200) pairs a run; the volume gets measured
  after the backfill. Different-period and identical pairs are settled by the deterministic checks without a call. Pairs
  that only share a number need cosine 0.70 (§4.2), which would have spared 29% of finance's judging up to 2026-10-19.
- **Entities** grow from 261 to several thousand too, and under `llmJudge = suggest` so do pending entity-merge
  suggestions — see §9 item 4.

## 8. Verification

**Unit tests**

- Cutting: within `segmentChars` there is one segment, the input text is today's and there is no segment header; inserting text in
  the middle changes at most 2 segment hashes; an append changes only the last; `#` bullets do not change the result.
- Merging within a document: same name, alias or `sameAs` makes one entity; identical claims collapse; claims ground
  inside their segment.
- Cache and resume: stopping half way means the next pass calls no finished segment; editing one segment re-extracts
  only that one; sync replay still costs no call; old sidecars of long documents are re-queued, short ones untouched.
- Merging claims: identical pairs merge directly; differing numbers never merge automatically; different periods
  need no model call; merge then unmerge restores both claims and the folded counts; reads show representatives only;
  supersession and `detectDisputes` ignore members; `rebuild` replays merges.

**Comparison on finance**: three long documents, scored the way `bench extract-compare` judges extractions.

- Coverage: the share of segments with at least one grounded claim;
- Precision: 50 random claims, each judged against its grounding chunk;
- Claims and entities per document, calls, time;
- `segmentChars` 8,000 vs 12,000 and the old vs new caps, to settle the defaults.

**Merge quality**: run suggest on finance first, check 30 merges and 20 conflicts by hand, then switch to auto.

**Live run (2026‑10‑03, a scratch workspace with finance's current Extract and Judge settings)**: the first 26.5 k
characters of the 2025‑08 archive.

- Three segments, three codex calls: 113, 144 and 127 s. The first segment answered a null subject (the archive covers
  many companies, as expected).
- 53 entities and 74 claims written; the old single call read the first 12,000 characters and got 15 entities and 10
  claims per document.
- Segments 2 and 3 hit the caps of 25 entities and 25 claims: the archive is dense, and those segments were not read
  out completely. Lowering `segmentChars` (8,000 is about 800 calls) or raising the caps (longer, slower calls) would
  cover more; the backfill runs with the current settings first.
- Claim merging: 2 candidate pairs, both judged. Two restatements of one Hikvision quarter, differing only by rounding,
  came back as a contradiction — hence the rounding rule (§4.3, §4.4). Judged again with it, the pair came back as
  contains (0.98) and merged on its own, the fuller wording (it adds the cash-flow remark) representing it; against a
  forecast for 2025 and 2026–2027 it was different_time. One judge call took 46 s for 3 pairs.

## 9. Settled trade-offs

1. **Claim merges default to auto.** In volume, the backfill will produce hundreds or
   thousands of candidate pairs, and suggest means a person clicks each one; in risk, a claim merge only changes how
   one claim is shown and counted (an entity merge moves mentions, relations and pages), and it can be undone at any time.
2. **Backfill automatically after install.** The truncation is not a quality trade-off; it is 95 % of the
   content missing. The cost on finance is about 570 calls; at the measured 2 minutes a call, about 20 hours at
   concurrency 1 or 7 hours at 3.
3. **`batchSize` means "calls per pass".** Otherwise one pass must finish eight whole monthly archives
   (about 170 calls, over two hours), new documents wait for it, and the initialization catch-up limit stops meaning anything.
4. **Entity merges stay on suggest for now.** An entity merge moves mentions, relations and pages, a bigger risk than a
   claim merge; the backfill will produce many entity-merge suggestions, and `llmJudge` (09 · D5) gets decided once their
   volume is known. The Judge stage can switch it to auto at any time.
5. **Both parts ship together, claim merging live alongside the backfill.** Otherwise
   the backfill first piles up duplicate claims, disputes and "please reconcile" suggestions.

## 10. Known limits

1. Text that keeps changing invalidates segment hashes — for instance view and comment counts in archived posts'
   metadata, if a re-render updates them. That belongs on the corpus side (the archive renderer), not in fuzzy reuse
   in the product: "close enough, keep the old result" would keep a corrected number at its old value.
2. Only the document subject crosses segments. Something named only in a distant segment is left to entity
   resolution after writing.
3. Claims are compared within one canonical subject (and the swapped subject/object group) only; duplicates under two
   not-yet-merged duplicate entities surface after the entity merge.
4. Partial overlaps, where each claim has a fact the other lacks, are not merged.
5. ~~Summaries still read only the first 14,000 characters (`LLM_WIKI_INPUT_CHARS`), so a long document's summary page
   reflects its beginning only.~~ Done in docs/design/14: a long document is summarized segment by segment — the same
   segments as extraction — and the parts merged; the page says how much of the document it read.
6. Looking back in system time (`as_of`) filters claims by the **current** groups, and a representative folds only its
   own evidence of that time: a moment before a merge shows the merged grouping.

## 11. Where the changes go

| File | Change |
| --- | --- |
| `src/graph/segment.ts` (new) | Cutting, segment-cache lookup |
| `src/graph/tier1.ts` | Scheduling by calls, first segment first, merging within a document, resume and failure |
| `src/graph/llm-extract.ts` | Segment header, `subject`, the generic-reference and relative-date rules, caps; `applyExtraction` returns `claimIds` and grounds per segment |
| `src/fs/sidecar.ts`, `src/ingest/apply.ts` | `segmenter` / `segments`, the replay rule |
| `src/graph/claim-dedupe.ts` (new) | Candidates, deterministic checks, batched judging, modes, re-anchoring |
| `src/lineage/writer.ts`, `scope.ts`, `fold.ts` | `linkClaim` and its inverse, group folds for representatives |
| `src/store/migrations.ts`, `db.ts` | New columns, tables and view |
| `src/store/claims.ts` and ~30 other reads | Representatives only, `sources` |
| `src/wiki/refine.ts`, `src/lineage/trust.ts` | Nightly order, overlap check removed, disputes skip group members |
| `src/ingest/background.ts`, `src/server/serve.ts` | Claim merging in every pass; back-to-back passes while a backlog remains |
| `src/config.ts`, `src/server/app.ts`, CLI | New keys, API, commands |
| macOS and web Ingest tab | "Calls per pass", queue progress, the Judge stage's third control |
