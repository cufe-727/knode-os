# 14 — Summary pages worth their cost: a size threshold, the document's language, the graph's names, whole documents

> **Record status (2026-11-17): Built; current.** This is a decision record, not the description of the system. What the code does now is in [ARCHITECTURE.md](../ARCHITECTURE.md) §5.2, §5.3. Stale here: D2 "in the document's language" is overridden by 17 when content languages are on. §0 and the §6 tables are measurements.

> Status: **implemented** (2026‑10‑23). Config keys `extraction.summaryMinChars` and `extraction.summaryMaxSegments`,
> schema v15 (`documents.chars`), `knode-os wiki prune-summaries`. §6 (2026‑11‑11): the document's claims on its
> summary page, generator `source_summary@3`; the specifics rule and a figures list in the prompt.

## 0. What the pages looked like

A quality review of the finance workspace (≈22,000 Chinese stock-blog digests, 13,606 summary pages) on 2026‑10‑21:

1. **Pages longer than their documents.** 32% of the documents are under 1 KB — a day with one post — and each got a
   1.3–1.5 KB summary page that restated the post. Every page is indexed again as a `view` document, so each of those
   posts counted twice in search, the second time in a worse paraphrase.
2. **An English scaffold on Chinese pages.** The prompt was English, so 13,605 Chinese pages carried `## Key points`
   and `## Entities`, and 3,237 ended with boilerplate such as `[[雪球]]：内容发布平台` — the platform the digest came
   from, listed as an entity of every page.
3. **Links to names the graph does not have.** The summary never saw the document's extraction, so its `[[wikilinks]]`
   used whatever the model felt like: `[[懂王]]` where the graph has 特朗普, `[[融资杠杆]]` for 保证金交易, the
   traditional-character `[[管我財]]` beside 管我财. `wiki lint` reported 194,818 broken links over 13,617 pages.
4. **Long documents read to 14,000 characters and no further.** A 134 KB weekly digest of 260 posts got a page that
   claimed to cover the week and had read about 10% of it. 17% of the documents, 71% of the bytes, are over 36 KB.
   Extraction, by contrast, cuts a long document into `extraction.segmentChars` segments and reads all of them
   (docs/design/10 §3).

## 1. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 Size threshold, no page below it | A document under `extraction.summaryMinChars` (default 1,500 characters of indexed text) gets **no summary page** — not a pointer page either. It is never "due", the sources index marks it `short`, search finds the document itself | A pointer page would be indexed as a view like any page, so it would keep the search noise the threshold is meant to remove and say nothing the sources index does not. Characters, not bytes, because every other size in the pipeline (`segmentChars`, `LLM_WIKI_INPUT_CHARS`) is characters and a Chinese character is three bytes |
| D2 The scaffold in the document's language | The language is detected from the text (or declared as `lang:` / `language:` in frontmatter); the prompt names it and gives the two section headings in it (zh 要点 / 实体, en Key points / Entities, ja, ko). The page's `description` follows. The answer's headings are normalized to the scaffold whatever the model wrote | The instruction stays English — models follow it well — but the output's shape is fixed in the reader's language |
| D3 The channel is not an entity | Frontmatter `platform:` / `source:` / `author:` / `channel:` name the document's own channel (platform ids map to their names: `xueqiu` → 雪球). The prompt says not to list them; a link to one becomes plain text; a bullet in the entities section that only names one is dropped | The digests' boilerplate was the channel listed on every page |
| D4 Links only to the graph's names | Each call carries the document's entities **as the graph names them**: from `entity_mentions`, following `canonical_id` to the survivor of a merge, with the graph's aliases and the spelling the document was extracted under. The model may link those names only; in the answer a link under an alias becomes `[[Name\|alias]]`, a link to anything else becomes text | A summary written before resolution would link the pre-merge spelling; `entity_mentions` after resolution is what the graph actually has. Tier-0's mined concept placeholders are left out — they are not names anyone links and tier-1 retires them |
| D5 Long documents, segment by segment | A document over `LLM_WIKI_INPUT_CHARS` is cut with the extraction segmenter (`min(segmentChars, 14,000)`), each segment summarized in its own call, and the parts merged in one more call. Past `extraction.summaryMaxSegments` (default 12) the segments are sampled evenly, first and last included, and the page says so: `分段摘要：全文约 134,000 字、12 段，本页只读了其中 8 段（约 65%，260 节中的 170 节）。` plus a `coverage` frontmatter block | Calls are bounded (at most `summaryMaxSegments + 1` per document) and honest: a page that read part of a document says which part. Same segments as extraction, so a part call sees the entities extracted from exactly that text |
| D6 Parts cached by segment hash | Part summaries live in the sidecar's `views/source-summary.parts.json`, keyed by the segment's text hash like tier-1's `segments`. The final summary keeps its content-hash cache (`views/source-summary.md`), now with the language and the coverage | A digest for the current week changes every day: only the changed segment and the merge are paid again; an interrupted document resumes with the parts it has |
| D7 Leased work, one call per lease | The summary source hands out **calls**, not documents: a long document's parts may be out to several workers at once; once every part is in, the merge goes out. A part's answer goes to the part cache and puts the document back in line; the merge's answer goes to the summary cache and the page is written from it, as before | Fits the broker's model (docs/design/12) without a new kind; remote workers need no change — a task is still messages, a prompt and `maxTokens` |
| D8 Existing pages: a sweep, and attrition | `knode-os wiki prune-summaries` archives the summary pages of documents under the threshold through `archivePage` (to `wiki/.archive/`, search projection dropped), and rewrites the sources index. Independently, the generator's `plan` returns null for a short document, so a stale page is archived when its document next changes. Cached summaries are kept: lowering the threshold restores the pages without a model call | Archiving 7,000 pages is the user's call, not a sync's side effect — the command is run by hand (`--dry-run` lists first). The existing 13,606 pages are **not** re-summarized: their cached bodies stand until their documents change |

## 2. The flow

```
planSummary(store, dataDir, config, doc)                      src/wiki/summary.ts
  text        ← loadSourceText; under summaryMinChars → { kind: 'none', reason: 'short' }
  language    ← frontmatter lang/language, else script of the text
  channels    ← frontmatter platform / source / author / channel (+ platform id names)
  vocabulary  ← entity_mentions of the document → entities, canonical_id followed, aliases + mentioned spelling
  fits one call → { kind: 'single', segments: [whole text] }
  else          → segments = segmentText(text, min(segmentChars, 14,000)), sampled to summaryMaxSegments
                  coverage = { chars, parts, read, share, sections, sectionsRead }
                  cached   = part summaries the sidecar holds for these segments (by hash)

pendingSteps(work)   single → [single]; segmented → parts without a cached summary, else [reduce]
summaryStepRequest   the messages of one step (system: scaffold, language, link rule, channel rule; user: the text,
                     the segment, or the parts); `summary.request` hooks see every step with { step, language, entities, channels, segment? }
finishSummary        unwrap a code fence · headings → scaffold · links → vocabulary (alias → [[Name|alias]], unknown → text,
                     channel → text) · channel bullets out of the entities section · coverage line for a segmented page

one-shot (ensureSourceSummaries → render → produceSummary):   parts in turn, each written to the part cache, then the merge
leased   (SummarySource.lease):                               one WorkTask per pending step; parts to any worker; merge once all are in
```

`dueSummaryDocuments` takes `minChars`: the SQL leaves out rows whose `chars` is under it, and a row from before the
column (`chars IS NULL`) is settled by `bytes` where that can (a character is 1–4 bytes) or by reading the text once,
after which the column is filled in (`documentChars`, a `SKIP LOCKED` update that yields to an apply in flight). The
sources index marks a document under the threshold `` `short` `` instead of showing it as still unsummarized.

## 3. Config, schema, CLI

```jsonc
"extraction": {
  "summaryMinChars": 1500,      // no summary page under this many characters of indexed text; 0 = every document
  "summaryMaxSegments": 12,     // segments one summary reads at most; past it, sampled evenly and the page says so
  "summaryAfterExtraction": true // false: summarize documents still queued for extraction (their pages link only what the graph has)
}
```

All three are accepted by `PUT /api/config`. `summaryAfterExtraction` (2026‑11‑08) is for a library whose extraction
would take far longer than its summaries: its summaries go first, and since a summary is cached by the document's
content, extraction landing later does not redo one. Schema **v15** adds `documents.chars` (the indexed text's length), written by
every apply; rows from before it are filled in lazily by the Summarize stage's scan.

```
knode-os wiki prune-summaries [--dry-run] [--min-chars n]
```

Lists (`--dry-run`) or archives the summary pages whose document is under the threshold (the configured one, or
`--min-chars`), then rewrites `wiki/sources/index.md`. Reversible: `wiki/.archive/sources/*.md` holds the pages,
the sidecars hold the summaries, and a lower threshold restores both on the next pass or `wiki generate`.

For the finance workspace: run `knode-os wiki prune-summaries --dry-run` first to see the count (about 7,000 of
13,606 pages at the default 1,500), then without the flag. Nothing about the other pages changes until their
documents change; a re-summary of all of them would cost one call per document plus `summaryMaxSegments + 1` per
long one.

## 4. Where the changes go

| File | Change |
| --- | --- |
| `src/wiki/summary.ts` (new) | language detection and scaffolds, the link vocabulary from `entity_mentions`, channel names, the plan (`planSummary`), steps and their prompts (`summaryStepRequest`), the answer's finishing (`finishSummary`), the one-shot runner (`produceSummary`), the threshold helpers (`shortByRow`, `documentChars`, `isShortDocument`) |
| `src/wiki/pages.ts` | `source_summary.plan` returns null under the threshold; `render` goes through `produceSummary` and writes the language-specific `description` and `coverage`; `dueSummaryDocuments(minChars)`; the sources index's `short` badge; `pruneShortSummaries` |
| `src/work/summarize.ts` | leases per step; parts to the part cache and the document back in line; the merge to the summary cache; `totals.parts` and a `label` per lease in the status |
| `src/fs/sidecar.ts` | `views/source-summary.parts.json` (`readSourceSummaryParts`, `writeSourceSummaryPart`); `language` and `coverage` in `views/source-summary.md` |
| `src/config.ts`, `src/server/app.ts` | `summaryMinChars`, `summaryMaxSegments` and their validation |
| `src/store/migrations.ts`, `src/lineage/writer.ts`, `src/ingest/apply.ts`, `src/types.ts` | `documents.chars` |
| `src/plugins/types.ts`, `docs/plugins.md` | `summary.request` context: `step`, `language`, `entities`, `channels`, `segment?` |
| `src/cli.ts`, `README.md` | `wiki prune-summaries` |
| `tests/summaries.test.ts` | the threshold, the language, the links, the coverage, leasing a long document, the sweep; (§6) the specifics rule and the figures list in the single, part and merge prompts, the claims section after extraction without a summary call, its bound and order, a page without claims, a lost cache restored from the page |
| `src/wiki/pages.ts` (§6) | `summaryClaims`, `renderSummaryClaims`, `summaryBody` (cache or the page's own body), `source_summary@3` with claims as deps, `RegenerateOptions.cachedOnly`, summary pages re-rendered by a pass without a model, `refreshSummaryClaims`; a region rendered `null` is removed |
| `src/wiki/summary.ts`, `src/ingest/background.ts` (§6) | `SPECIFICS` with numbered provisions, `figuresRule`, the `figures` and `claims` headings, `maxTokens`; the document pass refreshes the pages of the documents it extracted |

## 5. Known limits

1. Only four scaffolds (zh, ja, ko, en). Latin-script text of any other language gets the English headings; a
   `summary.request` hook can rewrite them.
2. A part failure counts as one of the document's three attempts, like any bad answer. A document whose model
   fails one part three times gets no page until its content changes — the parts it has are kept for then.
3. The vocabulary is what the graph holds *when the summary is planned*. A merge made after the page is written
   leaves the page's links at the old spelling until the document changes; entity pages redirect, so the links
   still resolve where a stub exists.
4. Entity stub pages are still written only by `wiki generate` (`ensureEntityStubs`, 30 at a time), so a link to a
   graph name may still have no page behind it. The link is now at least a name the graph has; writing stubs for
   every linked entity is a separate change. Since 2026‑10‑25 such a link opens the entity panel, and `wiki lint`
   counts it apart from broken links (06 §7).
5. Existing pages keep their English scaffold and free-form links until their documents change. Re-summarizing
   them is a model-call budget decision, not taken here.
6. (§6) The claims section is indexed with the page, so a document's claims are found through its summary as well
   as through the claims channel; on these packs it doubles a page's bytes (law-cn: 3.5 times the model's text). A
   claim new to a document reaches its page through the document pass that extracted it (`refreshSummaryClaims`);
   claims written by any other path wait until a listed claim changes or the page is next regenerated.

## 6. Specifics: the claims on the page, and a figures list (2026‑11‑11)

A benchmark had agents answer questions with grep over the sources or with only the wiki: the wiki-only agent scored
0.27–0.54 against grep's 0.64–0.91, and 0.59 against 0.98 on single-fact questions. A summary is a third of its
document and what it drops is the particular: the number, the date, the name.

### What the summaries kept

`~/knode-eval/bench/specifics.ts` (model-free) takes each summary page's document from its chunks, extracts its
specifics (dates, years, percentages, amounts, numbers with what follows them, article numbers such as 第六十三条,
capitalised and quoted names, in English and Chinese; numbers compared after normalising Chinese numerals, separators
and "percent") and reports the share on the page: the model-written region and the generated regions apart. On the
pilot's pages (gpt-6.1-sol, the prompt before `SPECIFICS`):

| pack (pages) | figures and dates | by kind | all specifics | gold facts with a figure, all on the page | the document's claims with a figure, likewise |
| --- | --- | --- | --- | --- | --- |
| law-cn (42) | 0.130 | article numbers 0.021 (24/1,167), numbers 0.445, percent 0.607, amounts 0.563, dates 1/7 | 0.135 | 0.795 | 0.275 |
| research-ai (98) | 0.284 | dates 0.214, years 0.063, numbers 0.354, percent 0.606; names 0.435 | 0.389 | 0.650 | 0.610 |
| medicine-us (97) | 0.519 | dates 0.711, numbers 0.449, percent 0.668; names 0.488 | 0.509 | – | 0.581 |
| public-musique (8) | 0.656 | numbers 0.543; names 0.733 | 0.684 | – | 0.857 |

The word limit binds. The model's text was 1.8–2.5 KB a page however many specifics the document had, and the share
kept fell as they grew: a paper kept 54% in the third of documents with the fewest specifics and 32% in the third
with the most; a drug label 72% and 41%; a law chapter 19% and 11%. And no rule asked for an article's number.

### Decisions

| # | Decision | Why |
| --- | --- | --- |
| D9 The document's claims on its page | Below the model's text (region `body`) the page has a region `claims` (`## Claims in this document` / `## 文中论断` / …): the document's claims, up to 30 and 6 KB, those with a figure and a date first, then a figure, then a date, the rest last, listed in the document's order; each with its date (`event_at`, else the validity period), tagged with its kind when it is a view or a forecast, with its status when it is not a fact, `_(superseded)_` when superseded. Past the bound a line says how many there are and that `knode_claims` returns the rest. No section when the document has no claim, and a section goes when its claims do | Extraction already wrote the figures and dates as claims, with no further model call. A claim is the document's when the document's own scopes (its apply, its tier-1 extraction) are evidence for it, or when it came from one of its chunks; `claims.document_id` is empty for tier-1 claims, both lookups are indexed. In these packs a document has 13–24 claims (25 at most): with figures first, 20 held nearly all a page gains, and 30 is all of them; 30 and 6 KB bound a long document's hundreds |
| D10 Current without a model | The listed claims are the page's deps and in its `inputsSha` (with their count), so a claim changed or retired dirties the page; `reconcileViews` re-renders a summary page whose model-written body needs no call even in a pass without a model (`RegenerateOptions.cachedOnly`), and writes again a page from an older generator version like a model-free page. After extraction the document pass calls `refreshSummaryClaims` for the documents it extracted, since a page written before its claims (`summaryAfterExtraction: false`) has no dep on them. When the sidecar's cache is gone, the body region already on disk for the same document content (its document dep carries the hash it was written from) is the body, and is written back to the cache | The model-written summary is cached by the document's content; nothing about the claims touches it, and a pilot workspace copied without its sidecars still gets the section |
| D11 The prompt: numbered provisions and a figures list | `SPECIFICS` also asks for each article, section or clause by its number (Article 63, 第六十三条). Every call may add, after the key points, a `## Figures` / `## 数据` / `## 数値` / `## 수치` section of up to 15 lines (8 in a part call, 20 in the merge), one figure each as `value unit — what it measures (date)` or one provision as `number — what it says`, outside the word limit, left out when the key points hold everything; the model's own headings for it (`Key figures`, `关键数据`…) become the scaffold's. `maxTokens` 1,500 / 1,100 / 1,800 (single / part / merge, from 1,200 / 900 / 1,500) | A list line holds a figure in a few words where a prose bullet takes twenty: the compact form is what lets the page carry more figures without the limit growing for the prose. The limit itself stays: the page is indexed as a view, and the claims section now carries much of what a longer summary would |

### After, model-free (D9 and D10 alone)

`specifics.ts --regen` and `wikicov.ts` on private clones of the pilot workspaces, the model-written text unchanged
(74.6 KB on law-cn before and after):

| pack | figures and dates | all specifics | gold facts with a figure | claims with a figure | bytes added | wikicov: covered, with source |
| --- | --- | --- | --- | --- | --- | --- |
| law-cn | 0.130 → 0.355 (article numbers 0.021 → 0.192, numbers 0.445 → 0.821) | 0.135 → 0.359 | 0.795 → 0.991 | 0.275 → 0.972 | +184.9 KB, 4.5 KB a page | 0.847 → 0.916, 0.821 → 0.897 |
| research-ai | 0.284 → 0.413 (dates 0.214 → 0.466) | 0.389 → 0.466 | 0.650 → 0.798 | 0.610 → 1.000 | +197.9 KB, 2.1 KB a page | 0.777 → 0.859, 0.749 → 0.841 |
| medicine-us | 0.519 → 0.657 | 0.509 → 0.621 | – | 0.581 → 1.000 | +213.7 KB, 2.3 KB a page | – |
| public-musique | 0.656 → 0.750 | 0.684 → 0.781 | – | 0.857 → 1.000 | +12.9 KB, 1.7 KB a page | – |
| synthetic-life-zh | no summary pages | | | | 0 | 0.205, 0.187 (unchanged) |

What stays off the page is what extraction did not state as a claim: most of a law chapter's article numbers (a claim
restates an article's rule, rarely its number) and a paper's citation years and table values. That is D11's job.

### Short documents: no claims-only page

A document under the threshold could get a page that is only its claims. On synthetic-life-zh (96 documents, all
under 1,500 characters) that is 64 pages (the 32 others have no claim), 36.5 KB, 0.88 times the size of those
documents; their claim lines hold 0.190 of the pack's gold facts with their document, where the wiki already reaches
0.187 through entity pages, which list the same claims with their sources. On public-musique the pages would be 1.67
times their documents (423 pages, 340 KB), on law-cn's 54 short chapters 1.00 times. A 27,000-document workspace of
the finance library's shape (D1: about 70% under the threshold) would get about 19,000 such pages, 11–16 MB, each
indexed and embedded as a view: the double count D1 removed, back, for facts the entity pages already show with their
source. Not built. Where a short document's facts are missing from the wiki the limit is extraction (a third of
synthetic-life-zh's documents yield no claim; its claims hold 0.209 of the gold facts at all) and which entities get
a page, not the want of a page per document.

### Measuring the prompt (the smoke run)

The prompt cannot be measured without a model. The comparison, on one built workspace per pack (law-cn, research-ai,
medicine-us), one model throughout:

1. Three copy-on-write clones of the workspace (raw documents and sidecars included). In each, archive every summary
   page (`knode-os wiki prune-summaries --min-chars 1000000000`) and delete the summary caches
   (`raw/.sidecar/**/views/source-summary.md` and `source-summary.parts.json`), so every page is written afresh.
2. Write the summaries with three checkouts, one per clone: **A** `ba9836d^` (no specifics rule), **B** `2aa5a3d`
   (`SPECIFICS` alone), **C** this branch (D11). Run the Summarize stage until no summary is due (`knode-os wiki
   generate`, repeated, or the document pass).
3. Measure all three with the same instrument and checkout C, without `--regen`:
   `npx tsx ~/knode-eval/bench/specifics.ts <checkout C> <clone>=<pack> --json <pack>-<A|B|C>.json`, and
   `wikicov.ts` with checkout C.
4. Compare the **model region** column (it leaves the claims section out): figures and dates, by kind (article on
   law-cn, date and year on research-ai, number and percent on medicine-us), gold facts with a figure; the
   model-written KB a page as the cost; and in C the share of pages with a figures section. Write A twice to see the
   variance at one prompt: a difference smaller than that is noise. C's whole-page column against B's says what the
   figures list adds on top of the claims.

The baseline of this section is the pilot's model and A's prompt; it is not the A of the smoke run, which must be
written with the smoke run's model.

